// Port of Flowa/Dictation/DictationPipeline.swift.
//
//   GlobalHotkey → pipeline.start(target, mic) → capture (Flow Bar renderer)
//   GlobalHotkey → pipeline.commit(language)   → stop → WAV → Transcriber → paste
//
// Transcription is single-flight: a new commit waits for the previous job.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { CaptureResult, CaptureStartRequest } from '@shared/types'
import { insertingRecent, newDictation, recentLimit, type Dictation } from '@shared/recent'
import { appearsSilent } from '@shared/audioMath'
import { encodeWav16 } from '@shared/wav'
import { machineNoun, maxDurationStoppedMessage, modelNotReadyMessage, silenceMessage } from '@shared/status'
import { maxDurationSeconds, PrefKey } from '@shared/prefs'
import { Transcriber } from './transcriber'
import { paste, type TargetApp } from './textInserter'
import { loadRecent, prefs, saveRecent } from './store'

export interface CaptureBridge {
  start(req: CaptureStartRequest): Promise<{ ok: true } | { ok: false; message: string }>
  stop(generation: number): Promise<CaptureResult>
  cancel(generation: number): void
}

export class DictationPipeline extends EventEmitter {
  readonly transcriber = new Transcriber()
  recent: Dictation[] = loadRecent()
  lastErrorMessage: string | null = null
  isTranscribing = false

  private sessionTarget: Promise<TargetApp | null> | null = null
  private generation = 0
  private queue: Promise<void> = Promise.resolve()

  constructor(private capture: CaptureBridge) {
    super()
    this.transcriber.on('change', () => this.emit('change'))
  }

  private changed(): void {
    this.emit('change')
  }

  setError(message: string | null): void {
    this.lastErrorMessage = message
    this.changed()
  }

  clearRecent(): void {
    this.recent = []
    saveRecent(this.recent)
    this.changed()
  }

  dismissError(): void {
    this.setError(null)
  }

  /** Called when the user hits the shortcut but Whisper is not ready yet. */
  surfaceModelNotReady(): void {
    this.setError(modelNotReadyMessage(this.transcriber.status, machineNoun(process.platform)))
  }

  /** In-app reinstall of the speech model without a full permissions reset. */
  reinstallSpeechModel(): void {
    this.lastErrorMessage = null
    this.transcriber.resetForReinstall()
    prefs.set(PrefKey.firstRunComplete, false)
    this.emit('showMainWindow')
    void this.transcriber.loadIfNeeded()
  }

  prewarm(): void {
    void this.transcriber.loadIfNeeded()
  }

  /** Start recording; binds the paste target to this session. */
  async start(target: Promise<TargetApp | null>, microphoneUID: string): Promise<boolean> {
    this.lastErrorMessage = null
    this.sessionTarget = target
    this.generation += 1
    const res = await this.capture.start({
      deviceId: microphoneUID,
      maxDurationSeconds: maxDurationSeconds(prefs.get(PrefKey.maxDurationMinutes)),
      generation: this.generation
    })
    if (!res.ok) {
      this.sessionTarget = null
      this.setError(res.message)
      console.error('[Flowa] pipeline.start FAILED:', res.message)
      return false
    }
    this.changed()
    return true
  }

  /** Stop audio, snapshot the session target, and transcribe (language null = auto-detect). */
  async commit(language: string | null): Promise<void> {
    const gen = this.generation
    const maxMinutes = prefs.get(PrefKey.maxDurationMinutes)
    const result = await this.capture.stop(gen)
    const target = this.sessionTarget
    this.sessionTarget = null

    if (result.samples.length === 0) {
      if (appearsSilent(result.peak)) this.setError(silenceMessage(result.deviceKind))
      return
    }
    // Near-silent take: skip Whisper and surface a clear tip.
    if (appearsSilent(result.peak)) {
      console.log(`[Flowa] commit skipped — silent take peak=${result.peak} kind=${result.deviceKind}`)
      this.setError(silenceMessage(result.deviceKind))
      return
    }

    const wavPath = path.join(os.tmpdir(), `flowa-${crypto.randomUUID().slice(0, 8)}.wav`)
    fs.writeFileSync(wavPath, encodeWav16(result.samples))

    // Single-flight queue.
    this.queue = this.queue.then(() =>
      this.runTranscription(wavPath, target, language, result.stoppedForMaxDuration, maxMinutes)
    )
    await this.queue
  }

  cancel(): void {
    this.capture.cancel(this.generation)
    this.sessionTarget = null
  }

  private async runTranscription(
    wavPath: string,
    targetPromise: Promise<TargetApp | null> | null,
    language: string | null,
    hitMax: boolean,
    maxMinutes: number
  ): Promise<void> {
    this.isTranscribing = true
    this.changed()
    try {
      await this.transcriber.loadIfNeeded()
      const started = Date.now()
      const text = await this.transcriber.transcribe(wavPath, language)
      if (!text) {
        if (this.transcriber.lastDecodeErrorMessage) this.lastErrorMessage = this.transcriber.lastDecodeErrorMessage
        else if (this.transcriber.status.kind === 'error') this.lastErrorMessage = this.transcriber.status.message
        else this.lastErrorMessage = "Couldn't understand that audio. Try speaking more clearly or check the microphone."
        if (this.transcriber.needsSetup) this.emit('showMainWindow')
        console.log('[Flowa] transcription produced no text')
        return
      }
      const elapsed = ((Date.now() - started) / 1000).toFixed(2)
      const target = targetPromise ? await targetPromise : null
      const outcome = await paste(text, target)
      if (outcome.kind === 'accessibilityMissing') {
        if (!this.lastErrorMessage) {
          this.lastErrorMessage =
            process.platform === 'linux'
              ? 'Transcript is on the clipboard (install xdotool or wtype for auto-paste).'
              : 'Transcript is on the clipboard (Accessibility is off for auto-paste).'
        }
      } else if (outcome.kind === 'failed') {
        this.lastErrorMessage = "Couldn't copy the transcript to the clipboard."
      }
      console.log(`[Flowa] ✓ transcribed in ${elapsed}s → ${target?.name ?? '<clipboard only>'} outcome=${outcome.kind}`)

      const entry = newDictation(text, target?.name ?? null, new Date())
      this.recent = insertingRecent(entry, this.recent, recentLimit)
      saveRecent(this.recent)
      if (hitMax) this.lastErrorMessage = maxDurationStoppedMessage(maxMinutes)
    } finally {
      fs.rmSync(wavPath, { force: true })
      this.isTranscribing = false
      this.changed()
    }
  }
}
