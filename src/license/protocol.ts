// Request bodies and verified-payload interpretation.
// Unknown fields are ignored. Unknown enums do not restrict.

import type { DeviceListing, LicenseFields } from './types'
import { isProductId, parseServerTime } from './encoding'

export type ExchangeContext = 'activate' | 'checkin' | 'deactivate' | 'status' | 'stored'

export interface InterpretContext {
  context: ExchangeContext
  productId: string
  /** Null when reading a file we already stored. */
  requestId: string | null
  fingerprint: string
  boundLicenseId: string | null
  boundDeviceId: string | null
}

export type Interpreted =
  | { kind: 'adopt'; fields: LicenseFields; serverTimeMs: number }
  | { kind: 'deactivate_ok'; serverTimeMs: number; devicesUsed: number | null }
  | { kind: 'invalid_key'; serverTimeMs: number }
  | { kind: 'device_limit'; serverTimeMs: number; devices: DeviceListing[] }
  | { kind: 'rate_limited'; serverTimeMs: number; retryAfterSeconds: number }
  | { kind: 'fingerprint_mismatch'; serverTimeMs: number }
  /** The signed license does not know this device. The app tries one re-activation. */
  | { kind: 'device_not_found'; serverTimeMs: number }
  | { kind: 'status'; serverTimeMs: number; devices: DeviceListing[]; fields: LicenseFields | null }
  /** Signed and understood, but the local license must stay as it is. */
  | { kind: 'no_change'; serverTimeMs: number }
  /** Unsigned, replayed, wrong product, or otherwise not a usable answer. */
  | { kind: 'rejected' }

export function licenseHeaders(args: {
  apiVersionHeader: string
  productName: string
  appVersion: string
  platform: string
  arch: string
}): Record<string, string> {
  return {
    [args.apiVersionHeader]: '1',
    'User-Agent': `${args.productName}/${args.appVersion} (${args.platform}-${args.arch})`,
    'Content-Type': 'application/json',
    Accept: 'application/json'
  }
}

export function licenseUrl(baseUrl: string, method: 'activate' | 'checkin' | 'deactivate' | 'status'): string {
  return `${baseUrl.replace(/\/+$/, '')}/${method}`
}

export function normalizeLicenseKey(raw: string): string {
  return raw.replace(/\s+/g, '')
}

export function activateRequest(args: {
  productId: string
  licenseKey: string
  fingerprint: string
  deviceName?: string
  platform: string
  arch: string
  appVersion: string
  requestId: string
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    product_id: args.productId,
    license_key: args.licenseKey,
    fingerprint: args.fingerprint,
    platform: args.platform,
    arch: args.arch,
    app_version: args.appVersion,
    request_id: args.requestId
  }
  if (args.deviceName && args.deviceName.trim()) body.device_name = args.deviceName.trim()
  return body
}

export function checkinRequest(args: {
  productId: string
  licenseId: string
  deviceId: string
  fingerprint: string
  appVersion: string
  requestId: string
}): Record<string, unknown> {
  return {
    product_id: args.productId,
    license_id: args.licenseId,
    device_id: args.deviceId,
    fingerprint: args.fingerprint,
    app_version: args.appVersion,
    request_id: args.requestId
  }
}

export function deactivateRequest(args: {
  productId: string
  licenseId: string
  deviceId: string
  fingerprint: string
  requestId: string
}): Record<string, unknown> {
  return {
    product_id: args.productId,
    license_id: args.licenseId,
    device_id: args.deviceId,
    fingerprint: args.fingerprint,
    request_id: args.requestId
  }
}

export function statusRequest(args: { productId: string; licenseKey: string; requestId: string }): Record<string, unknown> {
  return { product_id: args.productId, license_key: args.licenseKey, request_id: args.requestId }
}

export function interpretPayload(payload: Record<string, unknown>, ctx: InterpretContext, serverTimeMs: number): Interpreted {
  const product = payload.product_id
  if (typeof product !== 'string' || !isProductId(product) || product !== ctx.productId) return { kind: 'rejected' }
  if (ctx.requestId != null) {
    if (typeof payload.request_id !== 'string' || payload.request_id !== ctx.requestId) return { kind: 'rejected' }
  }
  const api = payload.api_version
  if (typeof api !== 'number' || !Number.isInteger(api) || api < 1) return { kind: 'rejected' }

  const status = typeof payload.status === 'string' ? payload.status : ''
  if (status === 'unsupported_api_version' || status === 'bad_request' || status === 'server_error' || status === '') {
    return { kind: 'no_change', serverTimeMs }
  }
  if (status === 'rate_limited') {
    const retry = payload.retry_after
    const seconds = typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : 60
    return { kind: 'rate_limited', serverTimeMs, retryAfterSeconds: seconds }
  }
  if (status === 'invalid_key') return { kind: 'invalid_key', serverTimeMs }
  if (status === 'device_limit_reached') {
    return { kind: 'device_limit', serverTimeMs, devices: readDevices(payload) }
  }
  if (status === 'fingerprint_mismatch') return { kind: 'fingerprint_mismatch', serverTimeMs }
  if (status === 'device_not_found') return { kind: 'device_not_found', serverTimeMs }

  if (ctx.context === 'deactivate' && (status === 'ok' || status === 'active')) {
    const used = payload.devices_used
    return {
      kind: 'deactivate_ok',
      serverTimeMs,
      devicesUsed: typeof used === 'number' && Number.isFinite(used) ? used : null
    }
  }

  if (ctx.context === 'status' && (status === 'ok' || status === 'active')) {
    return { kind: 'status', serverTimeMs, devices: readDevices(payload), fields: readLicenseFields(payload) }
  }

  const fields = readLicenseFields(payload)
  if (!fields) {
    // A new success status we do not understand, without a license object: no change.
    return { kind: 'no_change', serverTimeMs }
  }
  if (fields.productId !== ctx.productId) return { kind: 'rejected' }

  const binding = bindingProblem(fields, ctx)
  if (binding === 'mismatch') return { kind: 'fingerprint_mismatch', serverTimeMs }
  if (binding === 'reject') return { kind: 'rejected' }

  if (
    status === 'ok' ||
    status === 'active' ||
    status === 'revoked' ||
    status === 'refunded' ||
    status === 'deactivated' ||
    isUnknownStatus(status)
  ) {
    return { kind: 'adopt', serverTimeMs, fields }
  }
  return { kind: 'no_change', serverTimeMs }
}

