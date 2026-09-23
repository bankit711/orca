import type { WebContents } from 'electron'
import type { BrowserNetworkEntry, BrowserNetworkLogResult } from '../../shared/runtime-types'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeRawProcess } from './agent-browser-bridge-raw-process'
import {
  NETWORK_LOG_ENTRY_LIMIT,
  finishNetworkRequest,
  recordNetworkResponseReceived,
  type NetworkLogRecordTarget
} from './cdp-network-log-recorder'

type PopupNetworkCapture = NetworkLogRecordTarget & {
  webContents: WebContents
  lease: ElectronDebuggerLease | null
  messageListener: ((_event: unknown, method: string, params: unknown) => void) | null
  detachListener: (() => void) | null
  logTruncated: boolean
}

// Why a bridge-owned collector instead of a popup daemon session: the opener's
// daemon only sees its own proxy target, and a second proxy+daemon per popup
// cannot attach before the popup's first navigation. A shared debugger lease on
// the popup WebContents attaches synchronously in the creation hook, records the
// same verbatim-URL entry shape as every other network log, and merges into the
// opener's existing network result without touching the wire contract.
export abstract class AgentBrowserBridgePopupCapture extends AgentBrowserBridgeRawProcess {
  protected readonly popupNetworkCaptures = new Map<string, Map<number, PopupNetworkCapture>>()

  onPopupOpened(browserPageId: string, popup: WebContents): void {
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    let popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      popups = new Map()
      this.popupNetworkCaptures.set(sessionName, popups)
    }
    // Why: the custom createWindow path notifies from prepareContent and again
    // from policy attach — one attachment per popup WebContents, never two.
    if (popups.has(popup.id)) {
      return
    }
    const capture: PopupNetworkCapture = {
      webContents: popup,
      lease: null,
      messageListener: null,
      detachListener: null,
      networkLog: [],
      networkRequestMap: new Map(),
      logTruncated: false
    }
    popups.set(popup.id, capture)
    if (this.sessions.get(sessionName)?.activeCapture) {
      this.attachPopupCapture(sessionName, popup.id, capture)
    }
  }

  onPopupClosed(popupWebContentsId: number): void {
    for (const [sessionName, popups] of this.popupNetworkCaptures) {
      const capture = popups.get(popupWebContentsId)
      if (!capture) {
        continue
      }
      this.detachPopupCapture(capture)
      popups.delete(popupWebContentsId)
      if (popups.size === 0) {
        this.popupNetworkCaptures.delete(sessionName)
      }
      return
    }
  }

  protected attachPopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const [webContentsId, capture] of popups) {
      // Why: a fresh capture starts empty like the opener's own log reset, and a
      // popup that died while idle must not hold its WebContents past capture start.
      capture.networkLog.length = 0
      capture.networkRequestMap.clear()
      capture.logTruncated = false
      if (capture.webContents.isDestroyed()) {
        this.detachPopupCapture(capture)
        popups.delete(webContentsId)
        continue
      }
      this.attachPopupCapture(sessionName, webContentsId, capture)
    }
    if (popups.size === 0) {
      this.popupNetworkCaptures.delete(sessionName)
    }
  }

  protected detachPopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const capture of popups.values()) {
      this.detachPopupCapture(capture)
      capture.networkLog.length = 0
      capture.networkRequestMap.clear()
      capture.logTruncated = false
    }
  }

  protected releasePopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const capture of popups.values()) {
      this.detachPopupCapture(capture)
    }
    this.popupNetworkCaptures.delete(sessionName)
  }

  protected mergePopupNetworkEntries(
    sessionName: string,
    result: BrowserNetworkLogResult
  ): BrowserNetworkLogResult {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return result
    }
    // Why: an attach can fail while DevTools owns the popup debugger — retry on
    // read so the popup still joins the capture once the debugger is free.
    if (this.sessions.get(sessionName)?.activeCapture) {
      for (const [webContentsId, capture] of popups) {
        if (!capture.lease && !capture.webContents.isDestroyed()) {
          this.attachPopupCapture(sessionName, webContentsId, capture)
        }
      }
    }
    const popupEntries: BrowserNetworkEntry[] = []
    let popupTruncated = false
    for (const capture of popups.values()) {
      popupEntries.push(...capture.networkLog)
      popupTruncated = popupTruncated || capture.logTruncated
    }
    // Why: byte-identical passthrough when no popup exists — the merge must not
    // reshape a daemon result nobody asked to extend.
    if (popupEntries.length === 0) {
      return result
    }
    return {
      entries: [...(Array.isArray(result.entries) ? result.entries : []), ...popupEntries],
      truncated: result.truncated || popupTruncated
    }
  }

  private attachPopupCapture(
    sessionName: string,
    webContentsId: number,
    capture: PopupNetworkCapture
  ): void {
    if (capture.lease || capture.webContents.isDestroyed()) {
      return
    }
    try {
      capture.lease = acquireElectronDebugger(capture.webContents)
    } catch {
      capture.lease = null
      return
    }
    const listener = (_event: unknown, method: string, params: unknown): void => {
      if (method === 'Network.responseReceived') {
        recordNetworkResponseReceived(capture, params)
        if (capture.networkLog.length >= NETWORK_LOG_ENTRY_LIMIT) {
          capture.logTruncated = true
        }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        finishNetworkRequest(capture, method, params)
      }
    }
    capture.messageListener = listener
    try {
      capture.webContents.debugger.on('message', listener)
    } catch {
      this.detachPopupCapture(capture)
      return
    }
    const onDetach = (): void => {
      // Why: keep entries and registration — DevTools taking the debugger is a
      // pause, not a close; the next read reattaches and keeps collecting.
      this.detachPopupCapture(capture)
    }
    capture.detachListener = onDetach
    try {
      capture.webContents.debugger.on('detach', onDetach)
    } catch {
      this.detachPopupCapture(capture)
      return
    }
    // Why: enable after subscribing so no response event can slip between the two.
    void capture.webContents.debugger.sendCommand('Network.enable', {}).catch(() => {
      const popups = this.popupNetworkCaptures.get(sessionName)
      if (popups?.get(webContentsId) === capture) {
        this.detachPopupCapture(capture)
      }
    })
  }

  private detachPopupCapture(capture: PopupNetworkCapture): void {
    try {
      if (capture.messageListener && !capture.webContents.isDestroyed()) {
        capture.webContents.debugger.removeListener('message', capture.messageListener)
      }
    } catch {
      // Best-effort release: the popup may already be gone.
    }
    try {
      if (capture.detachListener && !capture.webContents.isDestroyed()) {
        capture.webContents.debugger.removeListener('detach', capture.detachListener)
      }
    } catch {
      // Best-effort release: the popup may already be gone.
    }
    capture.messageListener = null
    capture.detachListener = null
    const lease = capture.lease
    capture.lease = null
    try {
      lease?.release()
    } catch {
      // Best-effort release: DevTools may have taken debugger ownership.
    }
  }
}
