// POST to the resident whisper-server on 127.0.0.1 without Node's fetch.
//
// Why not fetch: in Electron's main process, global fetch is Node's undici.
// Undici's Client defaults headersTimeout and bodyTimeout to 300_000 ms
// (Electron 44's Node 24 binary: `headersTimeout != null ? headersTimeout : 3e5`).
// whisper.cpp v1.9.5 POST /inference runs whisper_full before httplib writes
// the status line, so a transcription longer than 5 min fails with
// "fetch failed" (UND_ERR_HEADERS_TIMEOUT). AbortSignal.timeout(10 min) does
// not raise those deadlines. node:http has no headers timeout. A fresh Agent
// (agent: false) also skips http.globalAgent, which on Node 22 and on
// Electron's Node 24 sets a 5s socket timer and emits 'timeout' on an idle
// in-flight socket. The socket idle timer is cleared below. The only deadline
// is timeoutMs.
import http from 'node:http'
import crypto from 'node:crypto'

export interface MultipartFile {
  field: string
  filename: string
  contentType: string
  data: Uint8Array
}

export interface LocalHttpResponse {
  status: number
  body: string
}

/** Build a multipart/form-data body (fields first, then the file). */
export function multipartBody(fields: Record<string, string>, file: MultipartFile, boundary: string): Buffer {
  const parts: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'))
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8'
    )
  )
  parts.push(Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength))
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(parts)
}

function timeoutError(ms: number): Error {
  const e = new Error(`speech engine did not answer within ${Math.round(ms / 1000)} s`)
  e.name = 'TimeoutError' // same name AbortSignal.timeout() uses; vulkanSkipReason() relies on it
  return e
}

/** POST multipart to http://127.0.0.1:port/path. Rejects only on socket error or after timeoutMs. */
export function postMultipart(
  port: number,
  urlPath: string,
  fields: Record<string, string>,
  file: MultipartFile,
  timeoutMs: number
): Promise<LocalHttpResponse> {
  const boundary = `----flowa${crypto.randomBytes(12).toString('hex')}`
  const body = multipartBody(fields, file, boundary)
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        // Fresh Agent: do not inherit http.globalAgent's 5s socket timeout.
        agent: false,
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.byteLength }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })))
        res.on('error', (err) => done(() => reject(err)))
        res.on('aborted', () => done(() => reject(new Error('speech engine closed the connection'))))
      }
    )
    req.on('socket', (socket) => {
      // Whisper is silent until decode finishes. 0 disables an idle timer.
      socket.setTimeout(0)
    })
    timer = setTimeout(() => {
      done(() => reject(timeoutError(timeoutMs)))
      req.destroy()
    }, timeoutMs)
    req.on('error', (err) => done(() => reject(err)))
    req.end(body)
  })
}

const minTranscriptionTimeoutMs = 10 * 60 * 1000

/**
 * Deadline for one transcription: at least 10 min, and never less than
 * 10 min + 2× the clip length, so a 30-min dictation on a slow CPU
 * (real-time factor ~1–1.5) is not cut off.
 */
export function transcriptionTimeoutMs(audioSeconds: number): number {
  const s = Number.isFinite(audioSeconds) && audioSeconds > 0 ? audioSeconds : 0
  return minTranscriptionTimeoutMs + Math.ceil(s * 2 * 1000)
}

/** Seconds of audio in a 16 kHz mono 16-bit WAV produced by encodeWav16(). */
export function wav16Seconds(byteLength: number, sampleRate = 16_000): number {
  return Math.max(0, byteLength - 44) / (sampleRate * 2)
}
