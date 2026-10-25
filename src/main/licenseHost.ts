// Electron adapter for the license module. Dictation stays available if this fails.

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import { net, safeStorage } from 'electron'
import { loadBundledProductProfile, uiCopy } from '../license/brand'
import { failOpenSnapshot, LicenseController, type LicenseConfig } from '../license/controller'
import { parseIOPlatformUUID, parseMachineGuid, readLinuxMachineId, resolveRawDeviceId } from '../license/deviceId'
import { createKeyStore } from '../license/keyStore'
import { licenseChannel, resolveLicenseLocations } from '../license/locations'
import { nodeLicenseCrypto } from '../license/nodeCrypto'
import { createNodeStorage, writeFileAtomic } from '../license/nodeStorage'
import { PLACEHOLDER_KEYS } from '../license/placeholderKeys'
import { PRODUCT_ID } from '../license/productId'
import type { LicenseSnapshot, LicenseTransport, StartDecision } from '../license/types'
import { licenseStoragePaths, pendingUpdateInfoPath, updaterCacheRoot } from '../license/userDataFiles'

export interface RunningLicense {
  snapshot(): LicenseSnapshot
  canStart(): StartDecision
  noteSaved(recordedAudioSeconds: number, meter: boolean): void
  tick(): Promise<void>
  activate(key: string): Promise<void>
  deactivate(): Promise<void>
  dismiss(): void
  openKeyEntry(): void
  purchaseUrl(): string
  portalUrl(): string
  /** `unlimited`, `free`, or `error` when the module could not start. */
  legacyWord: 'unlimited' | 'free' | 'error'
}

export function startLicense(args: {
  version: string
  packaged: boolean
  userDataDir: string
  uiReady: () => boolean
  log?: (message: string) => void
}): RunningLicense {
  const log = args.log ?? ((message: string) => console.warn(`[Flowa] ${message}`))
  try {
    return startLicenseInner(args, log)
  } catch (err) {
    log(`license module failed open: ${err instanceof Error ? err.message : err}`)
    return failed(args.version)
  }
}

function startLicenseInner(
  args: {
    version: string
    packaged: boolean
    userDataDir: string
    uiReady: () => boolean
  },
  log: (message: string) => void
): RunningLicense {
  const profile = loadBundledProductProfile()
  const copy = uiCopy(profile)
  const locations = resolveLicenseLocations(
    { baseUrl: profile.licenseBaseUrl, purchaseUrl: profile.purchaseUrl, portalUrl: profile.portalUrl },
    process.env,
    !args.packaged
  )
  const channel = args.packaged ? 'prod' : licenseChannel(process.env.FLOWA_LICENSE_CHANNEL === 'sbx' ? 'sbx' : 'prod')
  const prefix = channel === 'sbx' ? 'lic-sbx-' : 'lic-prod-'
  const files = licenseStoragePaths(args.userDataDir)
  const cryptoImpl = nodeLicenseCrypto()
  const rawDeviceId = resolveRawDeviceId(
    readPlatformDeviceId(),
    () => readText(files.deviceId),
    (id) => writeFileAtomic(files.deviceId, id, 0o600),
    () => crypto.randomUUID()
  )
  const cacheRoot = updaterCacheRoot(process.platform, process.env, os.homedir())
  const config: LicenseConfig = {
    productId: PRODUCT_ID,
    channel,
    baseUrl: locations.baseUrl,
    purchaseUrl: locations.purchaseUrl,
    portalUrl: locations.portalUrl,
    publicKeys: PLACEHOLDER_KEYS.filter((entry) => entry.kid.startsWith(prefix)),
    appVersion: args.version,
    platform: licensePlatform(process.platform),
    arch: process.arch,
    deviceName: os.hostname(),
    rawDeviceId,
    copy,
    deviceLimit: profile.deviceLimit,
    runLegacyMigration: true,
    // Read only. 1.2.3 writes legacy-bridge.json; this build must not, or a fresh install would grant itself.
    bridgeRaw: readText(files.bridge),
    witness: {
      updateInfoRaw: readText(pendingUpdateInfoPath(cacheRoot)),
      updaterIdRaw: readText(files.updaterId)
    }
  }
  const safe = safeStorage as unknown as Parameters<typeof createKeyStore>[1]
  const controller = new LicenseController(
    config,
    cryptoImpl,
    createNodeStorage(files.directory),
    createKeyStore(files.key, safe),
    createKeyStore(files.legacy, safe),
    electronTransport(log),
    () => Date.now(),
    args.uiReady,
    log
  )
  const guard = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (err) {
      log(`license call failed open: ${err instanceof Error ? err.message : err}`)
      return fallback
    }
  }
  return {
    snapshot: () => guard(() => controller.snapshot(), failOpenSnapshot(locations.purchaseUrl, locations.portalUrl)),
    canStart: () => guard(() => controller.canStartDictation(), { ok: true, meter: false }),
    noteSaved: (seconds, meter) => {
      try {
        controller.noteFinishedDictation(seconds, meter)
      } catch (err) {
        log(`license meter failed open: ${err instanceof Error ? err.message : err}`)
      }
    },
    tick: async () => {
      try {
        await controller.tick()
      } catch (err) {
        log(`license tick failed open: ${err instanceof Error ? err.message : err}`)
      }
    },
    activate: async (key) => {
      try {
        await controller.activate(key)
      } catch (err) {
        log(`license activate failed open: ${err instanceof Error ? err.message : err}`)
      }
    },
    deactivate: async () => {
      try {
        await controller.deactivate()
      } catch (err) {
        log(`license deactivate failed open: ${err instanceof Error ? err.message : err}`)
      }
    },
    dismiss: () => guard(() => controller.dismissDialog(), undefined),
    openKeyEntry: () => guard(() => controller.openKeyEntry(), undefined),
    purchaseUrl: () => locations.purchaseUrl,
    portalUrl: () => locations.portalUrl,
    legacyWord: controller.snapshot().legacyUnlimited ? 'unlimited' : 'free'
  }
}

