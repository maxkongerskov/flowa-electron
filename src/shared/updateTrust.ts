// Ed25519 trust for update artifacts.
// The signature covers the SHA-256 of the file bytes. The sha512 in the feed
// is not enough: whoever can rewrite latest*.yml can rewrite that checksum.
// A production build ignores FLOWA_UPDATE_FEED, FLOWA_UPDATE_PUBLIC_KEY, and
// FLOWA_E2E_ALLOW_UNSIGNED. Those exist only when the app was compiled with
// FLOWA_E2E_UPDATES=1.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { UPDATE_PUBLIC_KEY } from './updatePublicKey'

declare const __FLOWA_E2E__: boolean | undefined

export function isE2EBuild(flag?: boolean): boolean {
  if (typeof flag === 'boolean') return flag
  return typeof __FLOWA_E2E__ !== 'undefined' && __FLOWA_E2E__ === true
}

export function updatePublicKey(env: NodeJS.ProcessEnv = process.env, e2e = isE2EBuild()): string {
  if (e2e) {
    const override = env.FLOWA_UPDATE_PUBLIC_KEY?.trim()
    if (override && override.includes('BEGIN PUBLIC KEY')) return override
  }
  return UPDATE_PUBLIC_KEY.trim()
}

/** Localhost generic feed. Production builds cannot turn this on. */
export function e2eFeedUrl(env: NodeJS.ProcessEnv = process.env, e2e = isE2EBuild()): string | null {
  if (!e2e) return null
  const raw = env.FLOWA_UPDATE_FEED?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return null
  return raw.endsWith('/') ? raw : `${raw}/`
}

export function e2eAllowsUnsigned(env: NodeJS.ProcessEnv = process.env, e2e = isE2EBuild()): boolean {
  return e2e && env.FLOWA_E2E_ALLOW_UNSIGNED === '1'
}

export function e2eAutoUpdate(env: NodeJS.ProcessEnv = process.env, e2e = isE2EBuild()): boolean {
  return e2e && env.FLOWA_E2E_AUTO_UPDATE === '1'
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

export function sha256File(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest()))
  })
}

export function generateUpdateKeyPair(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

export function publicKeyFromPrivate(privateKeyPem: string): string {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString()
}

/** Sign the raw SHA-256 digest. Returns standard base64. */
export function signSha256(privateKeyPem: string, digest: Buffer): string {
  return sign(null, digest, createPrivateKey(privateKeyPem)).toString('base64')
}

export function verifySha256(publicKeyPem: string, digest: Buffer, signatureB64: string): boolean {
  const pem = publicKeyPem.trim()
  const sig = signatureB64.trim()
  if (!pem || !sig) return false
  try {
    const signature = Buffer.from(sig, 'base64')
    if (signature.length === 0) return false
    return verify(null, digest, createPublicKey(pem), signature)
  } catch {
    return false
  }
}

export function updateSignatureDecision(args: {
  publicKeyPem: string
  digest: Buffer
  signature: string | null | undefined
  allowUnsigned?: boolean
}): 'ok' | 'rejected' {
  if (args.allowUnsigned) return 'ok'
  if (!args.signature || !verifySha256(args.publicKeyPem, args.digest, args.signature)) return 'rejected'
  return 'ok'
}
