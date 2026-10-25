// License state machine. No Electron imports.
// Network, files, and the clock are injected so desktop and tests share it.

import { accessMode, effectiveQuota, isRestrictingState, pastRestrictAfter } from './access'
import { verifyEnvelope } from './envelope'
import { deviceFingerprint } from './fingerprint'
import { evaluateLegacy, shouldRunLegacyMigration, type UpdateWitness } from './legacy'
import { LICENSE_FILE, LICENSE_PREV_FILE, LICENSE_TIMEOUT_MS, META_FILE, USAGE_FILE } from './locations'
import {
  activateRequest,
  checkinNotBefore,
  checkinRequest,
  deactivateRequest,
  interpretPayload,
  licenseHeaders,
  licenseUrl,
  networkBackoffMs,
  normalizeLicenseKey,
  statusRequest,
  type Interpreted
} from './protocol'
import { newRequestId } from './encoding'
import type { UiCopy } from './brand'
import {
  applyRecorded,
  observeClock,
  parseUsage,
  remainingSeconds,
  serializeUsage,
  type UsageState
} from './usage'
import type {
  KeyStore,
  LicenseChannel,
  LicenseCrypto,
  LicenseDialogModel,
  LicenseFields,
  LicenseSnapshot,
  LicenseStorage,
  LicenseTransport,
  PublicKeyEntry,
  StartDecision
} from './types'

export interface LicenseConfig {
  productId: string
  channel: LicenseChannel
  baseUrl: string
  purchaseUrl: string
  portalUrl: string
  publicKeys: readonly PublicKeyEntry[]
  appVersion: string
  platform: string
  arch: string
  deviceName?: string
  rawDeviceId: string
  timeoutMs?: number
  copy: UiCopy
  /** Catalog device_limit. Fills a signed license only when that field is absent. */
  deviceLimit: number
  runLegacyMigration: boolean
  /** Plaintext `legacy-bridge.json` from 1.2.3, or null. */
  bridgeRaw: string | null
  witness: UpdateWitness
}

interface Meta {
  trustedServerTimeMs: number
  nextNetworkAttemptAtMs: number
  rateLimitedUntilMs: number
  checkinFailures: number
  fallbackCheckinAtMs: number | null
  pendingSilent: boolean
}

interface Adopted {
  raw: string
  fields: LicenseFields
  serverTimeMs: number
}

type DialogState =
  | null
  | { kind: 'daily-cap' }
  | { kind: 'key-entry'; error: string | null }
  | { kind: 'device-limit' }
  | { kind: 'reactivate'; error: string | null }

const EMPTY_META: Meta = {
  trustedServerTimeMs: 0,
  nextNetworkAttemptAtMs: 0,
  rateLimitedUntilMs: 0,
  checkinFailures: 0,
  fallbackCheckinAtMs: null,
  pendingSilent: false
}

