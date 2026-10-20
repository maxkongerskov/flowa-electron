import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertMacRehearsal, macFeedOptions, rewriteChecksumKeepSignature } from '../scripts/e2e-update.mjs'
import { generateUpdateKeyPair, sha256File, verifySha256 } from '../scripts/update-trust.mjs'
import { verifyUpdateFeeds, writeUpdateFeeds } from '../scripts/update-feed.mjs'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

describe('Mac update rehearsal', () => {
  it('accepts a one-arch zip and still signs it', async () => {
    const pair = generateUpdateKeyPair()
    for (const arch of ['arm64', 'x64'] as const) {
      const dir = mkdtempSync(path.join(tmpdir(), 'flowa-mac-feed-'))
      const zip = `Flowa-9.9.1-${arch}-mac.zip`
      writeFileSync(path.join(dir, zip), `zip ${arch}\n`)
      const written = await writeUpdateFeeds(dir, '9.9.1', macFeedOptions(arch, pair.privateKey))
      expect(written).toEqual(['latest-mac.yml'])
      const doc = yaml.load(readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8'))
      expect(doc.path).toBe(zip)
      expect(doc.files).toHaveLength(1)
      const digest = await sha256File(path.join(dir, zip))
      expect(verifySha256(pair.publicKey, digest, doc.files[0].ed25519)).toBe(true)
    }
  })

  it('keeps the ed25519 signature when the zip is tampered and the checksum is rewritten', async () => {
    const pair = generateUpdateKeyPair()
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-mac-tamper-'))
    const zip = 'Flowa-9.9.1-arm64-mac.zip'
    const full = path.join(dir, zip)
    writeFileSync(full, 'signed zip bytes')
    await writeUpdateFeeds(dir, '9.9.1', macFeedOptions('arm64', pair.privateKey))
    const yml = path.join(dir, 'latest-mac.yml')
    const signature = yaml.load(readFileSync(yml, 'utf8')).files[0].ed25519
    const data = readFileSync(full)
    data[data.length - 1] = data[data.length - 1] ^ 0xff
    writeFileSync(full, data)
    await rewriteChecksumKeepSignature(yml, full)
    const after = yaml.load(readFileSync(yml, 'utf8'))
    const hashed = createHash('sha512').update(data).digest('base64')
    expect(after.files[0].ed25519).toBe(signature)
    expect(after.files[0].sha512).toBe(hashed)
    expect(after.sha512).toBe(hashed)
    expect(verifySha256(pair.publicKey, await sha256File(full), after.files[0].ed25519)).toBe(false)
    const rehearsal = await verifyUpdateFeeds(dir, '9.9.1', {
      macArch: 'arm64',
      requireSignatures: true,
      publicKeyPem: pair.publicKey,
      requireBlockMaps: false
    })
    expect(rehearsal).toEqual(['Flowa-9.9.1-arm64-mac.zip: ed25519 mismatch'])
  })

  it('refuses to pass unless the install and the tamper rejection both happened', () => {
    const positive = 'booted 9.9.0 pid=1\ninstalling 9.9.1\nbooted 9.9.1 pid=2\n'
    const negative = 'booted 9.9.0 pid=3\nrejected\n'
    expect(() => assertMacRehearsal(positive, negative)).not.toThrow()
    expect(() => assertMacRehearsal(positive, '')).toThrow(/not rejected/)
    expect(() => assertMacRehearsal('booted 9.9.0 pid=1\n', negative)).toThrow(/did not install/)
    expect(() => assertMacRehearsal(positive, 'booted 9.9.0 pid=3\nrejected\nbooted 9.9.1 pid=4\n')).toThrow(/was installed/)
  })

  it('wires the Mac script so the success line follows both launches', () => {
    const src = readFileSync(path.resolve('scripts/e2e-update.mjs'), 'utf8')
    const macFn = src.slice(src.indexOf('async function mac('), src.indexOf('async function windows('))
    expect(macFn).toContain('macFeedOptions(arch, privateKey)')
    expect(macFn).toContain("run('ditto', [fromApp, stayApp])")
    expect(macFn.indexOf("launch('negative'")).toBeGreaterThan(macFn.indexOf("launch('positive'"))
    expect(macFn.indexOf('rejected a tampered zip')).toBeGreaterThan(macFn.indexOf('assertMacRehearsal(positive, negative)'))
    expect(macFn.match(/✓ Mac app/g)).toHaveLength(1)
    const release = readFileSync(path.resolve('scripts/build-release.sh'), 'utf8')
    const publish = readFileSync(path.resolve('scripts/publish-release.sh'), 'utf8')
    const feed = readFileSync(path.resolve('scripts/update-feed.mjs'), 'utf8')
    expect(release).not.toContain('macArch')
    expect(publish).not.toContain('macArch')
    expect(feed).toContain('writeUpdateFeeds(resolved, version, { privateKeyPem })')
  })
})
