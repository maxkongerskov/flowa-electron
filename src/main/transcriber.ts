// Port of Flowa/Dictation/Transcriber.swift + Flowa/Support/SpeechModelStore.swift.
//
// Swift: WhisperKit(model: openai_whisper-large-v3-v20240930_turbo, bundled CoreML,
//        prewarm/load, download:false) kept resident in memory.
// Here : whisper.cpp `whisper-server` (pinned tag, see shared/model.ts) kept resident
//        on 127.0.0.1 with ggml-large-v3-turbo.bin (same checkpoint, float16).
//        `whisper-cli` is used one-shot if the server binary is missing.
//        GPU: omit `-ng` and launch the Metal / CUDA / Vulkan binary selected in
//        shared/speech.ts. CPU passes `-ng`. If the chosen GPU backend cannot
//        start, we retry on CPU and set `notice` (yellow in-app note, no dialog).
//        Whisper Small uses the same server and the same backends; only the
//        ggml file changes (`ggml-small.bin` instead of `ggml-large-v3-turbo.bin`).
//
// Status machine is the same as Swift (idle → preparing(progress) → ready ⇄
// transcribing, or error) plus `downloading` for the first-run model fetch,
// because Electron installers don't ship the weights by default.

import { app, net } from 'electron'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import type { TranscriberStatus } from '@shared/types'
import { cleanTranscript, cliArgs, ggmlModel, ggmlWeightsFor, inferenceFields, serverArgs, swiftModelVariant, type GgmlWeights } from '@shared/model'
import { PrefKey } from '@shared/prefs'
import {
  gpuFallbackNote, selectBackend, speechModelById, whisperGpuBackends, whisperLogsShowGpuFailure, whisperSmallId,
  type BackendPlan, type EngineNotice, type SpeechModelId
} from '@shared/speech'
import { expectedPrepareSeconds, friendlyLoadError, isReady, machineNoun, needsSetup } from '@shared/status'
import { encodeWav16 } from '@shared/wav'
import { probeGpu } from './gpuProbe'
import { paths } from './paths'
import { prefs } from './store'
import { run } from './proc'
import { readWhisperManifest, resolveWhisperBin } from './speechFiles'

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)
const noun = machineNoun(process.platform)

/** Port of SpeechModelStore.looksComplete: present and plausibly full-size. */
export function looksComplete(file: string, weights: GgmlWeights = ggmlModel): boolean {
  try {
    const st = fs.statSync(file)
    return st.isFile() && st.size >= weights.approxBytes * 0.98
  } catch {
    return false
  }
}

export function modelCandidates(weights: GgmlWeights = ggmlModel): string[] {
  const override = process.env.FLOWA_WHISPER_MODEL?.trim() || ''
  // The override is a path to one file. It applies only when that file is the
  // model currently selected, so a Turbo path cannot satisfy Whisper Small.
  const overrideOk = override && path.basename(override) === weights.fileName ? override : ''
  return [
    overrideOk,
    // Bundled with the app (like the Swift bundle's Models/ folder).
    path.join(paths.bundledModels, weights.fileName),
    // Downloaded on first run.
    path.join(paths.downloadedModels, weights.fileName)
  ].filter(Boolean)
}

/** Port of SpeechModelStore.resolveLocalModelFolder: bundled first, then caches. */
export function resolveModel(weights: GgmlWeights = ggmlModel): string | null {
  for (const c of modelCandidates(weights)) if (looksComplete(c, weights)) return c
  return null
}

export function resolveBinary(name: 'whisper-server' | 'whisper-cli'): string | null {
  const env = name === 'whisper-server' ? process.env.FLOWA_WHISPER_SERVER_BIN : process.env.FLOWA_WHISPER_BIN
  const candidates = [env?.trim() || '', path.join(paths.binDir, exe(name))].filter(Boolean)
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      /* next */
    }
  }
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

const threads = (): number => Math.max(1, Math.min(8, (os.availableParallelism?.() ?? os.cpus().length) - 1))

export class Transcriber extends EventEmitter {
  status: TranscriberStatus = { kind: 'idle' }
  /** Yellow in-app note when a chosen GPU backend cannot run. */
  notice: EngineNotice | null = null
  lastDecodeErrorMessage: string | null = null

