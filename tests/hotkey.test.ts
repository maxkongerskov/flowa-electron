// GlobalHotkey wiring: one fn watcher at a time, Swift toggle semantics.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const spawned: { emit: (e: 'down' | 'up') => void; exit: () => void; killed: boolean }[] = []
let readyValue = true

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, globalShortcut: { register: () => true, unregister: () => {} } }))
vi.mock('../src/main/store', () => ({ prefs: { get: (k: string) => (k === 'flowa.shortcut' ? 'fn' : k === 'flowa.microphone' ? 'default' : 'en') } }))
vi.mock('../src/main/textInserter', () => ({ captureTarget: () => Promise.resolve(null) }))
vi.mock('../src/main/macHelper', () => ({
  macHelperAvailable: () => true,
  watchFn: (onEvent: (e: 'down' | 'up') => void, onExit: () => void) => {
    const child = { killed: false, kill() { this.killed = true; onExit() } }
    spawned.push({ emit: onEvent, exit: onExit, get killed() { return child.killed } } as never)
    return { child, ready: new Promise<boolean>((r) => setTimeout(() => r(readyValue), 5)) }
  }
}))

Object.defineProperty(process, 'platform', { value: 'darwin' })
const { GlobalHotkey } = await import('../src/main/hotkey')

function makePipeline() {
  const p = Object.assign(new EventEmitter(), {
    transcriber: { isReady: true, status: { kind: 'ready' }, loadIfNeeded: async () => {} },
    start: vi.fn(async () => true),
    commit: vi.fn(async () => {}),
    cancel: vi.fn(),
    surfaceModelNotReady: vi.fn()
  })
  return p
}

describe('GlobalHotkey (fn)', () => {
  beforeEach(() => {
    spawned.length = 0
    readyValue = true
  })

  it('concurrent start() calls spawn exactly one fn watcher', async () => {
    const panel = { show: vi.fn(), hide: vi.fn() }
    const hk = new GlobalHotkey(makePipeline() as never, panel)
    await Promise.all([hk.start(), hk.start(), hk.restart()])
    expect(spawned.filter((s) => !s.killed).length).toBe(1)
    expect(hk.isAuthorized).toBe(true)
  })

  it('denied watcher leaves the hotkey unauthorized so it can be retried after the grant', async () => {
    readyValue = false
    const hk = new GlobalHotkey(makePipeline() as never, { show: vi.fn(), hide: vi.fn() })
    await hk.start()
    expect(hk.isAuthorized).toBe(false)
    readyValue = true
    await hk.start()
    expect(hk.isAuthorized).toBe(true)
  })

  it('fn tap toggles: press starts + shows Flow Bar, next press commits + hides (hold = one press)', async () => {
    const pipeline = makePipeline()
    const panel = { show: vi.fn(), hide: vi.fn() }
    const hk = new GlobalHotkey(pipeline as never, panel)
    await hk.start()
    const w = spawned[0]
    w.emit('down')
    await new Promise((r) => setTimeout(r, 0))
    expect(pipeline.start).toHaveBeenCalledTimes(1)
    expect(hk.session).toBe('recording')
    expect(panel.show).toHaveBeenCalledTimes(1)
    w.emit('down') // still held: ignored (Swift fnDownTime guard)
    expect(pipeline.commit).not.toHaveBeenCalled()
    w.emit('up')
    w.emit('down')
    expect(pipeline.commit).toHaveBeenCalledTimes(1)
    expect(panel.hide).toHaveBeenCalledTimes(1)
    expect(hk.session).toBe('idle')
  })
})
