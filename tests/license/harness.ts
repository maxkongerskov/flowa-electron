import { generateKeyPairSync } from 'node:crypto'
import { loadBundledProductProfile, uiCopy, type UiCopy } from '../../src/license/brand'
import { LicenseController, type LicenseConfig } from '../../src/license/controller'
import { encodeBase64Url, formatServerTime } from '../../src/license/encoding'
import { verifyEnvelope } from '../../src/license/envelope'
import { deviceFingerprint } from '../../src/license/fingerprint'
import { nodeLicenseCrypto, signEd25519 } from '../../src/license/nodeCrypto'
import type { UpdateWitness } from '../../src/license/legacy'
import type { KeyStore, LicenseCrypto, LicenseStorage, LicenseTransport, PublicKeyEntry } from '../../src/license/types'
import type { ProductProfile } from '../../src/license/brand'

export const PRODUCT = 'flowa'
export const RAW_ID = 'MACHINE-1'
export const UPDATER_ID = '11111111-1111-4111-8111-111111111111'

export class MemStore implements LicenseStorage {
  files = new Map<string, string>()
  read(name: string): string | null {
    return this.files.get(name) ?? null
  }
  writeAtomic(name: string, data: string): void {
    this.files.set(name, data)
  }
  remove(name: string): void {
    this.files.delete(name)
  }
}

export class MemKeys implements KeyStore {
  value: string | null = null
  read(): string | null {
    return this.value
  }
  write(licenseKey: string): void {
    this.value = licenseKey
  }
  clear(): void {
    this.value = null
  }
}

export class Scripted implements LicenseTransport {
  calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = []
  handlers: Array<
    (req: { url: string; body: Record<string, unknown> }) => Promise<
      { kind: 'response'; httpStatus: number; raw: string } | { kind: 'error'; reason: 'timeout' | 'network' }
    >
  > = []

  async post(
    url: string,
    jsonBody: unknown,
    headers: Record<string, string>
  ): Promise<{ kind: 'response'; httpStatus: number; raw: string } | { kind: 'error'; reason: 'timeout' | 'network' }> {
    const body = jsonBody as Record<string, unknown>
    this.calls.push({ url, body, headers })
    const handler = this.handlers.shift()
    if (!handler) return { kind: 'error', reason: 'network' }
    return handler({ url, body })
  }
}

export interface TestKeys {
  privateKeyPem: string
  entry: PublicKeyEntry
}

export function testKeys(kid = 'lic-prod-test'): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spkiPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  return { privateKeyPem, entry: { kid, spkiPem, rawBase64Url: 'dGVzdA' } }
}

export function signEnvelope(privateKeyPem: string, kid: string, payload: Record<string, unknown>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const sig = signEd25519(privateKeyPem, bytes)
  return JSON.stringify({ payload: encodeBase64Url(bytes), sig: encodeBase64Url(sig), kid })
}

export function genuineWitness(version: string): UpdateWitness {
  return {
    updaterIdRaw: `${UPDATER_ID}\n`,
    updateInfoRaw: JSON.stringify({ fileName: `Flowa-${version}-linux-x86_64.AppImage`, sha512: 'abc', isAdminRightsRequired: false })
  }
}

export interface LicenseEnv {
  crypto: LicenseCrypto
  storage: MemStore
  keys: MemKeys
  legacy: MemKeys
  transport: Scripted
  pair: TestKeys
  copy: UiCopy
  profile: ProductProfile
  now: () => number
  setNow: (ms: number) => void
  advance: (ms: number) => void
  setUi: (ready: boolean) => void
  start: (opts?: {
    version?: string
    witness?: UpdateWitness
    rawId?: string
    channel?: 'prod' | 'sbx'
    publicKeys?: PublicKeyEntry[]
    bridgeRaw?: string | null
  }) => LicenseController
  fingerprint: (rawId?: string) => string
  envelope: (payload: Record<string, unknown>, kid?: string, privateKeyPem?: string) => string
  signed: (body: Record<string, unknown>, extra?: Record<string, unknown>) => string
  respond: (status: string, license?: Record<string, unknown> | null, extra?: Record<string, unknown>) => (req: { body: Record<string, unknown> }) => Promise<{ kind: 'response'; httpStatus: number; raw: string }>
  storedLicense: (app: LicenseController) => Record<string, unknown> | null
}

export function makeEnv(rawId = RAW_ID): LicenseEnv {
  const crypto = nodeLicenseCrypto()
  const storage = new MemStore()
  const keys = new MemKeys()
  const legacy = new MemKeys()
  const transport = new Scripted()
  const pair = testKeys()
  const profile = loadBundledProductProfile()
  const copy = uiCopy(profile)
  let now = Date.parse('2026-06-15T10:00:00Z')
  let ui = true
  const fingerprint = (id = rawId): string => deviceFingerprint(crypto, PRODUCT, id)
  const envelope = (payload: Record<string, unknown>, kid = pair.entry.kid, privateKeyPem = pair.privateKeyPem): string =>
    signEnvelope(privateKeyPem, kid, payload)
  const signed = (requestBody: Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
    envelope({
      api_version: 1,
      product_id: PRODUCT,
      request_id: requestBody.request_id,
      server_time: formatServerTime(now),
      status: 'active',
      ...extra
    })
  return {
    crypto,
    storage,
    keys,
    legacy,
    transport,
    pair,
    copy,
    profile,
    now: () => now,
    setNow: (ms) => {
      now = ms
    },
    advance: (ms) => {
      now += ms
    },
    setUi: (ready) => {
      ui = ready
    },
    fingerprint,
    envelope,
    signed,
    respond: (status, license, extra = {}) => async (req) => ({
      kind: 'response' as const,
      httpStatus: 200,
      raw: signed(req.body, {
        status,
        ...(license ? { license } : {}),
        ...extra
      })
    }),
    storedLicense: () => {
      const raw = storage.read('license.json')
      if (!raw) return null
      const verified = verifyEnvelope(raw, crypto, [pair.entry], 'prod')
      return verified.ok ? verified.payload : null
    },
    start(opts = {}) {
      const id = opts.rawId ?? rawId
      const channel = opts.channel ?? 'prod'
      const config: LicenseConfig = {
        productId: PRODUCT,
        channel,
        baseUrl: profile.licenseBaseUrl,
        purchaseUrl: profile.purchaseUrl,
        portalUrl: profile.portalUrl,
        publicKeys: opts.publicKeys ?? [pair.entry],
        appVersion: opts.version ?? '1.2.3',
        platform: 'linux',
        arch: 'x64',
        deviceName: 'test-box',
        rawDeviceId: id,
        copy,
        deviceLimit: profile.deviceLimit,
        runLegacyMigration: true,
        bridgeRaw: opts.bridgeRaw ?? null,
        witness: opts.witness ?? { updateInfoRaw: null, updaterIdRaw: null }
      }
      return new LicenseController(config, crypto, storage, keys, legacy, transport, () => now, () => ui, () => {})
    }
  }
}

export function activeLicense(env: LicenseEnv, rawId = RAW_ID, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: PRODUCT,
    license_id: 'lic_1',
    device_id: 'dev_1',
    fingerprint: env.fingerprint(rawId),
    state: 'active',
    plan: 'lifetime',
    platform: 'linux',
    key_hint: '····ABCD',
    issued_at: '2026-06-01T00:00:00Z',
    next_checkin_after: formatServerTime(env.now() + 14 * 24 * 60 * 60 * 1000),
    ...patch
  }
}