  private isLoaded = false
  private loadPromise: Promise<void> | null = null
  private loadGen = 0
  private loadedKey = ''
  private prepareTimer: NodeJS.Timeout | null = null
  private server: ChildProcess | null = null
  private port = 0
  private serverLog: string[] = []
  private verifyOnNextLoad = false
  private modelPath: string | null = null
  private mode: 'server' | 'cli' | null = null
  private activeModelId: SpeechModelId = 'whisper-turbo'
  private runtime: BackendPlan | null = null
  private whisperUseGpu = true

  private weights(): GgmlWeights {
    return ggmlWeightsFor(this.activeModelId)
  }

  get modelName(): string {
    return this.activeModelId === whisperSmallId ? 'openai/whisper-small' : swiftModelVariant
  }

  get isReady(): boolean {
    return isReady(this.status, this.isLoaded)
  }

  get needsSetup(): boolean {
    return needsSetup(this.status, this.isLoaded)
  }

  get engineInfo(): { modelFile: string | null; binary: string | null; detail: string } {
    const label = speechModelById(this.activeModelId).label
    const backend = this.runtime ? ` · ${this.runtime.backend}` : ''
    const weights = this.weights()
    const bin = resolveBinary('whisper-server') ?? resolveBinary('whisper-cli')
    const model = this.modelPath ?? resolveModel(weights)
    return {
      modelFile: model,
      binary: bin,
      detail: `${label}${backend} · whisper.cpp ${weights.fileName}`
    }
  }

  private configKey(): string {
    return `${prefs.get(PrefKey.speechModel)}|${prefs.get(PrefKey.hardware)}`
  }

  /** Reload when the speech model or hardware preference changes. */
  reloadForPrefs(): void {
    const key = this.configKey()
    if (this.loadedKey === key && (this.isLoaded || this.status.kind === 'unavailable')) return
    this.resetForReinstall()
    // A model/hardware switch should not re-hash the Whisper file.
    this.verifyOnNextLoad = false
    void this.loadIfNeeded()
  }

  /** Fetch the selected whisper.cpp model if it is not already loaded. */
  downloadSelectedModel(): Promise<void> {
    return this.loadIfNeeded()
  }

  private setStatus(s: TranscriberStatus): void {
    this.status = s
    this.emit('change')
  }

  async loadIfNeeded(): Promise<void> {
    if (this.isLoaded && (this.mode === 'cli' || this.server)) {
      if (this.status.kind !== 'ready' && this.status.kind !== 'transcribing') this.setStatus({ kind: 'ready' })
      return
    }
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.performLoad().finally(() => {
      this.loadPromise = null
    })
    return this.loadPromise
  }

  /** Drop the loaded engine so the next load re-prepares (Swift: resetForReinstall). */
  resetForReinstall(): void {
    this.loadGen += 1
    this.stopPrepareProgress()
    this.killServer()
    this.isLoaded = false
    this.loadedKey = ''
    this.notice = null
    this.runtime = null
    this.lastDecodeErrorMessage = null
    this.verifyOnNextLoad = true
    this.setStatus({ kind: 'idle' })
  }

  shutdown(): void {
    this.stopPrepareProgress()
    this.killServer()
  }

  private killServer(): void {
    if (this.server && this.server.exitCode === null) this.server.kill()
    this.server = null
    this.mode = null
  }

  private async performLoad(): Promise<void> {
    this.killServer()
    this.isLoaded = false
    this.notice = null
    const modelId = prefs.get(PrefKey.speechModel)
    const hardware = prefs.get(PrefKey.hardware)
    this.activeModelId = modelId
    const started = Date.now()
    try {
      await this.performLoadWhisper(started)
      this.loadedKey = `${modelId}|${hardware}`
    } catch (e) {
      this.stopPrepareProgress()
      this.killServer()
      this.isLoaded = false
      this.loadedKey = `${modelId}|${hardware}`
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[Flowa] speech engine FAILED:', msg, this.serverLog.slice(-5).join(' | '))
      this.setStatus({ kind: 'error', message: friendlyLoadError(msg, noun) })
    }
  }

  private planForActiveModel(): BackendPlan {
    const modelId = this.activeModelId
    const label = speechModelById(modelId).label
    const builds = readWhisperManifest(paths.binDir, process.platform)
    const gpu = whisperGpuBackends(builds)
    return selectBackend(prefs.get(PrefKey.hardware), process.platform, probeGpu(), gpu, builds, label)
  }

