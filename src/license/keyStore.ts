import fs from 'node:fs'
import { keyMaterial, type KeyMaterial } from './keyMaterial'
import { writeFileAtomic } from './nodeStorage'
import type { KeyStore } from './types'

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?: () => string
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export function createKeyStore(file: string, safeStorage: SafeStorageLike | null): KeyStore {
  const material = (): KeyMaterial =>
    keyMaterial({
      encryptionAvailable: safeStorage ? safe(() => safeStorage.isEncryptionAvailable(), false) : false,
      backend: safeStorage?.getSelectedStorageBackend ? safe(() => safeStorage.getSelectedStorageBackend?.() ?? null, null) : null
    })

  return {
    read(): string | null {
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(file)
      } catch {
        return null
      }
      if (bytes.length === 0) return null
      if (material() === 'plaintext-0600' || !safeStorage) return bytes.toString('utf8')
      try {
        return safeStorage.decryptString(bytes)
      } catch {
        return null
      }
    },
    write(licenseKey: string): void {
      const mode = material()
      const data = mode === 'encrypted' && safeStorage ? safeStorage.encryptString(licenseKey) : Buffer.from(licenseKey, 'utf8')
      writeFileAtomic(file, data, 0o600)
    },
    clear(): void {
      try {
        fs.rmSync(file, { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
