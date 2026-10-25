import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BAR_CRASH_MESSAGE, crashReply } from '@shared/barCrash'
import { corruptPrefsBackupName, corruptPrefsMessage } from '@shared/prefsRecovery'
import { continueQueue } from '@shared/queue'
import {
  e2eAllowsUnsigned,
  e2eFeedUrl,
  generateUpdateKeyPair,
  sha256,
  publicKeyFromPrivate,
  signSha256,
  updateSignatureDecision,
  verifySha256
} from '@shared/updateTrust'
import { assertAppUpdateYml, writeAppUpdateYml } from '../scripts/app-update-yml.mjs'
import { signSha256 as scriptSign, verifySha256 as scriptVerify } from '../scripts/update-trust.mjs'
import { verifyUpdateFeeds, writeUpdateFeeds } from '../scripts/update-feed.mjs'

describe('update signatures', () => {
  it('accepts a matching ed25519 signature and rejects tampering or a missing key', () => {
    const { publicKey, privateKey } = generateUpdateKeyPair()
    const digest = sha256('flowa')
    const signature = signSha256(privateKey, digest)
    expect(verifySha256(publicKey, digest, signature)).toBe(true)
    expect(scriptVerify(publicKey, digest, scriptSign(privateKey, digest))).toBe(true)
    expect(verifySha256(publicKey, digest, scriptSign(privateKey, digest))).toBe(true)
    expect(updateSignatureDecision({ publicKeyPem: publicKey, digest, signature })).toBe('ok')
    expect(updateSignatureDecision({ publicKeyPem: publicKey, digest: sha256('other'), signature })).toBe('rejected')
    expect(updateSignatureDecision({ publicKeyPem: '', digest, signature })).toBe('rejected')
    expect(updateSignatureDecision({ publicKeyPem: publicKey, digest, signature: null })).toBe('rejected')
    expect(updateSignatureDecision({ publicKeyPem: '', digest, signature: null, allowUnsigned: true })).toBe('ok')
  })

  it('ignores the test feed and the unsigned bypass unless the build is an e2e build', () => {
    const env = {
      FLOWA_UPDATE_FEED: 'http://127.0.0.1:9/feed',
      FLOWA_E2E_ALLOW_UNSIGNED: '1',
      FLOWA_UPDATE_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n'
    }
    expect(e2eFeedUrl(env, false)).toBeNull()
    expect(e2eAllowsUnsigned(env, false)).toBe(false)
    expect(e2eFeedUrl(env, true)).toBe('http://127.0.0.1:9/feed/')
    expect(e2eFeedUrl({ FLOWA_UPDATE_FEED: 'https://example.com/' }, true)).toBeNull()
    expect(e2eAllowsUnsigned(env, true)).toBe(true)
  })

  it('writes an ed25519 field the feed check can reject after the bytes change', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flowa-feed-'))
    try {
      const name = 'flowa_9.9.1_amd64.deb'
      writeFileSync(path.join(dir, name), 'package-bytes')
      const { privateKey } = generateUpdateKeyPair()
      await writeUpdateFeeds(dir, '9.9.1', { privateKeyPem: privateKey, blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
      const yml = readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8')
      expect(yml).toContain('ed25519:')
      expect(await verifyUpdateFeeds(dir, '9.9.1', { requireSignatures: true, publicKeyPem: publicKeyFromPrivate(privateKey) })).toEqual([])
      writeFileSync(path.join(dir, name), 'tampered')
      const errors = await verifyUpdateFeeds(dir, '9.9.1', {
        requireSignatures: true,
        publicKeyPem: publicKeyFromPrivate(privateKey)
      })
      expect(errors.some((line) => line.includes('ed25519') || line.includes('sha512'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('app-update.yml', () => {
  it('writes the github feed electron-updater reads back', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'flowa-yml-'))
    try {
      writeAppUpdateYml(dir)
      expect(assertAppUpdateYml(dir)).toContain('app-update.yml')
      writeFileSync(path.join(dir, 'app-update.yml'), 'provider: generic\n')
      expect(() => assertAppUpdateYml(dir)).toThrow(/provider/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('everyday fixes', () => {
  it('names a prefs backup and tells the user', () => {
    const name = corruptPrefsBackupName(new Date('2026-10-20T12:00:00.000Z'))
    expect(name).toBe('prefs.json.corrupt-2026-10-20T12-00-00-000Z')
    expect(corruptPrefsMessage(name)).toContain(name)
    expect(corruptPrefsMessage(name)).toContain('reset')
  })

  it('answers a crashed dictation bar without blaming the microphone', () => {
    expect(crashReply('capture:start')).toEqual({ ok: false, message: BAR_CRASH_MESSAGE })
    expect(crashReply('capture:stop')).toBeNull()
    expect(BAR_CRASH_MESSAGE.toLowerCase()).not.toContain('microphone')
  })

  it('keeps the transcription queue alive after a job throws', async () => {
    const seen: string[] = []
    const queue = continueQueue(Promise.resolve(), async () => {
      throw new Error('decode failed')
    }, (err) => seen.push(err instanceof Error ? err.message : String(err)))
    await queue
    await continueQueue(queue, async () => { seen.push('next') }, () => {})
    expect(seen).toEqual(['decode failed', 'next'])
  })

})

describe('release packaging', () => {
  it('keeps both Whisper models in the release installer config', () => {
    const config = readFileSync('electron-builder.release.cjs', 'utf8')
    expect(config).toContain('ggml-large-v3-turbo.bin')
    expect(config).toContain('ggml-small.bin')
    const release = readFileSync('scripts/build-release.sh', 'utf8')
    expect(release).toContain('whisper-server-vulkan/whisper-server')
    expect(release).toContain('whisper-server-vulkan/whisper-server.exe')
    expect(release).toContain('libwhisper.so.1')
    expect(release).toContain('whisper.dll')
  })
})
