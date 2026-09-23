import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => {
    const stdinWrites: string[] = []
    return {
      execFileMock: vi.fn(),
      webContentsFromIdMock: vi.fn(),
      existsSyncMock: vi.fn(() => false),
      readFileSyncMock: vi.fn(() => Buffer.from('')),
      stdinWrites
    }
  })

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback,
  type MockWebContents
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const OPENER_ENTRY = {
  url: 'https://opener.example/app',
  method: 'GET',
  status: 200,
  mimeType: 'text/html',
  size: 64,
  timestamp: 1
}

function respondToDaemonCommands(): void {
  execFileMock.mockImplementation(
    (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
      if (args.includes('close')) {
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
      if (args.includes('requests')) {
        cb(
          null,
          JSON.stringify({ success: true, data: { entries: [OPENER_ENTRY], truncated: false } }),
          ''
        )
        return { stdin: { on: vi.fn(), end: vi.fn() } }
      }
      const leaf = args.at(-2)
      const data =
        leaf === 'start' ? { capturing: true } : leaf === 'stop' ? { stopped: true } : { ok: true }
      cb(null, JSON.stringify({ success: true, data }), '')
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    }
  )
}

function emitPopupDebuggerMessage(popup: MockWebContents, method: string, params: unknown): void {
  const call = popup.debugger.on.mock.calls.find(([event]) => event === 'message')
  expect(call).toBeDefined()
  // Why Reflect.apply: the shared mock types listeners as (...args: never[]), so a
  // direct call cannot pass the CDP method and params the listener provably receives.
  Reflect.apply(call![1], null, [{}, method, params])
}

function emitPopupResponse(popup: MockWebContents): void {
  emitPopupDebuggerMessage(popup, 'Network.responseReceived', {
    requestId: 'popup-req-1',
    response: { url: 'https://popup.example/healthz', status: 200, mimeType: 'text/plain' },
    timestamp: 2
  })
  emitPopupDebuggerMessage(popup, 'Network.loadingFinished', {
    requestId: 'popup-req-1',
    encodedDataLength: 12
  })
}

describe('AgentBrowserBridge popup capture', () => {
  let popup: MockWebContents

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    const opener = mockWebContents(100, 'https://opener.example/app', 'Opener')
    popup = mockWebContents(200, 'https://popup.example/healthz', 'Popup')
    // Why: Electron's debugger.sendCommand always returns a promise — the mock
    // must honor that contract or the production .catch chain throws in tests.
    popup.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? opener : id === 200 ? popup : null
    )
    respondToDaemonCommands()
  })

  function bridgeWithOpener(): AgentBrowserBridge {
    const bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    return bridge
  }

  it('reports the opener and popup initial requests exactly once under the opener', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')

    // Why: prepareContent notifies before the popup's first navigation — the
    // bridge attaches while capturing, so the initial request is recorded.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupDebuggerMessage(popup, 'Network.responseReceived', {
      requestId: 'popup-req-1',
      response: {
        url: 'https://popup.example/healthz',
        status: 200,
        mimeType: 'text/plain'
      },
      timestamp: 2
    })
    emitPopupDebuggerMessage(popup, 'Network.loadingFinished', {
      requestId: 'popup-req-1',
      encodedDataLength: 12
    })

    const result = await bridge.networkLog(undefined, undefined, 'tab-1')
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toEqual(OPENER_ENTRY)
    expect(result.entries[1]).toMatchObject({
      url: 'https://popup.example/healthz',
      status: 200,
      mimeType: 'text/plain',
      size: 12
    })
    expect(result.truncated).toBe(false)
  })

  it('attaches popups opened before capture start and detaches on capture stop', async () => {
    const bridge = bridgeWithOpener()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    expect(popup.debugger.on).not.toHaveBeenCalledWith('message', expect.anything())

    await bridge.captureStart(undefined, 'tab-1')
    expect(popup.debugger.on).toHaveBeenCalledWith('message', expect.anything())
    expect(popup.debugger.sendCommand).toHaveBeenCalledWith('Network.enable', {})

    emitPopupResponse(popup)
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).entries).toHaveLength(2)

    await bridge.captureStop(undefined, 'tab-1')
    expect(popup.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything())
    // Why: stopping the capture drops the popup entries with the lease — a later
    // read reports only what the opener's own session still holds.
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).entries).toEqual([OPENER_ENTRY])
  })

  it('releases the popup lease on popup close and opener retirement', async () => {
    const bridge = bridgeWithOpener()
    await bridge.captureStart(undefined, 'tab-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    emitPopupResponse(popup)
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).entries).toHaveLength(2)

    bridge.onPopupClosed(200)
    expect(popup.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything())
    expect((await bridge.networkLog(undefined, undefined, 'tab-1')).entries).toEqual([OPENER_ENTRY])

    // Reopening re-registers, and retiring the opener releases it again.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared mock implements the debugger surface the bridge exercises (on/removeListener/sendCommand/isDestroyed), which is all onPopupOpened touches.
    bridge.onPopupOpened('tab-1', popup as never)
    await bridge.onPageClosed('tab-1')
    expect(popup.debugger.removeListener).toHaveBeenCalledWith('message', expect.anything())
  })
})
