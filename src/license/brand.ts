// Product catalog: display name, copy, domains, and license URLs.
// Internal id stays `flowa` and must match the catalog entry.

import catalogJson from '../../config/products.json'
import { PRODUCT_ID } from './productId'
import { fillTemplate, formatRestrictWhen, remainingMinutesLabel } from './text'

export interface BrandTexts {
  dailyCapBody: string
  buyButton: string
  enterKeyButton: string
  deviceLimit: string
  invalidKey: string
  networkError: string
  rateLimit: string
  fingerprintMismatch: string
  checkinNudge: string
  deactivateFailed: string
  keySubmit: string
  remainingMinutes: string
  grace: string
  reactivateOffer: string
}

export interface ProductProfile {
  productId: string
  displayName: string
  licenseDomain: string
  siteDomain: string
  licenseBaseUrl: string
  purchaseUrl: string
  portalUrl: string
  /** Catalog `device_limit`. Copied into a license only when the signed field is absent. */
  deviceLimit: number
  apiVersionHeader: string
  texts: BrandTexts
}

export interface UiCopy {
  dailyCapBody: string
  buyButton: string
  enterKeyButton: string
  keySubmit: string
  invalidKey: string
  networkError: string
  rateLimit: string
  fingerprintMismatch: string
  checkinNudge: string
  deactivateFailed: string
  deviceLimit: (portalUrl: string) => string
  reactivateOffer: string
  /** Catalog device_limit for this product. */
  deviceLimitCount: number
  remaining: (remainingSeconds: number) => string
  grace: (restrictAtMs: number) => string
  productName: string
  apiVersionHeader: string
}

const TEXT_KEYS: (keyof BrandTexts)[] = [
  'dailyCapBody',
  'buyButton',
  'enterKeyButton',
  'deviceLimit',
  'invalidKey',
  'networkError',
  'rateLimit',
  'fingerprintMismatch',
  'checkinNudge',
  'deactivateFailed',
  'keySubmit',
  'remainingMinutes',
  'grace',
  'reactivateOffer'
]

export function loadProductProfile(catalog: unknown, productId = PRODUCT_ID): ProductProfile {
  if (!catalog || typeof catalog !== 'object') throw new Error('product catalog is not an object')
  const root = catalog as Record<string, unknown>
  const header = root.apiVersionHeader
  if (typeof header !== 'string' || header.trim() === '') throw new Error('product catalog is missing apiVersionHeader')
  if (!Array.isArray(root.products)) throw new Error('product catalog is missing products')
  const entry = root.products.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).id === productId)
  if (!entry || typeof entry !== 'object') throw new Error(`product catalog has no ${productId}`)
  const product = entry as Record<string, unknown>
  const displayName = requiredString(product.displayName, 'displayName')
  const domains = product.domains
  if (!domains || typeof domains !== 'object') throw new Error('product catalog is missing domains')
  const domainRecord = domains as Record<string, unknown>
  const licenseDomain = requiredString(domainRecord.license, 'domains.license')
  const siteDomain = requiredString(domainRecord.site, 'domains.site')
  const licenseBaseUrl = httpsUrl(requiredString(product.licenseBaseUrl, 'licenseBaseUrl'), licenseDomain)
  const purchaseUrl = httpsUrl(requiredString(product.purchaseUrl, 'purchaseUrl'), siteDomain)
  const portalUrl = httpsUrl(requiredString(product.portalUrl, 'portalUrl'), siteDomain)
  const deviceLimit = requiredPositiveInt(product.deviceLimit, 'deviceLimit')
  const texts = readTexts(product.texts)
  if (product.id !== PRODUCT_ID) throw new Error('catalog product id does not match the frozen id')
  return {
    productId: PRODUCT_ID,
    displayName,
    licenseDomain,
    siteDomain,
    licenseBaseUrl,
    purchaseUrl,
    portalUrl,
    deviceLimit,
    apiVersionHeader: header.trim(),
    texts
  }
}

export function loadBundledProductProfile(): ProductProfile {
  return loadProductProfile(catalogJson, PRODUCT_ID)
}

export function uiCopy(profile: ProductProfile): UiCopy {
  const name = profile.displayName
  const staticVars = { productName: name, portalUrl: profile.portalUrl, deviceLimit: String(profile.deviceLimit) }
  return {
    dailyCapBody: fillTemplate(profile.texts.dailyCapBody, staticVars),
    buyButton: fillTemplate(profile.texts.buyButton, staticVars),
    enterKeyButton: fillTemplate(profile.texts.enterKeyButton, staticVars),
    keySubmit: fillTemplate(profile.texts.keySubmit, staticVars),
    invalidKey: fillTemplate(profile.texts.invalidKey, staticVars),
    networkError: fillTemplate(profile.texts.networkError, staticVars),
    rateLimit: fillTemplate(profile.texts.rateLimit, staticVars),
    fingerprintMismatch: fillTemplate(profile.texts.fingerprintMismatch, staticVars),
    checkinNudge: fillTemplate(profile.texts.checkinNudge, staticVars),
    deactivateFailed: fillTemplate(profile.texts.deactivateFailed, staticVars),
    deviceLimit: (portalUrl: string) =>
      fillTemplate(profile.texts.deviceLimit, { productName: name, portalUrl, deviceLimit: String(profile.deviceLimit) }),
    reactivateOffer: fillTemplate(profile.texts.reactivateOffer, staticVars),
    deviceLimitCount: profile.deviceLimit,
    remaining: (remainingSeconds: number) => remainingMinutesLabel(profile.texts.remainingMinutes, remainingSeconds),
    grace: (restrictAtMs: number) =>
      fillTemplate(profile.texts.grace, { productName: name, when: formatRestrictWhen(restrictAtMs) }),
    productName: name,
    apiVersionHeader: profile.apiVersionHeader
  }
}

function readTexts(value: unknown): BrandTexts {
  if (!value || typeof value !== 'object') throw new Error('product catalog is missing texts')
  const record = value as Record<string, unknown>
  const texts = {} as BrandTexts
  for (const key of TEXT_KEYS) {
    texts[key] = requiredString(record[key], `texts.${key}`)
  }
  return texts
}

function requiredPositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`product catalog ${label} must be a positive integer`)
  }
  return value
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`product catalog ${label} is empty`)
  return value.trim()
}

function httpsUrl(value: string, domain: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`product catalog URL is invalid: ${value}`)
  }
  if (url.protocol !== 'https:') throw new Error(`product catalog URL must be https: ${value}`)
  if (url.hostname !== domain) throw new Error(`product catalog URL host does not match its domain: ${value}`)
  return value.replace(/\/+$/, '')
}