function isUnknownStatus(status: string): boolean {
  return (
    status !== 'invalid_key' &&
    status !== 'device_limit_reached' &&
    status !== 'fingerprint_mismatch' &&
    status !== 'rate_limited' &&
    status !== 'unsupported_api_version' &&
    status !== 'bad_request' &&
    status !== 'server_error' &&
    status !== 'device_not_found'
  )
}

function bindingProblem(fields: LicenseFields, ctx: InterpretContext): 'ok' | 'mismatch' | 'reject' {
  if (!fields.licenseId) return 'reject'
  if (ctx.context === 'activate' || ctx.context === 'stored') {
    if (!fields.deviceId) return 'reject'
    if (!fields.fingerprint || fields.fingerprint !== ctx.fingerprint) return 'mismatch'
    return 'ok'
  }
  if (ctx.context === 'checkin') {
    if (!ctx.boundLicenseId || fields.licenseId !== ctx.boundLicenseId) return 'reject'
    if (!ctx.boundDeviceId || !fields.deviceId || fields.deviceId !== ctx.boundDeviceId) return 'reject'
    if (!fields.fingerprint || fields.fingerprint !== ctx.fingerprint) return 'mismatch'
    return 'ok'
  }
  return 'reject'
}

export function readDevices(payload: Record<string, unknown>): DeviceListing[] {
  if (!Array.isArray(payload.devices)) return []
  const out: DeviceListing[] = []
  for (const item of payload.devices) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.length === 0) continue
    out.push({
      id: o.id,
      name: typeof o.name === 'string' ? o.name : null,
      platform: typeof o.platform === 'string' ? o.platform : null,
      lastSeen: typeof o.last_seen === 'string' ? o.last_seen : null
    })
  }
  return out
}

export function readLicenseFields(payload: Record<string, unknown>): LicenseFields | null {
  const lic = payload.license
  if (!lic || typeof lic !== 'object' || Array.isArray(lic)) return null
  const o = lic as Record<string, unknown>
  const payloadProduct = typeof payload.product_id === 'string' ? payload.product_id : ''
  const productId = typeof o.product_id === 'string' ? o.product_id : payloadProduct
  if (!isProductId(productId)) return null
  const licenseId = typeof o.license_id === 'string' ? o.license_id : ''
  const state = typeof o.state === 'string' ? o.state : ''
  if (!licenseId || !state) return null
  const quotaSource = Object.prototype.hasOwnProperty.call(o, 'free_daily_seconds') ? o : payload
  return {
    productId,
    licenseId,
    deviceId: typeof o.device_id === 'string' && o.device_id ? o.device_id : null,
    fingerprint: typeof o.fingerprint === 'string' && o.fingerprint ? o.fingerprint : null,
    state,
    plan: typeof o.plan === 'string' ? o.plan : null,
    deviceLimit: finiteInt(o.device_limit),
    devicesUsed: finiteInt(o.devices_used),
    platform: typeof o.platform === 'string' ? o.platform : null,
    keyHint: typeof o.key_hint === 'string' ? o.key_hint : null,
    issuedAt: typeof o.issued_at === 'string' ? o.issued_at : null,
    nextCheckinAfterMs: readTime(o.next_checkin_after),
    checkinNudgeAfterMs: readTime(o.checkin_nudge_after),
    restrictAfterMs: readTime(o.restrict_after),
    freeDailySeconds: readFreeDailySeconds(quotaSource)
  }
}

function readFreeDailySeconds(source: Record<string, unknown>): number | null {
  if (!Object.prototype.hasOwnProperty.call(source, 'free_daily_seconds')) return null
  const value = source.free_daily_seconds
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

function readTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  return parseServerTime(value)
}

function finiteInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.trunc(value)
}

/** 1h, then 6h, then 24h. `failures` is the count after this failure. */
export function networkBackoffMs(failures: number): number {
  if (failures <= 1) return 60 * 60 * 1000
  if (failures === 2) return 6 * 60 * 60 * 1000
  return 24 * 60 * 60 * 1000
}

/**
 * Used only when a verified license has no usable `next_checkin_after`.
 * The app adds no jitter. A missed check-in never changes access.
 */
export const MISSING_CHECKIN_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Server instant when it is valid, otherwise a stable fallback with no jitter. */
export function checkinNotBefore(args: {
  nextCheckinAfterMs: number | null
  nowMs: number
  fallbackNotBeforeMs: number | null
}): { notBeforeMs: number; synthesizeFallback: boolean } {
  if (args.nextCheckinAfterMs != null && Number.isFinite(args.nextCheckinAfterMs)) {
    return { notBeforeMs: args.nextCheckinAfterMs, synthesizeFallback: false }
  }
  if (args.fallbackNotBeforeMs != null && Number.isFinite(args.fallbackNotBeforeMs)) {
    return { notBeforeMs: args.fallbackNotBeforeMs, synthesizeFallback: false }
  }
  return { notBeforeMs: args.nowMs + MISSING_CHECKIN_AFTER_MS, synthesizeFallback: true }
}
