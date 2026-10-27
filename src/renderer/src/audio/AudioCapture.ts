// Port of Flowa/Dictation/AudioCapture.swift to Web Audio (runs in the Flow Bar renderer).
//
// Swift: AVAudioEngine input tap (bufferSize 1024, native format) → AVAudioConverter
//        → 16 kHz mono Float32 in memory → RMS level (×6.5, 0.5 smoothing) → peak
//        → optional max-duration freeze → 16-bit PCM WAV on stop.
// Here : getUserMedia(deviceId, no AEC/NS/AGC) → AudioContext(sampleRate 16000)
//        (Chromium resamples) → ScriptProcessor(512) → same level/peak math.
//        The WAV is written by the main process (shared/wav.ts), same header/format.

import { levelForBuffer, resample, smoothLevel } from '@shared/audioMath'
import { classifyMic, inputsForPicker, resolveCaptureUID, type MicDeviceKind } from '@shared/micDeviceKind'
import { targetSampleRate } from '@shared/wav'

export type LevelListener = (level: number) => void

export class AudioCapture {
  level = 0
  isRecording = false
  sessionPeakLevel = 0
  sessionDeviceKind: MicDeviceKind = 'standard'
  stoppedForMaxDuration = false

  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private chunks: Float32Array[] = []
  private captureGeneration = 0
  private activeGeneration = 0
  /** True while start() is waiting on the microphone, before isRecording flips. */
  private opening = false
  private maxTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<LevelListener>()
  /** Beta live transcription: receives ~1 s blocks instead of buffering the take. */
  private streamSink: ((block: Float32Array) => void) | null = null
  private pendingBlock: Float32Array[] = []
  private pendingLen = 0

  onLevel(l: LevelListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  private emitLevel(): void {
    for (const l of this.listeners) l(this.level)
  }

  /** Start capture. deviceId 'default' / '' = system input. */
  async start(deviceId: string, maxDurationSeconds: number | null, streamSink?: (block: Float32Array) => void): Promise<void> {
    if (this.isRecording || this.opening) throw new Error('Already recording')
    this.opening = true
    this.chunks = []
    this.streamSink = streamSink ?? null
    this.pendingBlock = []
    this.pendingLen = 0
    this.sessionPeakLevel = 0
    this.sessionDeviceKind = 'standard'
    this.stoppedForMaxDuration = false
    this.captureGeneration += 1
    this.activeGeneration = this.captureGeneration
    const generation = this.activeGeneration
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null

    const live = inputsForPicker(await navigator.mediaDevices.enumerateDevices())
    if (generation !== this.activeGeneration) throw new Error('Recording was cancelled.')
    const resolved = resolveCaptureUID(deviceId, live)
    const chosen = live.find((d) => d.uid === resolved)

    const audio: MediaTrackConstraints = {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
    if (resolved !== 'default') audio.deviceId = { exact: resolved }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
    } catch (e) {
      if (generation === this.activeGeneration) this.opening = false
      const name = (e as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Microphone access is off for Flowa. Grant it in Settings and try again.')
      }
      if (chosen && (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')) {
        throw new Error(`Couldn't switch to ${chosen.displayName}. Pick another microphone or System default.`)
      }
      throw new Error("Couldn't start recording. Check your microphone and try again.")
    }
    if (generation !== this.activeGeneration) {
      stream.getTracks().forEach((t) => t.stop())
      throw new Error('Recording was cancelled.')
    }
    this.stream = stream

    const track = this.stream.getAudioTracks()[0]
    this.sessionDeviceKind = classifyMic(track?.label ?? chosen?.name ?? '', '', 0, resolved)

    // Prefer a 16 kHz context (Chromium resamples the mic with a proper filter);
    // fall back to the native rate + our resampler.
    let ctx: AudioContext
    try {
      ctx = new AudioContext({ sampleRate: targetSampleRate, latencyHint: 'interactive' })
    } catch {
      ctx = new AudioContext({ latencyHint: 'interactive' })
    }
    this.ctx = ctx
    const rate = ctx.sampleRate
    if (rate === 0) {
      this.opening = false
      this.endCaptureHardware()
      throw new Error('Input returned an invalid format. Check that the system default input device is reachable.')
    }
    this.source = ctx.createMediaStreamSource(this.stream)
    const bufferSize = rate > 24000 ? 1024 : 512
    this.node = ctx.createScriptProcessor(bufferSize, 1, 1)
    this.node.onaudioprocess = (ev) => {
      if (generation !== this.activeGeneration || !this.isRecording || this.stoppedForMaxDuration) return
      const input = ev.inputBuffer.getChannelData(0)
      const samples = resample(new Float32Array(input), rate, targetSampleRate)
      if (this.streamSink) {
        this.pendingBlock.push(samples)
        this.pendingLen += samples.length
        if (this.pendingLen >= targetSampleRate) this.flushBlock()
      } else {
        this.chunks.push(samples)
      }
      const newLevel = levelForBuffer(samples)
      this.level = smoothLevel(this.level, newLevel)
      if (newLevel > this.sessionPeakLevel) this.sessionPeakLevel = newLevel
      this.emitLevel()
    }
    this.source.connect(this.node)
    // ScriptProcessor only runs when connected to the destination; output stays silent.
    this.node.connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    if (generation !== this.activeGeneration) {
      this.endCaptureHardware()
      throw new Error('Recording was cancelled.')
    }
    this.isRecording = true
    this.opening = false

    if (maxDurationSeconds && maxDurationSeconds > 0) {
      this.maxTimer = setTimeout(() => this.forceStopForMaxDuration(), maxDurationSeconds * 1000)
    }
  }

  /** Stop and return 16 kHz mono samples (empty if nothing captured, or when streaming). */
  stop(): Float32Array {
    if (!this.isRecording) return new Float32Array(0)
    this.endCaptureHardware()
    this.activeGeneration = 0
    if (this.streamSink) {
      // last partial block goes out before the stop reply (same IPC pipe, in order)
      this.flushBlock()
      this.streamSink = null
      return new Float32Array(0)
    }
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const out = new Float32Array(total)
    let off = 0
    for (const c of this.chunks) {
      out.set(c, off)
      off += c.length
    }
    this.chunks = []
    return out
  }

  cancel(): void {
    // Also abort a start() that has not set isRecording yet, so a timed-out
    // capture cannot leave the microphone open or stuck on "Already recording".
    this.activeGeneration = 0
    this.opening = false
    this.endCaptureHardware()
    this.chunks = []
    this.streamSink = null
    this.pendingBlock = []
    this.pendingLen = 0
  }

  private flushBlock(): void {
    if (!this.streamSink || this.pendingLen === 0) return
    const out = new Float32Array(this.pendingLen)
    let off = 0
    for (const c of this.pendingBlock) {
      out.set(c, off)
      off += c.length
    }
    this.pendingBlock = []
    this.pendingLen = 0
    this.streamSink(out)
  }

  private endCaptureHardware(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
    try {
      this.node?.disconnect()
      this.source?.disconnect()
    } catch {
      /* ignore */
    }
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    this.node = null
    this.source = null
    this.stream = null
    this.ctx = null
    this.isRecording = false
    this.level = 0
    this.emitLevel()
  }

  /** Freeze capture at the configured max; caller still commits via shortcut/✓. */
  private forceStopForMaxDuration(): void {
    if (!this.isRecording || this.stoppedForMaxDuration) return
    this.stoppedForMaxDuration = true
    this.stream?.getTracks().forEach((t) => t.stop())
    this.level = 0
    this.emitLevel()
    console.log('[Flowa][audio] hit user max duration — frozen, waiting for commit')
  }
}
