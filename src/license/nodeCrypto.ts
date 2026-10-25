import { createHmac, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import type { LicenseCrypto } from './types'

export function nodeLicenseCrypto(): LicenseCrypto {
  return {
    randomBytes(n: number): Uint8Array {
      return new Uint8Array(randomBytes(n))
    },
    hmacSha256Hex(keyUtf8: string, messageUtf8: string): string {
      return createHmac('sha256', Buffer.from(keyUtf8, 'utf8')).update(Buffer.from(messageUtf8, 'utf8')).digest('hex')
    },
    verifyEd25519(publicKeySpkiPem: string, message: Uint8Array, signature: Uint8Array): boolean {
      try {
        return verify(null, Buffer.from(message), createPublicKey(publicKeySpkiPem), Buffer.from(signature))
      } catch {
        return false
      }
    },
    ed25519RawPublicKey(publicKeySpkiPem: string): Uint8Array {
      const der = createPublicKey(publicKeySpkiPem).export({ type: 'spki', format: 'der' }) as Buffer
      if (der.length < 32) throw new Error('public key is too short')
      return new Uint8Array(der.subarray(der.length - 32))
    }
  }
}

export function signEd25519(privateKeyPem: string, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, Buffer.from(message), createPrivateKey(privateKeyPem)))
}

export function exportEd25519Raw(publicKeyPem: string): Uint8Array {
  return nodeLicenseCrypto().ed25519RawPublicKey(publicKeyPem)
}