export class LicenseController {
  networkCalls = 0
  private readonly fingerprint: string
  private usage: UsageState
  private meta: Meta = { ...EMPTY_META }
  private adopted: Adopted | null = null
  private legacyUnlimited = false
  private dialog: DialogState = null
  private fingerprintMismatch = false
  private recoveringDevice = false
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly config: LicenseConfig,
    private readonly crypto: LicenseCrypto,
    private readonly storage: LicenseStorage,
    private readonly keys: KeyStore,
    private readonly legacyStore: KeyStore,
    private readonly transport: LicenseTransport,
    private readonly now: () => number,
    private readonly uiReady: () => boolean,
    private readonly log: (message: string) => void = () => {}
  ) {
    this.fingerprint = deviceFingerprint(crypto, config.productId, config.rawDeviceId)
    this.usage = this.loadUsage()
    this.loadLegacy()
    this.loadLicense()
    this.loadMeta()
    this.rollClock()
  }

  snapshot(): LicenseSnapshot {
    this.rollClock()
    const mode = this.access()
    const unlimited = mode === 'licensed' || this.legacyUnlimited
    const remaining = unlimited ? null : remainingSeconds(this.usage, this.quota())
    const copy = this.config.copy
    return {
      mode,
      legacyUnlimited: this.legacyUnlimited,
      deviceLimit: this.adopted?.fields.deviceLimit ?? this.config.deviceLimit,
      remainingLabel: remaining == null ? null : copy.remaining(remaining),
      remainingSeconds: remaining,
      dialog: this.dialogModel(),
      quietNote: this.quietNote(),
      keyHint: mode === 'licensed' ? this.adopted?.fields.keyHint ?? null : null,
      canEnterKey: true,
      canDeactivate: mode === 'licensed' && !!this.adopted?.fields.deviceId,
      historyAvailable: true,
      settingsAvailable: true,
      modelsAvailable: true,
      exportAvailable: true,
      updatesAvailable: true,
      purchaseUrl: this.config.purchaseUrl,
      portalUrl: this.config.portalUrl
    }
  }

  canStartDictation(): StartDecision {
    this.rollClock()
    if (this.access() === 'licensed' || this.legacyUnlimited) return { ok: true, meter: false }
    if (remainingSeconds(this.usage, this.quota()) > 0) return { ok: true, meter: true }
    this.dialog = { kind: 'daily-cap' }
    return { ok: false }
  }

  /** Recorded audio seconds of a take that was saved. Returns true when this take crossed the cap. */
  noteFinishedDictation(recordedAudioSeconds: number, meter: boolean): boolean {
    this.rollClock()
    if (!meter || this.access() === 'licensed' || this.legacyUnlimited) return false
    const quota = this.quota()
    const before = remainingSeconds(this.usage, quota)
    this.usage = applyRecorded(this.usage, recordedAudioSeconds, quota)
    this.persistUsage()
    const crossed = before > 0 && remainingSeconds(this.usage, quota) <= 0
    if (crossed) this.dialog = { kind: 'daily-cap' }
    return crossed
  }

  openKeyEntry(): void {
    this.dialog = { kind: 'key-entry', error: null }
  }

  dismissDialog(): void {
    this.dialog = null
  }

  async activate(rawKey: string, opts?: { silent?: boolean }): Promise<void> {
    return this.enqueue(async () => {
      await this.activateInner(rawKey, opts?.silent === true, false)
    })
  }

  async deactivate(): Promise<void> {
    return this.enqueue(() => this.deactivateInner())
  }

  async tick(): Promise<void> {
    return this.enqueue(() => this.tickInner())
  }

  private async tickInner(): Promise<void> {
    this.rollClock()
    if (this.dialog?.kind === 'daily-cap' && this.canStartDictation().ok) this.dialog = null
    if (this.meta.pendingSilent && this.uiReady() && this.networkAllowed(false)) {
      const key = this.keys.read()
      if (key) await this.activateInner(key, true, false)
      else this.meta.pendingSilent = false
    }
    if (this.checkinDue()) await this.checkinInner()
    this.persistMeta()
  }

  private async activateInner(rawKey: string, silent: boolean, recovery: boolean): Promise<ActivateResult> {
    const key = normalizeLicenseKey(rawKey)
    if (!key) {
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.invalidKey }
      return 'empty'
    }
    if (!this.networkAllowed(true)) {
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.rateLimit }
      return 'rate_limited'
    }
    const requestId = newRequestId((n) => this.crypto.randomBytes(n))
    const verified = await this.post(
      'activate',
      activateRequest({
        productId: this.config.productId,
        licenseKey: key,
        fingerprint: this.fingerprint,
        deviceName: this.config.deviceName,
        platform: this.config.platform,
        arch: this.config.arch,
        appVersion: this.config.appVersion,
        requestId
      }),
      true
    )
    if (verified === 'network') {
      if (!silent) {
        this.dialog = { kind: 'key-entry', error: this.config.copy.networkError }
      } else {
        this.noteAutoFailure()
      }
      return 'network'
    }
    const interpreted = this.read(verified, requestId, 'activate')
    if (interpreted.kind === 'rejected' || interpreted.kind === 'no_change') {
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.networkError }
      else this.noteAutoFailure()
      return 'rejected'
    }
    this.noteServerTime(interpreted.serverTimeMs)
    if (interpreted.kind === 'rate_limited') {
      this.meta.rateLimitedUntilMs = this.now() + interpreted.retryAfterSeconds * 1000
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.rateLimit }
      this.persistMeta()
      return 'rate_limited'
    }
    if (interpreted.kind === 'invalid_key') {
      this.meta.pendingSilent = false
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.invalidKey }
      this.persistMeta()
      return 'invalid_key'
    }
    if (interpreted.kind === 'device_limit') {
      if (!silent && !recovery) this.dialog = { kind: 'device-limit' }
      return 'device_limit'
    }
    if (interpreted.kind === 'device_not_found') return 'device_not_found'
    if (interpreted.kind === 'fingerprint_mismatch') {
      this.fingerprintMismatch = true
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.fingerprintMismatch }
      return 'fingerprint_mismatch'
    }
    if (interpreted.kind !== 'adopt') {
      if (!silent) this.dialog = { kind: 'key-entry', error: this.config.copy.networkError }
      return 'rejected'
    }
    if (recovery && isRestrictingState(interpreted.fields.state)) return 'revoked'
    this.adopt(interpreted.fields, interpreted.serverTimeMs, verified.raw)
    try {
      this.keys.write(key)
    } catch (err) {
      this.log(`key write failed: ${err instanceof Error ? err.message : err}`)
    }
    this.meta.pendingSilent = false
    this.meta.checkinFailures = 0
    this.meta.nextNetworkAttemptAtMs = 0
    this.fingerprintMismatch = false
    this.dialog = null
    this.persistMeta()
    return 'licensed'
  }

  private async checkinInner(): Promise<void> {
    const fields = this.adopted?.fields
    if (!fields?.licenseId || !fields.deviceId) return
    const requestId = newRequestId((n) => this.crypto.randomBytes(n))
    const verified = await this.post(
      'checkin',
      checkinRequest({
        productId: this.config.productId,
        licenseId: fields.licenseId,
        deviceId: fields.deviceId,
        fingerprint: this.fingerprint,
        appVersion: this.config.appVersion,
        requestId
      }),
      false
    )
    if (verified === 'network') {
      this.noteAutoFailure()
      return
    }
    const interpreted = this.read(verified, requestId, 'checkin')
    if (interpreted.kind === 'rejected') return
    this.noteServerTime(interpreted.serverTimeMs)
    if (interpreted.kind === 'rate_limited') {
      this.meta.rateLimitedUntilMs = this.now() + interpreted.retryAfterSeconds * 1000
      this.persistMeta()
      return
    }
    if (interpreted.kind === 'device_not_found') {
      await this.recoverMissingDevice()
      return
    }
    if (interpreted.kind === 'invalid_key' || interpreted.kind === 'no_change' || interpreted.kind === 'device_limit') {
      // Check-in must not clear an active license.
      return
    }
    if (interpreted.kind === 'fingerprint_mismatch') {
      this.fingerprintMismatch = true
      return
    }
    if (interpreted.kind !== 'adopt') return
    this.adopt(interpreted.fields, interpreted.serverTimeMs, verified.raw)
    this.meta.checkinFailures = 0
    this.meta.nextNetworkAttemptAtMs = 0
    this.persistMeta()
    await this.statusInner()
  }

  /**
   * While licensed, status carries this device's binding next to the stored key
   * so a rotated key still resolves. invalid_key here never drops the seat.
   * The status license has no device binding, so it does not replace license.json.
   */
  private async statusInner(): Promise<void> {
    const fields = this.adopted?.fields
    if (!fields?.licenseId || !fields.deviceId || this.access() !== 'licensed') return
    const key = this.keys.read()
    if (!key) return
    const requestId = newRequestId((n) => this.crypto.randomBytes(n))
    const verified = await this.post(
      'status',
      statusRequest({
        productId: this.config.productId,
        licenseKey: key,
        requestId,
        licenseId: fields.licenseId,
        deviceId: fields.deviceId,
        fingerprint: this.fingerprint
      }),
      false
    )
    if (verified === 'network') return
    const interpreted = this.read(verified, requestId, 'status')
    if (interpreted.kind === 'rejected') return
    this.noteServerTime(interpreted.serverTimeMs)
    if (interpreted.kind === 'rate_limited') {
      this.meta.rateLimitedUntilMs = this.now() + interpreted.retryAfterSeconds * 1000
      this.persistMeta()
      return
    }
    if (interpreted.kind === 'invalid_key' || interpreted.kind === 'no_change' || interpreted.kind === 'device_not_found') {
      return
    }
    if (interpreted.kind === 'status' && interpreted.fields?.keyHint && this.adopted) {
      this.adopted = {
        ...this.adopted,
        fields: { ...this.adopted.fields, keyHint: interpreted.fields.keyHint }
      }
    }
  }

  private async deactivateInner(): Promise<void> {
    const fields = this.adopted?.fields
    if (!fields?.licenseId || !fields.deviceId || this.access() !== 'licensed') return
    const requestId = newRequestId((n) => this.crypto.randomBytes(n))
    const verified = await this.post(
      'deactivate',
      deactivateRequest({
        productId: this.config.productId,
        licenseId: fields.licenseId,
        deviceId: fields.deviceId,
        fingerprint: this.fingerprint,
        requestId
      }),
      true
    )
    if (verified === 'network') {
      this.dialog = { kind: 'key-entry', error: this.config.copy.deactivateFailed }
      return
    }
    const interpreted = this.read(verified, requestId, 'deactivate')
    if (interpreted.kind !== 'deactivate_ok') {
      this.dialog = { kind: 'key-entry', error: this.config.copy.deactivateFailed }
      return
    }
    this.noteServerTime(interpreted.serverTimeMs)
    this.storage.remove(LICENSE_FILE)
    this.storage.remove(LICENSE_PREV_FILE)
    try {
      this.keys.clear()
    } catch (err) {
      this.log(`key clear failed: ${err instanceof Error ? err.message : err}`)
    }
    this.adopted = null
    this.dialog = null
    this.meta.pendingSilent = false
  }

  /**
   * v0.4.3: a signed device_not_found triggers one silent re-activation.
   * Success keeps the seat. A hard failure drops to free mode and offers
   * re-activation. A network error leaves the current license untouched.
   * The legacy marker is not cleared on any of these paths.
   */
  private async recoverMissingDevice(): Promise<void> {
    if (this.recoveringDevice) return
    this.recoveringDevice = true
    try {
      const key = this.keys.read()
      if (!key) {
        this.dropLicenseKeepData()
        this.dialog = { kind: 'reactivate', error: null }
        return
      }
      const result = await this.activateInner(key, true, true)
      if (result === 'licensed') return
      if (result === 'network' || result === 'rate_limited') return
      this.dropLicenseKeepData()
      if (result === 'device_limit') this.dialog = { kind: 'device-limit' }
      else if (result === 'invalid_key') this.dialog = { kind: 'reactivate', error: this.config.copy.invalidKey }
      else this.dialog = { kind: 'reactivate', error: null }
    } finally {
      this.recoveringDevice = false
    }
  }

  /** Forget the seat. History, usage, the key, and the legacy marker stay. */
  private dropLicenseKeepData(): void {
    this.storage.remove(LICENSE_FILE)
    this.storage.remove(LICENSE_PREV_FILE)
    this.adopted = null
    this.meta.pendingSilent = false
    this.persistMeta()
  }

  private read(
    verified: { raw: string; payload: Record<string, unknown>; serverTimeMs: number },
    requestId: string,
    context: 'activate' | 'checkin' | 'deactivate' | 'status'
  ): Interpreted {
    return interpretPayload(
      verified.payload,
      {
        context,
        productId: this.config.productId,
        requestId,
        fingerprint: this.fingerprint,
        boundLicenseId: context === 'activate' ? null : this.adopted?.fields.licenseId ?? null,
        boundDeviceId: context === 'activate' ? null : this.adopted?.fields.deviceId ?? null
      },
      verified.serverTimeMs
    )
  }

  private async post(
    method: 'activate' | 'checkin' | 'deactivate' | 'status',
    body: Record<string, unknown>,
    userInitiated: boolean
  ): Promise<{ raw: string; payload: Record<string, unknown>; serverTimeMs: number } | 'network'> {
    if (!this.uiReady() || !this.networkAllowed(userInitiated)) return 'network'
    this.networkCalls += 1
    const headers = licenseHeaders({
      apiVersionHeader: this.config.copy.apiVersionHeader,
      productName: this.config.copy.productName,
      appVersion: this.config.appVersion,
      platform: this.config.platform,
      arch: this.config.arch
    })
    let response: Awaited<ReturnType<LicenseTransport['post']>>
    try {
      response = await this.transport.post(
        licenseUrl(this.config.baseUrl, method),
        body,
        headers,
        this.config.timeoutMs ?? LICENSE_TIMEOUT_MS
      )
    } catch (err) {
      this.log(`license transport failed: ${err instanceof Error ? err.message : err}`)
      return 'network'
    }
    if (response.kind === 'error') return 'network'
    const verified = verifyEnvelope(response.raw, this.crypto, this.config.publicKeys, this.config.channel)
    if (!verified.ok) return 'network'
    return { raw: response.raw, payload: verified.payload, serverTimeMs: verified.serverTimeMs }
  }

  private checkinDue(): boolean {
    if (!this.uiReady() || this.access() !== 'licensed') return false
    const fields = this.adopted?.fields
    if (!fields?.licenseId || !fields.deviceId) return false
    const schedule = checkinNotBefore({
      nextCheckinAfterMs: fields.nextCheckinAfterMs,
      nowMs: this.now(),
      fallbackNotBeforeMs: this.meta.fallbackCheckinAtMs
    })
    if (schedule.synthesizeFallback) {
      this.meta.fallbackCheckinAtMs = schedule.notBeforeMs
      this.persistMeta()
    }
    if (this.now() < schedule.notBeforeMs) return false
    return this.networkAllowed(false)
  }

  private networkAllowed(userInitiated: boolean): boolean {
    const now = this.now()
    if (now < this.meta.rateLimitedUntilMs) return false
    if (!userInitiated && now < this.meta.nextNetworkAttemptAtMs) return false
    return true
  }

  private noteAutoFailure(): void {
    this.meta.checkinFailures += 1
    this.meta.nextNetworkAttemptAtMs = this.now() + networkBackoffMs(this.meta.checkinFailures)
    this.persistMeta()
  }

  private noteServerTime(serverTimeMs: number): void {
    if (serverTimeMs > this.meta.trustedServerTimeMs) this.meta.trustedServerTimeMs = serverTimeMs
  }

  private adopt(fields: LicenseFields, serverTimeMs: number, raw: string): void {
    const stamped = this.withDeviceLimit(fields)
    const current = this.storage.read(LICENSE_FILE)
    if (current && current.trim() && verifyEnvelope(current, this.crypto, this.config.publicKeys, this.config.channel).ok) {
      this.storage.writeAtomic(LICENSE_PREV_FILE, current)
    }
    this.storage.writeAtomic(LICENSE_FILE, raw)
    this.adopted = { raw, fields: stamped, serverTimeMs }
    this.noteServerTime(serverTimeMs)
    if (stamped.nextCheckinAfterMs != null) this.meta.fallbackCheckinAtMs = null
  }

  /** Catalog device_limit fills only a missing signed field. A present value stays. */
  private withDeviceLimit(fields: LicenseFields): LicenseFields {
    if (fields.deviceLimit != null) return fields
    if (!Number.isInteger(this.config.deviceLimit) || this.config.deviceLimit <= 0) return fields
    return { ...fields, deviceLimit: this.config.deviceLimit }
  }

  private access(): 'free' | 'licensed' {
    if (!this.adopted) return 'free'
    return accessMode(this.adopted.fields, this.now(), this.meta.trustedServerTimeMs)
  }

  private quota(): number {
    return effectiveQuota(this.adopted?.fields ?? null)
  }

  private loadLegacy(): void {
    let storedRaw: string | null = null
    try {
      storedRaw = this.legacyStore.read()
    } catch (err) {
      this.log(`legacy read failed: ${err instanceof Error ? err.message : err}`)
    }
    const decision = evaluateLegacy({
      crypto: this.crypto,
      productId: this.config.productId,
      rawDeviceId: this.config.rawDeviceId,
      runningVersion: this.config.appVersion,
      storedRaw,
      bridgeRaw: this.config.bridgeRaw,
      witness: this.config.witness,
      runMigration: this.config.runLegacyMigration && shouldRunLegacyMigration(this.config.appVersion)
    })
    this.legacyUnlimited = decision.unlimited
    if (!decision.write) return
    try {
      this.legacyStore.write(JSON.stringify(decision.write))
    } catch (err) {
      this.log(`legacy write failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private loadLicense(): void {
    const current = this.consider(this.storage.read(LICENSE_FILE))
    const prev = this.consider(this.storage.read(LICENSE_PREV_FILE))
    if (current.kind === 'adopt') {
      this.adopted = current.adopted
      this.noteServerTime(current.adopted.serverTimeMs)
      return
    }
    if (prev.kind === 'adopt') {
      this.adopted = prev.adopted
      this.noteServerTime(prev.adopted.serverTimeMs)
      this.meta.pendingSilent = this.keys.read() != null
      return
    }
    if (current.kind === 'mismatch' || prev.kind === 'mismatch') {
      this.fingerprintMismatch = true
      this.meta.pendingSilent = this.keys.read() != null
      return
    }
    const hadFile = current.kind === 'invalid' || prev.kind === 'invalid'
    if (hadFile && this.keys.read() != null) this.meta.pendingSilent = true
  }

  private consider(raw: string | null): { kind: 'empty' } | { kind: 'invalid' } | { kind: 'mismatch' } | { kind: 'adopt'; adopted: Adopted } {
    if (raw == null) return { kind: 'empty' }
    if (raw.trim() === '') return { kind: 'invalid' }
    const verified = verifyEnvelope(raw, this.crypto, this.config.publicKeys, this.config.channel)
    if (!verified.ok) return { kind: 'invalid' }
    const interpreted = interpretPayload(
      verified.payload,
      {
        context: 'stored',
        productId: this.config.productId,
        requestId: null,
        fingerprint: this.fingerprint,
        boundLicenseId: null,
        boundDeviceId: null
      },
      verified.serverTimeMs
    )
    if (interpreted.kind === 'fingerprint_mismatch') return { kind: 'mismatch' }
    if (interpreted.kind !== 'adopt') return { kind: 'invalid' }
    return { kind: 'adopt', adopted: { raw, fields: this.withDeviceLimit(interpreted.fields), serverTimeMs: verified.serverTimeMs } }
  }

  private loadUsage(): UsageState {
    const parsed = parseUsage(this.storage.read(USAGE_FILE), this.now())
    return observeClock(parsed.state, this.now(), effectiveQuota(null))
  }

  private rollClock(): void {
    const next = observeClock(this.usage, this.now(), this.quota())
    if (
      next.highestSeenMs !== this.usage.highestSeenMs ||
      next.day !== this.usage.day ||
      next.usedSeconds !== this.usage.usedSeconds ||
      next.debtSeconds !== this.usage.debtSeconds
    ) {
      this.usage = next
      this.persistUsage()
    }
  }

  private persistUsage(): void {
    try {
      this.storage.writeAtomic(USAGE_FILE, serializeUsage(this.usage))
    } catch (err) {
      this.log(`usage write failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private loadMeta(): void {
    const raw = this.storage.read(META_FILE)
    if (!raw) return
    try {
      const value = JSON.parse(raw) as Record<string, unknown>
      this.meta = {
        trustedServerTimeMs: numberOr(value.trustedServerTimeMs, this.meta.trustedServerTimeMs),
        nextNetworkAttemptAtMs: numberOr(value.nextNetworkAttemptAtMs, 0),
        rateLimitedUntilMs: numberOr(value.rateLimitedUntilMs, 0),
        checkinFailures: numberOr(value.checkinFailures, 0),
        fallbackCheckinAtMs: typeof value.fallbackCheckinAtMs === 'number' ? value.fallbackCheckinAtMs : null,
        pendingSilent: value.pendingSilent === true || this.meta.pendingSilent
      }
    } catch {
      /* corrupt meta must not lock the app */
    }
    if (this.adopted) this.noteServerTime(this.adopted.serverTimeMs)
  }

  private persistMeta(): void {
    try {
      this.storage.writeAtomic(META_FILE, JSON.stringify(this.meta))
    } catch (err) {
      this.log(`meta write failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  private dialogModel(): LicenseDialogModel | null {
    if (this.legacyUnlimited && this.access() !== 'licensed' && this.dialog?.kind === 'daily-cap') return null
    const copy = this.config.copy
    if (this.dialog?.kind === 'daily-cap') {
      return {
        kind: 'daily-cap',
        body: copy.dailyCapBody,
        primaryLabel: copy.buyButton,
        secondaryLabel: copy.enterKeyButton,
        error: null,
        linkUrl: null
      }
    }
    if (this.dialog?.kind === 'key-entry') {
      return {
        kind: 'key-entry',
        body: copy.enterKeyButton,
        primaryLabel: copy.keySubmit,
        secondaryLabel: null,
        error: this.dialog.error,
        linkUrl: null
      }
    }
    if (this.dialog?.kind === 'device-limit') {
      return {
        kind: 'device-limit',
        body: copy.deviceLimit(this.config.portalUrl),
        primaryLabel: null,
        secondaryLabel: copy.enterKeyButton,
        error: null,
        linkUrl: this.config.portalUrl
      }
    }
    if (this.dialog?.kind === 'reactivate') {
      return {
        kind: 'reactivate',
        body: copy.reactivateOffer,
        primaryLabel: copy.keySubmit,
        secondaryLabel: null,
        error: this.dialog.error,
        linkUrl: null
      }
    }
    return null
  }

  private quietNote(): string | null {
    const fields = this.adopted?.fields
    if (fields && pastRestrictAfter(fields, this.now(), this.meta.trustedServerTimeMs) === false && fields.restrictAfterMs != null && fields.state !== 'active') {
      if (fields.state === 'revoked' || fields.state === 'refunded' || fields.state === 'deactivated') {
        return this.config.copy.grace(fields.restrictAfterMs)
      }
    }
    if (this.access() === 'licensed' && fields?.checkinNudgeAfterMs != null && this.now() >= fields.checkinNudgeAfterMs) {
      return this.config.copy.checkinNudge
    }
    if (this.fingerprintMismatch && this.access() !== 'licensed') return this.config.copy.fingerprintMismatch
    return null
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }
}

/** Used when the license module itself cannot start. Dictation stays available. */
export function failOpenSnapshot(purchaseUrl = '', portalUrl = ''): LicenseSnapshot {
  return {
    mode: 'free',
    legacyUnlimited: true,
    deviceLimit: null,
    remainingLabel: null,
    remainingSeconds: null,
    dialog: null,
    quietNote: null,
    keyHint: null,
    canEnterKey: true,
    canDeactivate: false,
    historyAvailable: true,
    settingsAvailable: true,
    modelsAvailable: true,
    exportAvailable: true,
    updatesAvailable: true,
    purchaseUrl,
    portalUrl
  }
}

type ActivateResult =
  | 'licensed'
  | 'network'
  | 'invalid_key'
  | 'device_limit'
  | 'revoked'
  | 'rate_limited'
  | 'fingerprint_mismatch'
  | 'rejected'
  | 'device_not_found'
  | 'empty'

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
