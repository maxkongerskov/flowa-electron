#!/usr/bin/env node
// Ed25519 helpers for the release feed. The app verifies with the same
// construction in src/shared/updateTrust.ts (SHA-256 of the file, then ed25519).
//
//   node scripts/update-trust.mjs generate <private.pem>
//   node scripts/update-trust.mjs write-public <private.pem> src/shared/updatePublicKey.ts
//   node scripts/update-trust.mjs check-embedded <private.pem> src/shared/updatePublicKey.ts
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { createReadStream, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('error', reject)
    input.on('data', (chunk) => hash.update(chunk))
    input.on('end', () => resolve(hash.digest()))
  })
}

export function generateUpdateKeyPair() {
  const pair = generateKeyPairSync('ed25519')
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

export function publicKeyFromPrivate(privateKeyPem) {
  return createPublicKey(createPrivateKey(privateKeyPem)).export({ type: 'spki', format: 'pem' }).toString()
}

export function signSha256(privateKeyPem, digest) {
  return sign(null, digest, createPrivateKey(privateKeyPem)).toString('base64')
}

export function verifySha256(publicKeyPem, digest, signatureB64) {
  const pem = String(publicKeyPem ?? '').trim()
  const sig = String(signatureB64 ?? '').trim()
  if (!pem || !sig) return false
  try {
    const signature = Buffer.from(sig, 'base64')
    if (signature.length === 0) return false
    return verify(null, digest, createPublicKey(pem), signature)
  } catch {
    return false
  }
}

export function embeddedPublicKey(source) {
  const match = source.match(/export const UPDATE_PUBLIC_KEY = ('([^']*)'|`([^`]*)`)/)
  if (!match) throw new Error('src/shared/updatePublicKey.ts has no UPDATE_PUBLIC_KEY')
  return (match[2] ?? match[3] ?? '').trim()
}

export function renderPublicKeyModule(publicKey) {
  const body = publicKey.trim()
  const literal = body.includes('\n') ? `\`${body}\n\`` : `''`
  return `// Public half of Flowa's update signing key.
// The private key stays on the release Mac and is never committed.
//   bash scripts/generate-update-key.sh
// rewrites this constant, then commit this file before \`npm run release\`.
export const UPDATE_PUBLIC_KEY = ${literal}
`
}

function die(message) {
  console.error(message)
  process.exit(1)
}

function main() {
  const [cmd, a, b] = process.argv.slice(2)
  if (cmd === 'generate') {
    if (!a) die('usage: node scripts/update-trust.mjs generate <private.pem>')
    const pair = generateUpdateKeyPair()
    writeFileSync(a, pair.privateKey, { mode: 0o600 })
    console.log(`Wrote ${a}`)
    console.log(pair.publicKey)
    return
  }
  if (cmd === 'write-public') {
    if (!a || !b) die('usage: node scripts/update-trust.mjs write-public <private.pem> <updatePublicKey.ts>')
    const publicKey = publicKeyFromPrivate(readFileSync(a, 'utf8'))
    writeFileSync(b, renderPublicKeyModule(publicKey))
    console.log(`Wrote public key into ${b}`)
    return
  }
  if (cmd === 'check-embedded') {
    if (!a || !b) die('usage: node scripts/update-trust.mjs check-embedded <private.pem> <updatePublicKey.ts>')
    const derived = publicKeyFromPrivate(readFileSync(a, 'utf8')).trim()
    const embedded = embeddedPublicKey(readFileSync(b, 'utf8'))
    if (!embedded) {
      die(`No public key is embedded in ${b}. Run bash scripts/generate-update-key.sh and commit that file.`)
    }
    if (derived !== embedded) {
      die(`The public key in ${b} does not match ${a}. Refusing to sign a release with a different key.`)
    }
    console.log('Update signing key matches the embedded public key.')
    return
  }
  die('usage: node scripts/update-trust.mjs generate|write-public|check-embedded ...')
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (invoked) main()
