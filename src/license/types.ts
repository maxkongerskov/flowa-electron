// Portable license types. No Electron and no Node imports.
// A future iOS app can share this file.

export type LicenseChannel = 'prod' | 'sbx'

export type AccessMode = 'free' | 'licensed'

/** Server `state` values. Anything else is an unknown enum and must not restrict. */
export type KnownLicenseState = 'active' | 'revoked' | 'refunded' | 'deactivated'

export interface PublicKeyEntry {
  /** `lic-prod-*` or `lic-sbx-*`. */
  kid: string
  /** SPKI PEM, desktop. */
  spkiPem: string
  /** Raw 32-byte Ed25519 key, base64url, no padding. Mobile CryptoKit. */
  rawBase64Url: string
}

export interface LicenseCrypto {
  randomBytes(n: number): Uint8Array
  hmacSha256Hex(keyUtf8: string, messageUtf8: string): string
  verifyEd25519(publicKeySpkiPem: string, message: Uint8Array, signature: Uint8Array): boolean
  /** Raw 32-byte public key. Used to check the published mobile form matches the PEM. */
  ed25519RawPublicKey(publicKeySpkiPem: string): Uint8Array
}

export interface KeyStore {
  /** Missing or unreadable. Never throws. */
  read(): string | null
  write(licenseKey: string): void
  clear(): void
}

export interface LicenseStorage {
  read(name: string): string | null
  writeAtomic(name: string, data: string): void
  remove(name: string): void
}

export interface LicenseTransport {
  post(
    url: string,
    jsonBody: unknown,
    headers: Record<string, string>,
    timeoutMs: number
  ): Promise<{ kind: 'response'; httpStatus: number; raw: string } | { kind: 'error'; reason: 'timeout' | 'network' }>
}

export interface LicenseConfig {
  productId: string
  channel: LicenseChannel
  baseUrl: string
  purchaseUrl: string
  portalUrl: string
  publicKeys: readonly PublicKeyEntry[]
  appVersion: string
  /** License enum: macos, windows, linux, ios, android, or a future value. */
  platform: string
  arch: string
  deviceName?: string
  /** OS device id before fingerprinting. Never sent. */
  rawDeviceId: string
  timeoutMs?: number
}

export interface DeviceListing {
  id: string
  name: string | null
  platform: string | null
  lastSeen: string | null
}

export interface LicenseFields {
  productId: string
  licenseId: string
  deviceId: string | null
  fingerprint: string | null
  /** Raw server value, including unknown enums. */
  state: string
  plan: string | null
  deviceLimit: number | null
  devicesUsed: number | null
  /** Raw platform string. Unknown values are kept for display. */
  platform: string | null
  keyHint: string | null
  issuedAt: string | null
  nextCheckinAfterMs: number | null
  checkinNudgeAfterMs: number | null
  restrictAfterMs: number | null
  /** A positive integer from a verified payload, or null when missing or invalid. */
  freeDailySeconds: number | null
}

export interface LicenseDialogModel {
  kind: 'daily-cap' | 'key-entry' | 'device-limit' | 'reactivate'
  body: string
  primaryLabel: string | null
  secondaryLabel: string | null
  error: string | null
  linkUrl: string | null
}

/**
 * What the UI may show. History, settings, models, export, updates, and key
 * entry are always available. The buy dialog is not a banner and is not shown
 * at startup.
 */
export interface LicenseSnapshot {
  mode: AccessMode
  /**
   * In-place update from a pre-license install on this machine.
   * Unlimited dictation, no cap indicator, no buy dialog, no license-server calls.
   */
  legacyUnlimited: boolean
  /**
   * Signed `device_limit` when the license has one, otherwise the catalog value.
   * A missing signed field is filled from the catalog and a present one is kept.
   */
  deviceLimit: number | null
  /** "10 min tilbage i dag", or null when unlimited. */
  remainingLabel: string | null
  remainingSeconds: number | null
  dialog: LicenseDialogModel | null
  /** Grace text or check-in nudge. Not a banner. */
  quietNote: string | null
  keyHint: string | null
  canEnterKey: true
  canDeactivate: boolean
  historyAvailable: true
  settingsAvailable: true
  modelsAvailable: true
  exportAvailable: true
  updatesAvailable: true
  purchaseUrl: string
  portalUrl: string
}

export interface StartPermission {
  ok: true
  /** False when this take started licensed: it is finished and saved, and not metered. */
  meter: boolean
}

export type StartDecision = StartPermission | { ok: false }
