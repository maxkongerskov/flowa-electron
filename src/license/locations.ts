// Where license files live, and which URL the running build may call.
// Packaged builds ignore environment overrides. Nothing here calls a payment provider.

import type { LicenseChannel } from './types'

export const LICENSE_FILE = 'license.json'
export const LICENSE_PREV_FILE = 'license.prev.json'
export const USAGE_FILE = 'usage.json'
export const META_FILE = 'license-meta.json'
export const KEY_FILE = 'license-key.bin'
export const DEVICE_ID_FILE = 'device-id.txt'

export const LICENSE_TIMEOUT_MS = 10_000

const HTTPS_URL = /^https:\/\/[a-z0-9.-]+(?::\d+)?(\/.*)?$/i
const LOCAL_HTTP = /^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(\/.*)?$/i

export interface LicenseLocations {
  baseUrl: string
  purchaseUrl: string
  portalUrl: string
}

export function resolveLicenseLocations(
  baked: LicenseLocations,
  env: NodeJS.ProcessEnv,
  allowRuntimeOverride: boolean
): LicenseLocations {
  if (!allowRuntimeOverride) return strip(baked)
  return {
    baseUrl: pickUrl(env.FLOWA_LICENSE_BASE_URL, baked.baseUrl, true),
    purchaseUrl: pickUrl(env.FLOWA_LICENSE_PURCHASE_URL, baked.purchaseUrl, false),
    portalUrl: pickUrl(env.FLOWA_LICENSE_PORTAL_URL, baked.portalUrl, false)
  }
}

/** Channel only selects which baked public keys are accepted. It does not move userData. */
export function licenseChannel(channel: LicenseChannel): LicenseChannel {
  return channel === 'sbx' ? 'sbx' : 'prod'
}

function strip(locations: LicenseLocations): LicenseLocations {
  return {
    baseUrl: locations.baseUrl.replace(/\/+$/, ''),
    purchaseUrl: locations.purchaseUrl.replace(/\/+$/, ''),
    portalUrl: locations.portalUrl.replace(/\/+$/, '')
  }
}

function pickUrl(raw: string | undefined, fallback: string, allowLocalHttp: boolean): string {
  const value = raw?.trim()
  if (!value) return fallback.replace(/\/+$/, '')
  if (HTTPS_URL.test(value) || (allowLocalHttp && LOCAL_HTTP.test(value))) return value.replace(/\/+$/, '')
  return fallback.replace(/\/+$/, '')
}