  private async performLoadWhisper(started: number): Promise<void> {
    const plan = this.planForActiveModel()
    this.runtime = plan
    this.whisperUseGpu = plan.whisperUseGpu
    if (plan.fellBack && plan.note) this.notice = { kind: 'gpu-fallback', message: plan.note }
    const serverBin = resolveWhisperBin(paths.binDir, plan.whisperBinary, 'server') ?? resolveBinary('whisper-server')
      const cliBin = resolveWhisperBin(paths.binDir, plan.whisperBinary, 'cli') ?? resolveBinary('whisper-cli')
      if (!serverBin && !cliBin) {
        throw new Error(
          app.isPackaged
            ? 'Speech engine is missing from this app. Reinstall Flowa from the original package.'
            : 'Speech engine is missing (whisper.cpp not built). Run `npm run setup:whisper`.'
        )
      }

      const weights = this.weights()
      let model = resolveModel(weights)
      if (model && this.verifyOnNextLoad && model.startsWith(paths.downloadedModels)) {
        // Self-repair: re-check the downloaded weights. A corrupt file is removed and re-fetched.
        this.startPrepareProgress()
        const sum = await sha1File(model)
        this.stopPrepareProgress()
        if (sum !== weights.sha1) {
          console.warn('[Flowa] model checksum mismatch, re-downloading')
          fs.rmSync(model, { force: true })
          model = null
        }
      }
      this.verifyOnNextLoad = false
      if (!model) model = await this.downloadModel()
      this.modelPath = model

      this.startPrepareProgress()
      if (serverBin) {
        try {
          await this.startServer(serverBin, model, plan.whisperUseGpu)
        } catch (e) {
          if (!plan.whisperUseGpu) throw e
          console.warn('[Flowa] GPU engine failed, retrying on CPU', e)
          this.noteGpuFallback(plan.backend === 'cpu' ? 'gpu' : plan.backend)
          this.killServer()
          this.whisperUseGpu = false
          const cpuBin = resolveWhisperBin(paths.binDir, 'default', 'server') ?? serverBin
          await this.startServer(cpuBin, model, false)
        }
        this.mode = 'server'
        if (plan.whisperUseGpu && this.runtime && this.runtime.backend !== 'cpu' && whisperLogsShowGpuFailure(this.serverLog.join('\n'), this.runtime.backend)) {
          this.noteGpuFallback(this.runtime.backend)
        }
        // Prewarm (Swift: WhisperKitConfig(prewarm: true)): one tiny inference
        // so the first real dictation doesn't pay for GPU/Metal warm-up.
        await this.inferServer(encodeWav16(new Float32Array(16_000)), 'en')
      } else if (cliBin) {
        this.mode = 'cli'
      } else {
        throw new Error(
          app.isPackaged
            ? 'Speech engine is missing from this app. Reinstall Flowa from the original package.'
            : 'Speech engine is missing (whisper.cpp not built). Run `npm run setup:whisper`.'
        )
      }
      this.stopPrepareProgress()
      this.isLoaded = true
      this.setStatus({ kind: 'ready' })
    console.log(`[Flowa] Whisper ready in ${Math.round((Date.now() - started) / 1000)}s (${this.mode}, gpu=${this.whisperUseGpu}) from ${model}`)
  }

  private noteGpuFallback(requested: 'gpu' | 'metal' | 'cuda' | 'vulkan'): void {
    const message = gpuFallbackNote(speechModelById(this.activeModelId).label, requested)
    this.notice = { kind: 'gpu-fallback', message }
    if (this.runtime) {
      this.runtime = { ...this.runtime, backend: 'cpu', whisperUseGpu: false, fellBack: true, note: message }
    }
    this.whisperUseGpu = false
    this.emit('change')
  }

