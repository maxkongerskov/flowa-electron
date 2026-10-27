// Port of Flowa/Dictation/DictationPipeline.swift.
//
//   GlobalHotkey → pipeline.start(target, mic) → capture (Flow Bar renderer)
//   GlobalHotkey → pipeline.commit(language)   → stop → WAV → Transcriber → paste
//
// Transcription is single-flight: a new commit waits for the previous job.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { CaptureResult, CaptureStartRequest } from '@shared/types'
import { insertingRecent, newDictation, recentLimit, type Dictation } from '@shared/recent'
import { appearsSilent } from '@shared/audioMath'
import { decodeWav16 } from '@shared/wav'
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
  /** Live transcription: ~1 s audio blocks for the current recording. */
  onBlock?: ((generation: number, samples: Float32Array) => void) | null
}

/** Banner text for a paste outcome. */
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
  /** Live transcription session for the current recording. */
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
    // Live transcription is the only dictation path: 1 s blocks stream to a spill
    // WAV and are transcribed in 30–90 s segments in the background.
    pruneRecovery(liveRecoveryDir(), null)
    req.stream = true
    this.live = { generation: this.generation, session: this.newSession() }
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

  /**
   * Stop audio and deliver the live transcript. The language was fixed when the
   * recording started (same pref the hotkey passes here), so the argument is unused.
   */
  async commit(_language?: string | null): Promise<void> {
    const gen = this.generation
    if (!this.live || this.live.generation !== gen) {
      // Nothing recording for this generation (e.g. start failed): just stop audio.
      await this.capture.stop(gen)
      this.sessionTarget = null
      return
    }
    return this.commitLive()
  }

  /** The Flow Bar renderer died. Drop the session and say so. The microphone message is a different failure. */
  abortBarCrash(): void {
    // Keep what was already transcribed (history + clipboard, no paste).
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

  private newSession(): LiveSession {
    return new LiveSession({
      engine: this.transcriber,
      spillPath: path.join(liveRecoveryDir(), `flowa-live-${crypto.randomUUID().slice(0, 8)}.wav`),
      language: languageForWhisper(prefs.get(PrefKey.language))
    })
  }

  private discardLive(): void {
    if (!this.live) return
    this.live.session.discard()
    this.live = null
  }

  /** The stop reply arrives after the last block; only the last segment remains. */
  private async commitLive(): Promise<void> {
    const gen = this.generation
    const live = this.live!
    this.live = null
    // Paste into whatever has focus at stop time (not the app from the start).
    const targetAtStop = captureTarget()
    let result = await this.capture.stop(gen)
    this.sessionTarget = null
    const fixture = debugFixturePath()
    if (fixture) {
      // E2E debug path: replace the mic take with a known WAV (paste path unchanged).
      const wav = decodeWav16(new Uint8Array(fs.readFileSync(fixture)))
      live.session.discard()
      live.session = this.newSession()
      for (let i = 0; i < wav.samples.length; i += 16_000) live.session.pushBlock(wav.samples.subarray(i, i + 16_000))
      result = { ...result, peak: 1 }
      console.log(`[Flowa][debug] using fixture ${fixture} (${wav.samples.length} samples)`)
    }
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
      if (this.transcriber.status.kind === 'unavailable') {
        // Same as before: no model → open the main window, nothing to deliver.
        session.discard()
        this.emit('showMainWindow')
        console.log('[Flowa] transcription skipped — speech model unavailable')
        return
      }
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
      if (!r.text && !r.complete && this.transcriber.needsSetup) this.emit('showMainWindow')
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
}
