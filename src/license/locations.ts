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

/**
 * Production license API. Baked in. Production builds ignore environment overrides.
 * The sandbox host is not decided yet, so only an unpackaged sandbox build may replace this.
 */
export const PRODUCTION_LICENSE_BASE_URL = 'https://license.reddocklabs.com/v1'

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
    baseUrl: baked.baseUrl.replace(/\/+$/, ''),
    purchaseUrl: pickUrl(env.FLOWA_LICENSE_PURCHASE_URL, baked.purchaseUrl, false),
    portalUrl: pickUrl(env.FLOWA_LICENSE_PORTAL_URL, baked.portalUrl, false)
  }
}

/**
 * Production always uses the baked host. A sandbox override is accepted only when
 * the caller allows it and the value is https or local http. Anything else keeps
 * the production host, because no sandbox host is decided yet.
 */
export function resolveLicenseBaseUrl(args: {
  channel: LicenseChannel
  env: NodeJS.ProcessEnv
  allowSandboxOverride: boolean
}): string {
  const baked = PRODUCTION_LICENSE_BASE_URL
  if (args.channel !== 'sbx' || !args.allowSandboxOverride) return baked
  return pickUrl(args.env.FLOWA_LICENSE_BASE_URL, baked, true)
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