  private async downloadModel(): Promise<string> {
    const weights = this.weights()
    const dest = path.join(paths.downloadedModels, weights.fileName)
    const partial = `${dest}.partial`
    fs.mkdirSync(paths.downloadedModels, { recursive: true })
    let have = 0
    try {
      have = fs.statSync(partial).size
    } catch {
      have = 0
    }
    const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
    const res = await net.fetch(weights.url, { headers })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    if (res.status !== 206) have = 0
    const len = Number(res.headers.get('content-length') || 0)
    const total = len > 0 ? have + len : weights.approxBytes
    const out = fs.createWriteStream(partial, { flags: have > 0 ? 'a' : 'w' })
    let received = have
    let lastEmit = 0
    this.setStatus({ kind: 'downloading', received, total })
    const reader = res.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        const now = Date.now()
        if (now - lastEmit > 250) {
          lastEmit = now
          this.setStatus({ kind: 'downloading', received, total })
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    this.setStatus({ kind: 'preparing', progress: 0 })
    const sum = await sha1File(partial)
    if (sum !== weights.sha1) {
      fs.rmSync(partial, { force: true })
      throw new Error(`download failed: checksum mismatch (${sum})`)
    }
    fs.renameSync(partial, dest)
    return dest
  }

  private async startServer(bin: string, model: string, useGpu: boolean): Promise<void> {
    this.port = await freePort()
    this.serverLog = []
    const child = spawn(bin, serverArgs(model, this.port, threads(), useGpu), {
      windowsHide: true,
      cwd: path.dirname(bin)
    })
    this.server = child
    const log = (c: Buffer): void => {
      for (const line of c.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.serverLog.push(line.trim())
      }
      if (this.serverLog.length > 200) this.serverLog = this.serverLog.slice(-200)
    }
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    child.on('exit', (code) => {
      if (this.server === child) {
        this.server = null
        if (this.isLoaded) {
          console.error('[Flowa] whisper-server exited', code, this.serverLog.slice(-5).join(' | '))
          this.isLoaded = false
          this.setStatus({ kind: 'error', message: friendlyLoadError('engine stopped unexpectedly', noun) })
        }
      }
    })
    const deadline = Date.now() + 10 * 60 * 1000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`speech engine exited (${child.exitCode}): ${this.serverLog.slice(-3).join(' ')}`)
      }
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) })
        if (r.ok) return
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error('speech engine did not start in time')
  }

  private async inferServer(wav: Uint8Array, language: string | null): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav')
    for (const [k, v] of Object.entries(inferenceFields(language))) form.append(k, v)
    const r = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form })
    const body = await r.text()
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`)
    let text = ''
    try {
      const j = JSON.parse(body)
      if (j.error) throw new Error(String(j.error))
      text = String(j.text ?? '')
    } catch (e) {
      if (e instanceof SyntaxError) text = body
      else throw e
    }
    return cleanTranscript(text)
  }

  private async inferCli(wavFile: string, language: string | null): Promise<string> {
    const kind = this.runtime?.whisperBinary ?? 'default'
    const bin = resolveWhisperBin(paths.binDir, this.whisperUseGpu ? kind : 'default', 'cli') ?? resolveBinary('whisper-cli')
    if (!bin || !this.modelPath) throw new Error('Speech engine isn\'t ready yet.')
    const outBase = path.join(os.tmpdir(), `flowa-whisper-${process.pid}-${Date.now()}`)
    const r = await run(bin, cliArgs(this.modelPath, wavFile, outBase, language, threads(), this.whisperUseGpu), 10 * 60 * 1000)
    const txt = `${outBase}.txt`
    let text = ''
    try {
      text = fs.readFileSync(txt, 'utf8')
    } catch {
      text = ''
    } finally {
      fs.rmSync(txt, { force: true })
    }
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-280))
    return cleanTranscript(text)
  }

  /** Returns trimmed text, or null (and sets lastDecodeErrorMessage) on failure / empty. */
  async transcribe(wavFile: string, language: string | null): Promise<string | null> {
    this.lastDecodeErrorMessage = null
    await this.loadIfNeeded()
    if (!this.isLoaded) {
      this.lastDecodeErrorMessage =
        this.status.kind === 'error' || this.status.kind === 'unavailable' ? this.status.message : "Speech engine isn't ready yet."
      return null
    }
    this.setStatus({ kind: 'transcribing' })
    try {
      const text =
        this.mode === 'server'
          ? await this.inferServer(fs.readFileSync(wavFile), language)
          : await this.inferCli(wavFile, language)
      this.setStatus({ kind: 'ready' })
      return text ? text : null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.lastDecodeErrorMessage = `Transcription failed: ${msg}`
      this.setStatus(this.isLoaded ? { kind: 'ready' } : { kind: 'error', message: this.lastDecodeErrorMessage })
      return null
    }
  }

  private startPrepareProgress(): void {
    this.stopPrepareProgress()
    this.setStatus({ kind: 'preparing', progress: 0 })
    const start = Date.now()
    this.prepareTimer = setInterval(() => {
      if (this.status.kind !== 'preparing') return this.stopPrepareProgress()
      const fraction = (Date.now() - start) / 1000 / expectedPrepareSeconds
      this.setStatus({ kind: 'preparing', progress: Math.min(1, Math.max(0, fraction)) })
    }, 200)
  }

  private stopPrepareProgress(): void {
    if (this.prepareTimer) clearInterval(this.prepareTimer)
    this.prepareTimer = null
  }
}
