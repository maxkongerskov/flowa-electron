// Ed25519 envelope: verify the raw payload bytes first, parse JSON after.
// Pure: the crypto implementation is injected.

import { decodeBase64Url, isBase64Url, parseServerTime, utf8Text } from './encoding'
import type { LicenseChannel, LicenseCrypto, PublicKeyEntry } from './types'

export interface EnvelopeParts {
  payload: string
  sig: string
  kid: string
}

export type EnvelopeFailure = 'malformed' | 'bad_signature' | 'unknown_kid' | 'wrong_channel' | 'bad_payload' | 'bad_time'

export type VerifiedEnvelope =
  | { ok: true; kid: string; serverTimeMs: number; payload: Record<string, unknown>; payloadBytes: Uint8Array }
  | { ok: false; reason: EnvelopeFailure }

export function parseEnvelope(raw: string): EnvelopeParts | null {
  if (!raw || raw.trim() === '') return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  if (typeof o.payload !== 'string' || typeof o.sig !== 'string' || typeof o.kid !== 'string') return null
  if (!isBase64Url(o.payload) || !isBase64Url(o.sig)) return null
  if (!o.kid) return null
  return { payload: o.payload, sig: o.sig, kid: o.kid }
}

export function expectedKidPrefix(channel: LicenseChannel): 'lic-prod-' | 'lic-sbx-' {
  return channel === 'prod' ? 'lic-prod-' : 'lic-sbx-'
}

export function verifyEnvelope(
  raw: string,
  crypto: LicenseCrypto,
  keys: readonly PublicKeyEntry[],
  channel: LicenseChannel
): VerifiedEnvelope {
  const parts = parseEnvelope(raw)
  if (!parts) return { ok: false, reason: 'malformed' }
  const prefix = expectedKidPrefix(channel)
  if (!parts.kid.startsWith('lic-prod-') && !parts.kid.startsWith('lic-sbx-')) return { ok: false, reason: 'unknown_kid' }
  if (!parts.kid.startsWith(prefix)) return { ok: false, reason: 'wrong_channel' }
  const key = keys.find((entry) => entry.kid === parts.kid)
  if (!key) return { ok: false, reason: 'unknown_kid' }
  const payloadBytes = decodeBase64Url(parts.payload)
  const sigBytes = decodeBase64Url(parts.sig)
  if (!payloadBytes || !sigBytes || sigBytes.length === 0) return { ok: false, reason: 'malformed' }
  let verified = false
  try {
    verified = crypto.verifyEd25519(key.spkiPem, payloadBytes, sigBytes)
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, reason: 'bad_signature' }
  let parsed: unknown
  try {
    parsed = JSON.parse(utf8Text(payloadBytes))
  } catch {
    return { ok: false, reason: 'bad_payload' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'bad_payload' }
  const payload = parsed as Record<string, unknown>
  if (typeof payload.server_time !== 'string') return { ok: false, reason: 'bad_time' }
  const serverTimeMs = parseServerTime(payload.server_time)
  if (serverTimeMs == null) return { ok: false, reason: 'bad_time' }
  return { ok: true, kid: parts.kid, serverTimeMs, payload, payloadBytes }
}
