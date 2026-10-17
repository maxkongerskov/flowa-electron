// Port of Flowa/Hotkey/GlobalHotkey.swift — each press toggles:
// first press starts recording, next press commits. There is no hold-to-talk
// mode; holding the key counts as one press, same as the Swift fn watcher.
//
// fn            : flowa-helper `watch-fn` (CGEventTap, macOS, Input Monitoring).
// modifier alone: flowa-helper `watch-modifiers` (macOS) or the Windows
//                 WH_KEYBOARD_LL script. Toggles only when the key is tapped
//                 by itself, so AltGr and Ctrl+C keep working. Not on Linux.
// otherwise     : Electron globalShortcut, including a single key such as F8.
//                 Key-repeat is ignored so a held key does not immediately stop.

import { globalShortcut } from 'electron'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { languageForWhisper, PrefKey } from '@shared/prefs'
import {
  defaultShortcut, initialModWatch, modifierWatchStep, shortcutKind, shortcutLabel, validateShortcut,
  type ModWatchState, type ShortcutKind
} from '@shared/shortcut'
import { macHelperAvailable, watchFn } from './macHelper'
import { watchModifier, type ModifierWatch } from './modifierHook'
import { captureTarget } from './textInserter'
import { prefs } from './store'
import type { DictationPipeline } from './pipeline'

export function acceleratorLabel(acc: string, platform: string): string {
  return shortcutLabel(acc, platform)
}

export interface FlowBarPanel {
  show(): void
  hide(): void
}

export class GlobalHotkey extends EventEmitter {
  isAuthorized = false
  session: 'idle' | 'recording' = 'idle'
  accelerator = ''
  /** Recorder is open: the hook is detached but we don't report a conflict. */
  suspended = false

  private fnChild: ChildProcess | null = null
  private modWatch: ModifierWatch | null = null
  private modState: ModWatchState = initialModWatch()
  private attached = false
  private fnDown = false
  private starting = false
  private commitAfterStart = false
  private lastAcceleratorAt = 0

  constructor(
    readonly pipeline: DictationPipeline,
    private panel: FlowBarPanel
  ) {
    super()
  }

  get usesFn(): boolean {
    return shortcutKind(this.accelerator) === 'fn'
  }

  get kind(): ShortcutKind {
    return shortcutKind(this.accelerator)
  }

  /** macOS fn or modifier tap — the safety-net retry in index.ts uses this. */
  get needsMacNativeWatch(): boolean {
    return process.platform === 'darwin' && (this.usesFn || this.kind === 'modifier')
  }

  private startPromise: Promise<void> | null = null

