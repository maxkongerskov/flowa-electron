// Port of Flowa/Hotkey/GlobalHotkey.swift — each press toggles:
// first press starts recording, next press commits.
//
// macOS + fn : flowa-helper `watch-fn` (CGEventTap on flagsChanged, listen-only,
//              exactly like Swift). Needs Input Monitoring.
// otherwise  : Electron globalShortcut accelerator (default Ctrl+Shift+Space on
//              Windows/Linux). Press-only events, which is all a toggle needs.

import { globalShortcut } from 'electron'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { FN_SHORTCUT, languageForWhisper, PrefKey } from '@shared/prefs'
import { macHelperAvailable, watchFn } from './macHelper'
import { captureTarget } from './textInserter'
import { prefs } from './store'
import type { DictationPipeline } from './pipeline'

export interface FlowBarPanel {
  show(): void
  hide(): void
}

export function acceleratorLabel(acc: string, platform: string): string {
  if (acc === FN_SHORTCUT) return 'fn'
  const mac = platform === 'darwin'
  return acc
    .split('+')
    .map((k) => {
      if (k === 'CommandOrControl' || k === 'CmdOrCtrl') return mac ? '⌘' : 'Ctrl'
      if (k === 'Command' || k === 'Cmd') return '⌘'
      if (k === 'Control' || k === 'Ctrl') return mac ? '⌃' : 'Ctrl'
      if (k === 'Alt' || k === 'Option') return mac ? '⌥' : 'Alt'
      if (k === 'Shift') return mac ? '⇧' : 'Shift'
      if (k === 'Super' || k === 'Meta') return mac ? '⌘' : 'Win'
      return k
    })
    .join(mac ? '' : '+')
}

export class GlobalHotkey extends EventEmitter {
  isAuthorized = false
  session: 'idle' | 'recording' = 'idle'
  accelerator = ''

  private fnChild: ChildProcess | null = null
  private fnDown = false
  private starting = false
  private commitAfterStart = false

  constructor(
    readonly pipeline: DictationPipeline,
    private panel: FlowBarPanel
  ) {
    super()
  }

  get usesFn(): boolean {
    return this.accelerator === FN_SHORTCUT
  }

  private startPromise: Promise<void> | null = null

  /** Single-flight: launch, focus and permission changes can all call start() at once. */
  start(): Promise<void> {
    if (this.isAuthorized) return Promise.resolve()
    if (!this.startPromise) {
      this.startPromise = this.doStart().finally(() => {
        this.startPromise = null
      })
    }
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    const wanted = prefs.get(PrefKey.shortcut)
    this.accelerator = wanted === FN_SHORTCUT && process.platform !== 'darwin' ? 'Control+Shift+Space' : wanted
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
            this.setAuthorized(false)
          }
        }
      )
      this.fnChild = child
      const ok = await ready
      if (!ok && this.fnChild === child) this.fnChild = null
      if (!ok) console.error('[Flowa] CGEventTap FAILED — Input Monitoring permission missing?')
      else console.log('[Flowa] Fn hotkey ready — tap to start/stop dictation.')
      this.setAuthorized(ok)
    } else {
      let ok = false
      try {
        ok = globalShortcut.register(this.accelerator, () => this.handlePress())
      } catch (e) {
        console.error('[Flowa] invalid accelerator', this.accelerator, e)
      }
      if (ok) console.log(`[Flowa] ${this.accelerator} hotkey ready — press to start/stop dictation.`)
      this.setAuthorized(ok)
    }
  }

  stop(): void {
    this.fnDown = false
    if (this.fnChild) {
      const c = this.fnChild
      this.fnChild = null
      c.kill()
    }
    if (this.accelerator && !this.usesFn) {
      try {
        globalShortcut.unregister(this.accelerator)
      } catch {
        /* ignore */
      }
    }
    this.setAuthorized(false)
  }

  async restart(): Promise<void> {
    if (this.startPromise) await this.startPromise
    this.stop()
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