function failed(_version: string): RunningLicense {
  const snap = failOpenSnapshot()
  return {
    snapshot: () => snap,
    canStart: () => ({ ok: true, meter: false }),
    noteSaved: () => {},
    tick: async () => {},
    activate: async () => {},
    deactivate: async () => {},
    dismiss: () => {},
    openKeyEntry: () => {},
    purchaseUrl: () => '',
    portalUrl: () => '',
    legacyWord: 'error'
  }
}

function electronTransport(log: (message: string) => void): LicenseTransport {
  return {
    post(url, jsonBody, headers, timeoutMs) {
      return new Promise((resolve) => {
        let settled = false
        const done = (value: Awaited<ReturnType<LicenseTransport['post']>>): void => {
          if (settled) return
          settled = true
          resolve(value)
        }
        try {
          const req = net.request({ method: 'POST', url })
          const timer = setTimeout(() => {
            try {
              req.abort()
            } catch {
              /* already finished */
            }
            done({ kind: 'error', reason: 'timeout' })
          }, timeoutMs)
          for (const [name, value] of Object.entries(headers)) req.setHeader(name, value)
          const chunks: Buffer[] = []
          req.on('response', (res) => {
            res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
            res.on('end', () => {
              clearTimeout(timer)
              const status = res.statusCode ?? 0
              if (status < 200 || status >= 300) {
                done({ kind: 'error', reason: 'network' })
                return
              }
              done({ kind: 'response', httpStatus: status, raw: Buffer.concat(chunks).toString('utf8') })
            })
            res.on('error', () => {
              clearTimeout(timer)
              done({ kind: 'error', reason: 'network' })
            })
          })
          req.on('error', (err) => {
            clearTimeout(timer)
            log(`license request failed: ${err instanceof Error ? err.message : err}`)
            done({ kind: 'error', reason: 'network' })
          })
          req.end(JSON.stringify(jsonBody))
        } catch (err) {
          log(`license request failed: ${err instanceof Error ? err.message : err}`)
          done({ kind: 'error', reason: 'network' })
        }
      })
    }
  }
}

function licensePlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'macos'
  if (platform === 'win32') return 'windows'
  return platform
}

function readPlatformDeviceId(): string | null {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 3000 })
      return parseIOPlatformUUID(out)
    }
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        timeout: 3000
      })
      return parseMachineGuid(out)
    }
    return readLinuxMachineId((file) => readText(file))
  } catch {
    return null
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}
