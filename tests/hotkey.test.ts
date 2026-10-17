// GlobalHotkey wiring: one fn watcher at a time, Swift toggle semantics.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({
  shortcut: 'fn',
  readyValue: true,
  registered: [] as string[],
  unregistered: [] as string[],
  callback: null as null | (() => void)
}))
const spawned: { emit: (e: 'down' | 'up') => void; exit: () => void; killed: boolean }[] = []
const modifiers: { emit: (line: string) => void; killed: boolean }[] = []

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  globalShortcut: {
    register: (acc: string, cb: () => void) => {
      h.registered.push(acc)
      h.callback = cb
      return true
    },
    unregister: (acc: string) => { h.unregistered.push(acc) }
  }
}))
vi.mock('../src/main/store', () => ({ prefs: { get: (k: string) => (k === 'flowa.shortcut' ? h.shortcut : k === 'flowa.microphone' ? 'default' : 'en') } }))
vi.mock('../src/main/textInserter', () => ({ captureTarget: () => Promise.resolve(null) }))
vi.mock('../src/main/macHelper', () => ({
  macHelperAvailable: () => true,
  watchFn: (onEvent: (e: 'down' | 'up') => void, onExit: () => void) => {
    const child = { killed: false, kill() { this.killed = true; onExit() } }
    spawned.push({ emit: onEvent, exit: onExit, get killed() { return child.killed } } as never)
    return { child, ready: new Promise<boolean>((r) => setTimeout(() => r(h.readyValue), 5)) }
  }
}))
vi.mock('../src/main/modifierHook', () => ({
  watchModifier: (onLine: (line: string) => void, onExit: () => void) => {
    const handle = {
      killed: false,
      kill() { this.killed = true; onExit() },
      ready: Promise.resolve(true)
    }
    modifiers.push({ emit: onLine, get killed() { return handle.killed } })
    return handle
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
    modifiers.length = 0
    h.shortcut = 'fn'
    h.readyValue = true
    h.registered = []
    h.unregistered = []
    h.callback = null
  })

  it('concurrent start() calls spawn exactly one fn watcher', async () => {
    const panel = { show: vi.fn(), hide: vi.fn() }
    const hk = new GlobalHotkey(makePipeline() as never, panel)
    await Promise.all([hk.start(), hk.start(), hk.restart()])
    expect(spawned.filter((s) => !s.killed).length).toBe(1)
    expect(hk.isAuthorized).toBe(true)
  })

  it('denied watcher leaves the hotkey unauthorized so it can be retried after the grant', async () => {
    h.readyValue = false
    const hk = new GlobalHotkey(makePipeline() as never, { show: vi.fn(), hide: vi.fn() })
    await hk.start()
    expect(hk.isAuthorized).toBe(false)
    h.readyValue = true
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

  it('registers a single key with globalShortcut and ignores key-repeat', async () => {
    h.shortcut = 'F8'
    const pipeline = makePipeline()
    const hk = new GlobalHotkey(pipeline as never, { show: vi.fn(), hide: vi.fn() })
    await hk.start()
    expect(h.registered).toEqual(['F8'])
    expect(hk.usesFn).toBe(false)
    expect(spawned.length).toBe(0)
    const realNow = Date.now
    let clock = 5_000_000
    Date.now = () => clock
    try {
      h.callback?.()
      h.callback?.()
      await new Promise((r) => setTimeout(r, 0))
      expect(pipeline.start).toHaveBeenCalledTimes(1)
      expect(hk.session).toBe('recording')
      clock += 200
      h.callback?.()
      expect(pipeline.commit).toHaveBeenCalledTimes(1)
    } finally {
      Date.now = realNow
    }
  })

  it('restarts onto a new accelerator without leaving the old one registered', async () => {
    h.shortcut = 'F8'
    const hk = new GlobalHotkey(makePipeline() as never, { show: vi.fn(), hide: vi.fn() })
    await hk.start()
    h.shortcut = 'F9'
    await hk.restart()
    expect(h.unregistered).toContain('F8')
    expect(h.registered).toContain('F9')
    expect(hk.accelerator).toBe('F9')
    expect(hk.isAuthorized).toBe(true)
  })

  it('toggles Right Alt from the modifier hook only when it is tapped alone', async () => {
    h.shortcut = 'RightAlt'
    const pipeline = makePipeline()
    const hk = new GlobalHotkey(pipeline as never, { show: vi.fn(), hide: vi.fn() })
    await hk.start()
    expect(modifiers.length).toBe(1)
    expect(h.registered).toEqual([])
    const w = modifiers[0]
    w.emit('mod-down RightAlt')
    w.emit('mod-up RightAlt')
    await new Promise((r) => setTimeout(r, 0))
    expect(pipeline.start).toHaveBeenCalledTimes(1)
    w.emit('mod-down RightAlt')
    w.emit('key')
    w.emit('mod-up RightAlt')
    expect(pipeline.commit).not.toHaveBeenCalled()
    expect(hk.session).toBe('recording')
  })
})
