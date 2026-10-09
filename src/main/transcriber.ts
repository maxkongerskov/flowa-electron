// Port of Flowa/Dictation/Transcriber.swift + Flowa/Support/SpeechModelStore.swift.
//
// Swift: WhisperKit(model: openai_whisper-large-v3-v20240930_turbo, bundled CoreML,
//        prewarm/load, download:false) kept resident in memory.
// Here : whisper.cpp `whisper-server` (pinned tag, see shared/model.ts) kept resident
//        on 127.0.0.1 with ggml-large-v3-turbo.bin (same checkpoint, float16).
//        `whisper-cli` is used one-shot if the server binary is missing.
//
// Status machine is the same as Swift (idle → preparing(progress) → ready ⇄
// transcribing, or error) plus `downloading` for the first-run model fetch,
// because Electron installers don't ship the 1.6 GB weights by default.

import { app, net } from 'electron'
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import type { TranscriberStatus } from '@shared/types'
import { cleanTranscript, cliArgs, ggmlModel, inferenceFields, serverArgs, swiftModelVariant } from '@shared/model'
import { expectedPrepareSeconds, friendlyLoadError, isReady, machineNoun, needsSetup } from '@shared/status'
import { encodeWav16 } from '@shared/wav'
import { paths } from './paths'
import { run } from './proc'

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name)
const noun = machineNoun(process.platform)

/** Port of SpeechModelStore.looksComplete: present and plausibly full-size. */
export function looksComplete(file: string): boolean {
  try {
    const st = fs.statSync(file)
    return st.isFile() && st.size >= ggmlModel.approxBytes * 0.98
  } catch {
    return false
  }
}

export function modelCandidates(): string[] {
  return [
    process.env.FLOWA_WHISPER_MODEL?.trim() || '',
    // Bundled with the app (like the Swift bundle's Models/ folder).
    path.join(paths.bundledModels, ggmlModel.fileName),
    // Downloaded on first run.
    path.join(paths.downloadedModels, ggmlModel.fileName)
  ].filter(Boolean)
}

/** Port of SpeechModelStore.resolveLocalModelFolder: bundled first, then caches. */
export function resolveModel(): string | null {
  for (const c of modelCandidates()) if (looksComplete(c)) return c
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
  readonly modelName = swiftModelVariant
  lastDecodeErrorMessage: string | null = null

  private isLoaded = false
  private loadPromise: Promise<void> | null = null
  private prepareTimer: NodeJS.Timeout | null = null
  private server: ChildProcess | null = null
  private port = 0
  private serverLog: string[] = []
  private verifyOnNextLoad = false
  private modelPath: string | null = null
  private mode: 'server' | 'cli' | null = null

  get isReady(): boolean {
    return isReady(this.status, this.isLoaded)
  }

  get needsSetup(): boolean {
    return needsSetup(this.status, this.isLoaded)
  }

  get engineInfo(): { modelFile: string | null; binary: string | null; detail: string } {
    const bin = resolveBinary('whisper-server') ?? resolveBinary('whisper-cli')
    const model = this.modelPath ?? resolveModel()
    return {
      modelFile: model,
      binary: bin,
      detail: `whisper.cpp · ${ggmlModel.fileName} (= ${swiftModelVariant})`
    }
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
    this.stopPrepareProgress()
    this.killServer()
    this.isLoaded = false
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
    const started = Date.now()
    try {
      const serverBin = resolveBinary('whisper-server')
      const cliBin = resolveBinary('whisper-cli')
      if (!serverBin && !cliBin) {
        throw new Error(
          app.isPackaged
            ? 'Speech engine is missing from this app. Reinstall Flowa from the original package.'
            : 'Speech engine is missing (whisper.cpp not built). Run `npm run setup:whisper`.'
        )
      }

      let model = resolveModel()
      if (model && this.verifyOnNextLoad && model.startsWith(paths.downloadedModels)) {
        // Self-repair: re-check the downloaded weights. A corrupt file is removed and re-fetched.
        this.startPrepareProgress()
        const sum = await sha1File(model)
        this.stopPrepareProgress()
        if (sum !== ggmlModel.sha1) {
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
        await this.startServer(serverBin, model)
        this.mode = 'server'
        // Prewarm (Swift: WhisperKitConfig(prewarm: true)): one tiny inference
        // so the first real dictation doesn't pay for GPU/Metal warm-up.
        await this.inferServer(encodeWav16(new Float32Array(16_000)), 'en')
      } else {
        this.mode = 'cli'
      }
      this.stopPrepareProgress()
      this.isLoaded = true
      this.setStatus({ kind: 'ready' })
      console.log(`[Flowa] Whisper ready in ${Math.round((Date.now() - started) / 1000)}s (${this.mode}) from ${model}`)
    } catch (e) {
      this.stopPrepareProgress()
      this.killServer()
      this.isLoaded = false
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[Flowa] Whisper FAILED:', msg, this.serverLog.slice(-5).join(' | '))
      this.setStatus({ kind: 'error', message: friendlyLoadError(msg, noun) })
    }
  }

  private async downloadModel(): Promise<string> {
    const dest = path.join(paths.downloadedModels, ggmlModel.fileName)
    const partial = `${dest}.partial`
    fs.mkdirSync(paths.downloadedModels, { recursive: true })
    let have = 0
    try {
      have = fs.statSync(partial).size
    } catch {
      have = 0
    }
    const headers: Record<string, string> = have > 0 ? { Range: `bytes=${have}-` } : {}
    const res = await net.fetch(ggmlModel.url, { headers })
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
    if (res.status !== 206) have = 0
    const len = Number(res.headers.get('content-length') || 0)
    const total = len > 0 ? have + len : ggmlModel.approxBytes
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
    if (sum !== ggmlModel.sha1) {
      fs.rmSync(partial, { force: true })
      throw new Error(`download failed: checksum mismatch (${sum})`)
    }
    fs.renameSync(partial, dest)
    return dest
  }

  private async startServer(bin: string, model: string): Promise<void> {
    this.port = await freePort()
    this.serverLog = []
    const child = spawn(bin, serverArgs(model, this.port, threads()), {
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
    const bin = resolveBinary('whisper-cli')
    if (!bin || !this.modelPath) throw new Error('Speech engine isn\'t ready yet.')
    const outBase = path.join(os.tmpdir(), `flowa-whisper-${process.pid}-${Date.now()}`)
    const r = await run(bin, cliArgs(this.modelPath, wavFile, outBase, language, threads()), 10 * 60 * 1000)
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
      this.lastDecodeErrorMessage = this.status.kind === 'error' ? this.status.message : "Speech engine isn't ready yet."
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