  /** Single-flight: launch, focus and permission changes can all call start() at once. */
  start(): Promise<void> {
    if (this.suspended || this.attached) return Promise.resolve()
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null
      })
    }
    return this.startPromise
  }

  /** Drop the hook while the settings recorder is listening. Keeps isAuthorized. */
  suspend(): void {
    if (this.suspended) return
    this.suspended = true
    this.detach()
  }

  resume(): Promise<void> {
    this.suspended = false
    return this.start()
  }

  private async doStart(): Promise<void> {
    if (this.suspended) return
    const parsed = validateShortcut(prefs.get(PrefKey.shortcut), process.platform)
    this.accelerator = parsed.ok ? parsed.shortcut : defaultShortcut(process.platform)
    this.modState = initialModWatch()
    if (this.usesFn) {
      if (!macHelperAvailable()) {
        console.error('[Flowa] fn needs resources/mac/flowa-helper (npm run setup:mac-helper)')
        this.setAuthorized(false)
        return
      }
      const { child, ready } = watchFn(
        (e) => (e === 'down' ? this.handleFnPressed() : (this.fnDown = false)),
        () => {
          if (this.fnChild === child) {
            this.fnChild = null
            this.attached = false
            this.setAuthorized(false)
          }
        }
      )
      this.fnChild = child
      const ok = await ready
      if (this.suspended || this.fnChild !== child) {
        if (this.fnChild === child) {
          this.fnChild = null
          child.kill()
        }
        return
      }
      if (!ok) this.fnChild = null
      if (!ok) console.error('[Flowa] CGEventTap FAILED — Input Monitoring permission missing?')
      else console.log('[Flowa] Fn hotkey ready — tap to start/stop dictation.')
      this.attached = ok
      this.setAuthorized(ok)
    } else if (this.kind === 'modifier') {
      const shortcut = this.accelerator
      const handle = watchModifier(
        (line) => {
          if (this.modWatch !== handle || this.accelerator !== shortcut) return
          const step = modifierWatchStep(this.modState, line, shortcut)
          this.modState = step.state
          if (step.fire) this.handlePress()
        },
        () => {
          if (this.modWatch === handle) {
            this.modWatch = null
            this.attached = false
            this.setAuthorized(false)
          }
        }
      )
      this.modWatch = handle
      const ok = await handle.ready
      if (!ok && this.modWatch === handle) this.modWatch = null
      if (this.accelerator !== shortcut || this.suspended) {
        if (this.modWatch === handle) {
          this.modWatch = null
          handle.kill()
        }
        return
      }
      if (!ok) console.error(`[Flowa] modifier hook FAILED for ${shortcut}`)
      else console.log(`[Flowa] ${shortcut} ready — tap to start/stop dictation.`)
      this.attached = ok
      this.setAuthorized(ok)
    } else {
      let ok = false
      const shortcut = this.accelerator
      try {
        ok = globalShortcut.register(shortcut, () => {
          const now = Date.now()
          // Collapse OS key-repeat so holding F8 does not stop dictation immediately.
          if (now - this.lastAcceleratorAt < 80) return
          this.lastAcceleratorAt = now
          this.handlePress()
        })
      } catch (e) {
        console.error('[Flowa] invalid accelerator', shortcut, e)
      }
      if (this.accelerator !== shortcut || this.suspended) {
        if (ok) {
          try { globalShortcut.unregister(shortcut) } catch { /* ignore */ }
        }
        return
      }
      if (ok) console.log(`[Flowa] ${shortcut} hotkey ready — press to start/stop dictation.`)
      this.attached = ok
      this.setAuthorized(ok)
    }
  }

  /** Unregister without clearing isAuthorized (used while the recorder is open). */
  private detach(): void {
    this.fnDown = false
    this.modState = initialModWatch()
    this.attached = false
    if (this.fnChild) {
      const c = this.fnChild
      this.fnChild = null
      c.kill()
    }
    if (this.modWatch) {
      const w = this.modWatch
      this.modWatch = null
      w.kill()
    }
    if (this.accelerator && !this.usesFn && this.kind !== 'modifier') {
      try {
        globalShortcut.unregister(this.accelerator)
      } catch {
        /* ignore */
      }
    }
  }

  stop(): void {
    this.suspended = false
    this.detach()
    this.setAuthorized(false)
  }

  async restart(): Promise<void> {
    if (this.startPromise) await this.startPromise
    this.suspended = false
    this.detach()
    this.setAuthorized(false)
    await this.start()
  }

  private setAuthorized(v: boolean): void {
    this.isAuthorized = v
    this.emit('change')
  }

  private handleFnPressed(): void {
    if (this.fnDown) return
    this.fnDown = true
    this.handlePress()
  }

  private handlePress(): void {
    if (this.starting) {
      this.commitAfterStart = true
      return
    }
    if (this.session === 'recording') {
      console.log('[Flowa] press → COMMIT')
      this.commitListening()
    } else {
      console.log('[Flowa] press → START recording')
      void this.startListening()
    }
  }

  private async startListening(): Promise<void> {
    if (this.session !== 'idle') return
    // Don't capture audio if Whisper isn't ready — kick install/repair UI instead.
    if (!this.pipeline.transcriber.isReady) {
      console.log(`[Flowa] press ignored — speech model not ready (${this.pipeline.transcriber.status.kind})`)
      this.pipeline.surfaceModelNotReady()
      this.pipeline.emit('showMainWindow')
      void this.pipeline.transcriber.loadIfNeeded()
      return
    }
    this.starting = true
    this.commitAfterStart = false
    const target = captureTarget()
    try {
      const ok = await this.pipeline.start(target, prefs.get(PrefKey.microphone))
      if (ok) {
        this.session = 'recording'
        this.panel.show()
        this.emit('change')
      }
    } finally {
      this.starting = false
    }
    if (this.commitAfterStart && this.session === 'recording') {
      this.commitAfterStart = false
      this.commitListening()
    }
  }

  commitListening(): void {
    if (this.session !== 'recording') return
    this.session = 'idle'
    this.panel.hide()
    this.emit('change')
    void this.pipeline.commit(languageForWhisper(prefs.get(PrefKey.language)))
  }

  cancelListening(): void {
    if (this.session !== 'recording') return
    this.session = 'idle'
    this.fnDown = false
    this.panel.hide()
    this.emit('change')
    this.pipeline.cancel()
  }
}
