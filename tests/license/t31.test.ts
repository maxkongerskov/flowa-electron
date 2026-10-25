import { describe, expect, it } from 'vitest'
import vectors from './fixtures/t31-vectors.json'
import { deviceFingerprint } from '../../src/license/fingerprint'
import { nodeLicenseCrypto } from '../../src/license/nodeCrypto'
import { verifyEnvelope } from '../../src/license/envelope'
import { interpretPayload } from '../../src/license/protocol'
import { encodeBase64Url } from '../../src/license/encoding'
import { PLACEHOLDER_KEYS } from '../../src/license/placeholderKeys'
import type { LicenseChannel, PublicKeyEntry } from '../../src/license/types'

interface EnvelopeVector {
  name: string
  expect: string
  request_id?: string
  app_product_id?: string
  body?: string
  envelope?: { payload: string; sig: string; kid: string }
}

const rows = vectors.envelopes as EnvelopeVector[]
const crypto = nodeLicenseCrypto()
const testKey: PublicKeyEntry = {
  kid: vectors.public_key.kid,
  spkiPem: vectors.public_key.spki_pem,
  rawBase64Url: vectors.public_key.raw_b64url
}

function rawOf(row: EnvelopeVector): string {
  if (typeof row.body === 'string') return row.body
  return JSON.stringify(row.envelope)
}

describe('T31 client test vectors', () => {
  it('uses the published test-only key and does not trust it in the app build', () => {
    expect(vectors.WARNING).toMatch(/TEST-ONLY/)
    expect(testKey.kid).toBe('lic-sbx-test-only-1')
    expect(PLACEHOLDER_KEYS.some((entry) => entry.kid === testKey.kid || entry.spkiPem === testKey.spkiPem)).toBe(false)
    expect(encodeBase64Url(crypto.ed25519RawPublicKey(testKey.spkiPem))).toBe(testKey.rawBase64Url)
  })

  it('matches the fingerprint vectors, including case and product separation', () => {
    for (const row of vectors.fingerprint_vectors) {
      expect(deviceFingerprint(crypto, row.product_id, row.raw_id)).toBe(row.fingerprint)
    }
  })

  it('accepts valid envelopes and rejects invalid ones', () => {
    const flowaFingerprint = vectors.fingerprint_vectors[0]?.fingerprint ?? ''
    for (const row of rows) {
      if (row.expect === 'captive' || row.expect === 'network_error') {
        const verified = verifyEnvelope(rawOf(row), crypto, [testKey], 'sbx')
        expect(verified.ok, row.name).toBe(false)
        if (!verified.ok) expect(verified.reason).toBe('malformed')
        continue
      }
      if (row.expect === 'kid_prefix (sandbox build) / unknown_kid (production build)') {
        const sandbox = verifyEnvelope(rawOf(row), crypto, [testKey], 'sbx')
        const production = verifyEnvelope(rawOf(row), crypto, [testKey], 'prod')
        expect(sandbox.ok, row.name).toBe(false)
        expect(production.ok, row.name).toBe(false)
        if (!sandbox.ok) expect(sandbox.reason).toBe('wrong_channel')
        if (!production.ok) expect(production.reason).toBe('unknown_kid')
        continue
      }
      const channel: LicenseChannel = 'sbx'
      const verified = verifyEnvelope(rawOf(row), crypto, [testKey], channel)
      if (row.expect === 'bad_signature') {
        expect(verified.ok, row.name).toBe(false)
        if (!verified.ok) expect(verified.reason).toBe('bad_signature')
        continue
      }
      if (row.expect === 'unknown_kid') {
        expect(verified.ok, row.name).toBe(false)
        if (!verified.ok) expect(verified.reason).toBe('unknown_kid')
        continue
      }
      expect(verified.ok, `${row.name} signature`).toBe(true)
      if (!verified.ok) continue
      expect(verified.kid.startsWith('lic-sbx-')).toBe(true)
      expect(row.envelope?.payload.includes('=')).toBe(false)
      expect(row.envelope?.sig.includes('=')).toBe(false)
      if (row.expect === 'replay') {
        const interpreted = interpretPayload(
          verified.payload,
          {
            context: 'activate',
            productId: 'flowa',
            requestId: row.request_id ?? '',
            fingerprint: flowaFingerprint,
            boundLicenseId: null,
            boundDeviceId: null
          },
          verified.serverTimeMs
        )
        expect(interpreted.kind, row.name).toBe('rejected')
        continue
      }
      if (row.expect === 'product_mismatch') {
        const interpreted = interpretPayload(
          verified.payload,
          {
            context: 'activate',
            productId: row.app_product_id ?? 'flowa',
            requestId: row.request_id ?? null,
            fingerprint: flowaFingerprint,
            boundLicenseId: null,
            boundDeviceId: null
          },
          verified.serverTimeMs
        )
        expect(interpreted.kind, row.name).toBe('rejected')
        continue
      }
      expect(row.expect, row.name).toBe('valid')
      expect(verified.payload.request_id).toBe(row.request_id)
      expect(String(verified.payload.request_id)).toHaveLength(22)
      if (row.name === 'refunded_checkin') {
        const license = verified.payload.license as { state?: string; restrict_after?: string }
        expect(license.state).toBe('refunded')
        expect(license.restrict_after).toBe('2026-11-09T10:00:00Z')
        continue
      }
      const interpreted = interpretPayload(
        verified.payload,
        {
          context: 'activate',
          productId: 'flowa',
          requestId: row.request_id ?? null,
          fingerprint: flowaFingerprint,
          boundLicenseId: null,
          boundDeviceId: null
        },
        verified.serverTimeMs
      )
      expect(interpreted.kind, row.name).not.toBe('rejected')
      if (row.name === 'ok_activate' && interpreted.kind === 'adopt') {
        expect(interpreted.fields.fingerprint).toBe(flowaFingerprint)
        expect(interpreted.fields.state).toBe('active')
        expect(interpreted.fields.licenseId).toBe('lic_TESTVECTOR00000000000')
      }
      if (row.name === 'signed_error') expect(interpreted.kind).toBe('invalid_key')
      if (row.name === 'unknown_extra_field') expect(interpreted.kind).toBe('no_change')
    }
  })
})
