// Regression: dictations whose transcription takes > 5 min failed with
// "Transcription failed: fetch failed" (undici UND_ERR_HEADERS_TIMEOUT, 300 s default),
// because whisper-server only sends headers after decoding the whole clip.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { multipartBody, postMultipart, transcriptionTimeoutMs, wav16Seconds } from '../src/main/localHttp'
import { encodeWav16 } from '@shared/wav'
import { inferenceFields } from '@shared/model'
import { vulkanSkipReason } from '@shared/speech'

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** Mock whisper-server /inference: reads the body, answers after delayMs (headers included). */
function mockServer(delayMs: number, onBody?: (req: http.IncomingMessage, body: Buffer) => void | Promise<void>): Promise<number> {
  const pending = new Set<NodeJS.Timeout>()
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    // Connection: close makes req.destroyed true as soon as the body ends.
    // The response is still writable then; only res.destroyed means the client left.
    res.on('error', () => {})
    req.on('error', () => {})
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      void Promise.resolve(onBody?.(req, Buffer.concat(chunks)))
        .then(() => {
          const timer = setTimeout(() => {
            pending.delete(timer)
            if (res.destroyed || res.writableEnded) return
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ text: ' long dictation ' }))
          }, delayMs)
          pending.add(timer)
        })
        .catch(() => {
          if (!res.writableEnded && !res.destroyed) {
            res.writeHead(500)
            res.end()
          }
        })
    })
  })
  // Node's own server-side defaults must not cut the test short either.
  srv.requestTimeout = 0
  srv.headersTimeout = 0
  srv.on('close', () => {
    for (const t of pending) clearTimeout(t)
    pending.clear()
  })
  servers.push(srv)
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)))
}

describe('long dictation transport', () => {
  it('sends a multipart body whisper-server can parse (fields + exact WAV bytes)', async () => {
    const wav = encodeWav16(new Float32Array(16_000 * 3).map((_, i) => Math.sin(i / 10) * 0.5))
    let seen: FormData | null = null
    const port = await mockServer(0, async (req, body) => {
      seen = await new Response(new Uint8Array(body), { headers: { 'content-type': String(req.headers['content-type']) } }).formData()
    })
    const r = await postMultipart(port, '/inference', inferenceFields('da'), { field: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: wav }, 5000)
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).text).toBe(' long dictation ')
    const f = seen as unknown as FormData
    expect(f).toBeTruthy()
    expect(f.get('language')).toBe('da')
    expect(f.get('response_format')).toBe('json')
    const file = f.get('file') as File
    expect(file.name).toBe('audio.wav')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(wav)
  })

  it('keeps waiting while the engine is silent (no idle/headers timeout of its own)', async () => {
    // Past http.globalAgent's 5s socket timer (Node 22 and Electron 44's Node 24).
    // That timer emits 'timeout' on an idle in-flight socket; this client must keep waiting.
    const port = await mockServer(6_000)
    const started = Date.now()
    const r = await postMultipart(port, '/inference', {}, { field: 'file', filename: 'a.wav', contentType: 'audio/wav', data: new Uint8Array(44) }, 20_000)
    expect(r.status).toBe(200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(6_000)
  }, 20_000)

  it('fails only at the explicit deadline, as a TimeoutError the Vulkan skip logic understands', async () => {
    const port = await mockServer(3000)
    const t0 = Date.now()
    const err = await postMultipart(port, '/inference', {}, { field: 'file', filename: 'a.wav', contentType: 'audio/wav', data: new Uint8Array(44) }, 300).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).toMatchObject({ name: 'TimeoutError' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(vulkanSkipReason('transcribe', err)).toBe('transcription-timeout')
  })

  it('rejects when nothing listens (engine gone)', async () => {
    const port = await mockServer(0)
    const open = servers.splice(0)
    await Promise.all(open.map((s) => new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())))))
    await expect(postMultipart(port, '/inference', {}, { field: 'file', filename: 'a.wav', contentType: 'audio/wav', data: new Uint8Array(44) }, 2000)).rejects.toThrow()
  })

  it('builds a well-formed body from a byte view, without bytes outside that view', () => {
    const view = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)
    expect(view.byteOffset).toBeGreaterThan(0)
    const b = multipartBody({ a: '1' }, { field: 'file', filename: 'x.wav', contentType: 'audio/wav', data: view }, 'BND')
    const text = b.toString('latin1')
    expect(text.startsWith('--BND\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n')).toBe(true)
    expect(text.endsWith('\x01\x02\x03\r\n--BND--\r\n')).toBe(true)
    expect(text.includes('\x09')).toBe(false)
  })
})

describe('transcription deadline scales with clip length', () => {
  it('maps WAV bytes to seconds', () => {
    expect(wav16Seconds(encodeWav16(new Float32Array(16_000 * 300)).byteLength)).toBe(300)
    expect(wav16Seconds(10)).toBe(0)
  })
  it('is never below 10 min and grows 2× the audio', () => {
    expect(transcriptionTimeoutMs(1)).toBeGreaterThanOrEqual(10 * 60 * 1000)
    expect(transcriptionTimeoutMs(5 * 60)).toBe(20 * 60 * 1000)
    expect(transcriptionTimeoutMs(60 * 60)).toBe(130 * 60 * 1000)
    expect(transcriptionTimeoutMs(Number.NaN)).toBe(10 * 60 * 1000)
  })
})

describe('transcriber uses the timeout-free transport', () => {
  const src = readFileSync(resolve(__dirname, '../src/main/transcriber.ts'), 'utf8')
  const inferServer = src.slice(src.indexOf('private async inferServer('), src.indexOf('private async inferCli('))
  it('does not POST /inference through global fetch (undici 300 s headersTimeout)', () => {
    expect(inferServer).toContain('postMultipart(')
    expect(inferServer).not.toMatch(/\bfetch\(/)
  })
  it('uses the scaled deadline for whisper-cli too', () => {
    const inferCli = src.slice(src.indexOf('private async inferCli('), src.indexOf('async transcribe('))
    expect(inferCli).toContain('transcriptionTimeoutMs(')
    expect(inferCli).not.toContain('10 * 60 * 1000')
  })
})

// Real-time proof (≈5 min): FLOWA_SLOW_REPRO=1 npx vitest run tests/long-dictation.test.ts
describe.runIf(process.env.FLOWA_SLOW_REPRO === '1')('5-minute wall (slow)', () => {
  it(
    'old path: fetch + AbortSignal.timeout(10 min) dies at ~300 s; new path survives',
    async () => {
      const port = await mockServer(310_000)
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(44)], { type: 'audio/wav' }), 'audio.wav')
      const [oldPath, newPath] = await Promise.allSettled([
        fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(10 * 60 * 1000) }),
        postMultipart(port, '/inference', {}, { field: 'file', filename: 'a.wav', contentType: 'audio/wav', data: new Uint8Array(44) }, 10 * 60 * 1000)
      ])
      expect(oldPath.status).toBe('rejected')
      expect(String((oldPath as PromiseRejectedResult).reason?.cause?.code)).toBe('UND_ERR_HEADERS_TIMEOUT')
      expect(newPath.status).toBe('fulfilled')
    },
    400_000
  )
})
