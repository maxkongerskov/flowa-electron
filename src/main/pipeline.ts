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
import { decodeWav16, encodeWav16 } from '@shared/wav'
import { machineNoun, maxDurationStoppedMessage, modelNotReadyMessage, silenceMessage } from '@shared/status'
import { languageForWhisper, maxDurationSeconds, PrefKey } from '@shared/prefs'
import { Transcriber } from './transcriber'
import { captureTarget, paste, type PasteOutcome, type TargetApp } from './textInserter'
import { LiveSession, type LiveResult } from './liveSession'
import { liveRecoveryDir, pruneRecovery } from './liveRecovery'
import { BAR_CRASH_MESSAGE } from '@shared/barCrash'
import { continueQueue } from '@shared/queue'
import { loadRecent, prefs, saveRecent } from './store'

/**
 * E2E-only: FLOWA_DEBUG=1 FLOWA_DEBUG_FIXTURE=/abs/file.wav makes commit() transcribe that
 * WAV instead of the mic take. Needs both env vars (set via `open --env`), so it can't
 * trigger in normal use.
 */
export function debugFixturePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const f = env.FLOWA_DEBUG_FIXTURE?.trim()
  return env.FLOWA_DEBUG === '1' && f && path.isAbsolute(f) && fs.existsSync(f) ? f : null
}

export interface CaptureBridge {
  start(req: CaptureStartRequest): Promise<{ ok: true } | { ok: false; message: string }>
  stop(generation: number): Promise<CaptureResult>
  cancel(generation: number): void
  /** Beta live transcription: ~1 s blocks while `stream` is on. */
  onBlock?: ((generation: number, samples: Float32Array) => void) | null
}

/** Banner text for a paste outcome (same strings for both paths). */
export function pasteOutcomeMessage(outcome: PasteOutcome, target: TargetApp | null, platform: string = process.platform): string | null {
  if (outcome.kind === 'accessibilityMissing') {
    return platform === 'linux'
      ? 'Transcript is on the clipboard (install xdotool or wtype for auto-paste).'
      : 'Transcript is on the clipboard (Accessibility is off for auto-paste).'
  }
  if (outcome.kind === 'clipboardOnly' && outcome.reason === 'targetNotFrontmost') {
    return `Transcript is on the clipboard — ${target?.name ?? 'the target app'} wasn't in front, so Flowa didn't paste.`
  }
  if (outcome.kind === 'clipboardOnly' && outcome.reason === 'pasteFailed') return 'Transcript is on the clipboard — auto-paste failed. Press ⌘V to paste.'
  if (outcome.kind === 'failed') return "Couldn't copy the transcript to the clipboard."
  return null
}

export function partialMessage(r: LiveResult): string {
  const kept = r.audioPath ? ` The recording is kept at ${r.audioPath}.` : ''
  return r.text
    ? `Part of this long dictation couldn't be transcribed. The text Flowa got is on the clipboard and in Recent.${kept}`
    : `This dictation couldn't be transcribed.${kept}`
}

export class DictationPipeline extends EventEmitter {
  readonly transcriber = new Transcriber()
  recent: Dictation[] = loadRecent()
  lastErrorMessage: string | null = null
  isTranscribing = false

  private sessionTarget: Promise<TargetApp | null> | null = null
  private generation = 0
  private queue: Promise<void> = Promise.resolve()
  /** Beta live transcription session for the current recording (flag on only). */
  private live: { generation: number; session: LiveSession } | null = null

