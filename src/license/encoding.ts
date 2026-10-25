// base64url (RFC 4648 §5) without padding, server_time, request_id.
// Pure TypeScript so desktop and a future mobile port share the bytes.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = i + 1 < bytes.length ? (bytes[i + 1] ?? 0) : 0
    const b2 = i + 2 < bytes.length ? (bytes[i + 2] ?? 0) : 0
    const n = (b0 << 16) | (b1 << 8) | b2
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += ALPHABET[n & 63]
  }
  return out
}

export function isBase64Url(value: string): boolean {
  return value.length > 0 && !value.includes('=') && /^[A-Za-z0-9_-]+$/.test(value)
}

/** Returns null when the text is not unpadded base64url, including a bad length. */
export function decodeBase64Url(value: string): Uint8Array | null {
  if (!isBase64Url(value)) return null
  const remainder = value.length % 4
  if (remainder === 1) return null
  const pad = remainder === 0 ? 0 : 4 - remainder
  let outLen = (value.length * 3) / 4
  if (pad) outLen = ((value.length + pad) * 3) / 4 - pad
  const out = new Uint8Array(outLen)
  let o = 0
  for (let i = 0; i < value.length; i += 4) {
    const c0 = ALPHABET.indexOf(value[i] ?? '')
    const c1 = ALPHABET.indexOf(value[i + 1] ?? '')
    const c2 = i + 2 < value.length ? ALPHABET.indexOf(value[i + 2] ?? '') : 0
    const c3 = i + 3 < value.length ? ALPHABET.indexOf(value[i + 3] ?? '') : 0
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    if (o < out.length) out[o++] = (n >> 16) & 255
    if (i + 2 < value.length && o < out.length) out[o++] = (n >> 8) & 255
    if (i + 3 < value.length && o < out.length) out[o++] = n & 255
  }
  return out
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function utf8Text(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** `YYYY-MM-DDTHH:MM:SSZ`. Fractional seconds and numeric offsets are rejected. */
const SERVER_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/

export function parseServerTime(value: string): number | null {
  const m = SERVER_TIME.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  const second = Number(m[6])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(ms)
  if (
    back.getUTCFullYear() !== year ||
    back.getUTCMonth() !== month - 1 ||
    back.getUTCDate() !== day ||
    back.getUTCHours() !== hour ||
    back.getUTCMinutes() !== minute ||
    back.getUTCSeconds() !== second
  ) {
    return null
  }
  const roundTrip = back.toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (roundTrip !== value) return null
  return ms
}

export function formatServerTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 128 random bits, base64url, 22 characters, no padding. */
export function newRequestId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16)
  if (bytes.length !== 16) throw new Error('request_id requires 16 bytes')
  const id = encodeBase64Url(bytes)
  if (id.length !== 22) throw new Error('request_id must be 22 characters')
  return id
}

export const PRODUCT_ID_PATTERN = /^[a-z0-9-]+$/

export function isProductId(value: string): boolean {
  return PRODUCT_ID_PATTERN.test(value)
}