  constructor(private capture: CaptureBridge) {
    super()
    this.transcriber.on('change', () => this.emit('change'))
    capture.onBlock = (generation, samples) => {
      if (this.live && this.live.generation === generation) this.live.session.pushBlock(samples)
    }
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
    this.discardLive()
    const req: CaptureStartRequest = {
      deviceId: microphoneUID,
      maxDurationSeconds: maxDurationSeconds(prefs.get(PrefKey.maxDurationMinutes)),
      generation: this.generation
    }
    if (prefs.get(PrefKey.liveTranscription) === true && !debugFixturePath()) {
      pruneRecovery(liveRecoveryDir(), null)
      // Beta: flag is read once per recording. Off = the request above, unchanged.
      req.stream = true
      this.live = {
        generation: this.generation,
        session: new LiveSession({
          engine: this.transcriber,
          spillPath: path.join(liveRecoveryDir(), `flowa-live-${crypto.randomUUID().slice(0, 8)}.wav`),
          language: languageForWhisper(prefs.get(PrefKey.language))
        })
      }
    }
    const res = await this.capture.start(req)
    if (!res.ok) {
      this.discardLive()
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
    if (this.live && this.live.generation === gen) return this.commitLive()
    const maxMinutes = prefs.get(PrefKey.maxDurationMinutes)
    let result = await this.capture.stop(gen)
    const fixture = debugFixturePath()
    if (fixture) {
      // E2E debug path: replace the mic take with a known WAV (paste path unchanged).
      const wav = decodeWav16(new Uint8Array(fs.readFileSync(fixture)))
      result = { ...result, samples: wav.samples, peak: 1 }
      console.log(`[Flowa][debug] using fixture ${fixture} (${wav.samples.length} samples)`)
    }
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

    // Single-flight queue. A thrown job is logged and does not poison the chain.
    this.queue = continueQueue(
      this.queue,
      () => this.runTranscription(wavPath, target, language, result.stoppedForMaxDuration, maxMinutes),
      (err) => {
        console.error('[Flowa] transcription queue failed', err instanceof Error ? err.message : err)
      }
    )
    await this.queue
  }

  /** The Flow Bar renderer died. Drop the session and say so. The microphone message is a different failure. */
  abortBarCrash(): void {
    // Live beta: keep what was already transcribed (history + clipboard, no paste).
    if (this.live) {
      const { session } = this.live
      this.live = null
      this.queue = continueQueue(this.queue, () => this.deliverLive(session, Promise.resolve(null), false), (err) => console.error('[Flowa] live recovery failed', err))
    }
    this.generation += 1
    this.sessionTarget = null
    this.setError(BAR_CRASH_MESSAGE)
  }

  cancel(): void {
    this.capture.cancel(this.generation)
    this.sessionTarget = null
    this.discardLive()
  }

  private discardLive(): void {
    if (!this.live) return
    this.live.session.discard()
    this.live = null
  }

  /** Beta live path: the stop reply arrives after the last block; only the last segment remains. */
  private async commitLive(): Promise<void> {
    const gen = this.generation
    const live = this.live!
    this.live = null
    // Paste into whatever has focus at stop time (not the app from the start).
    const targetAtStop = captureTarget()
    const result = await this.capture.stop(gen)
    this.sessionTarget = null
    if (appearsSilent(result.peak) || live.session.samples === 0) {
      live.session.discard()
      if (appearsSilent(result.peak)) {
        console.log(`[Flowa] commit skipped — silent take peak=${result.peak} kind=${result.deviceKind}`)
        this.setError(silenceMessage(result.deviceKind))
      }
      return
    }
    const maxMinutes = prefs.get(PrefKey.maxDurationMinutes)
    this.queue = continueQueue(
      this.queue,
      () => this.deliverLive(live.session, targetAtStop, true, result.stoppedForMaxDuration, maxMinutes),
      (err) => console.error('[Flowa] live transcription failed', err instanceof Error ? err.message : err)
    )
    await this.queue
  }

  private async deliverLive(
    session: LiveSession,
    targetPromise: Promise<TargetApp | null>,
    allowPaste: boolean,
    hitMax = false,
    maxMinutes = 0
  ): Promise<void> {
    this.isTranscribing = true
    this.changed()
    try {
      const started = Date.now()
      const r = await session.finish()
      const target = await targetPromise
      console.log(
        `[Flowa][live] finished ${r.audioSeconds.toFixed(0)} s in ${r.segments} segments; last step ${((Date.now() - started) / 1000).toFixed(2)} s; complete=${r.complete}`
      )
      if (r.text) {
        // Partial text is never auto-pasted (it has gaps); it goes to clipboard + Recent.
        const outcome = await paste(r.text, r.complete && allowPaste ? target : null)
        const note = r.complete && allowPaste ? pasteOutcomeMessage(outcome, target) : null
        if (note) this.lastErrorMessage = note
        const entry = newDictation(r.text, r.complete && allowPaste ? target?.name ?? null : null, new Date())
        this.recent = insertingRecent(entry, this.recent, recentLimit)
        saveRecent(this.recent)
      }
      if (!r.complete) {
        pruneRecovery(liveRecoveryDir(), r.audioPath)
        this.lastErrorMessage = partialMessage(r)
      } else if (!r.text) {
        this.lastErrorMessage = "Couldn't understand that audio. Try speaking more clearly or check the microphone."
      } else if (hitMax) {
        this.lastErrorMessage = maxDurationStoppedMessage(maxMinutes)
      }
    } finally {
      this.isTranscribing = false
      this.changed()
    }
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
        if (this.transcriber.status.kind === 'unavailable') {
          this.emit('showMainWindow')
          console.log('[Flowa] transcription skipped — speech model unavailable')
          return
        }
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
      } else if (outcome.kind === 'clipboardOnly' && outcome.reason === 'targetNotFrontmost') {
        this.lastErrorMessage = `Transcript is on the clipboard — ${target?.name ?? 'the target app'} wasn't in front, so Flowa didn't paste.`
      } else if (outcome.kind === 'clipboardOnly' && outcome.reason === 'pasteFailed') {
        this.lastErrorMessage = 'Transcript is on the clipboard — auto-paste failed. Press ⌘V to paste.'
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
