import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { generateUpdateKeyPair } from '../scripts/update-trust.mjs'
import {
  patchInstalledMainBundle,
  patchInstalledResources,
  publicKeyBody,
  RELEASE_122_PUBLIC_KEY_B64,
  renderGenericAppUpdateYml,
  squashfsOffset
} from '../scripts/patch-installed-feed.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as {
  createPackage: (src: string, dest: string) => Promise<void>
  extractAll: (archive: string, dest: string) => void
}

const excerpt = readFileSync('tests/fixtures/flowa-1.2.2-updater-excerpt.js', 'utf8')

describe('installed 1.2.2 feed patch', () => {
  it('points the bundle at app-update.yml and a replacement key', () => {
    const pair = generateUpdateKeyPair()
    const body = publicKeyBody(pair.publicKey)
    const patched = patchInstalledMainBundle(excerpt, { publicKeyPem: pair.publicKey })
    expect(patched).not.toContain(RELEASE_122_PUBLIC_KEY_B64)
    expect(patched).toContain(body)
    expect(patched).not.toContain('updater.setFeedURL({\n        provider: "github"')
    expect(patched).toContain('using app-update.yml')
    expect(patched).toContain('if (next.kind === "available" && next.autoInstall) void this.download();')
    expect(patched).not.toContain('e2eAutoUpdate()')
    expect(renderGenericAppUpdateYml('http://127.0.0.1:9')).toBe(
      'provider: generic\nurl: http://127.0.0.1:9/\nupdaterCacheDirName: flowa-updater\n'
    )
    expect(() => renderGenericAppUpdateYml('https://127.0.0.1:9/')).toThrow(/http/)
    expect(() => renderGenericAppUpdateYml('http://github.com/maxkongerskov/flowa-electron/')).toThrow(/localhost/)
  })

  it('can keep the real public key and the click-to-download gate', () => {
    const patched = patchInstalledMainBundle(excerpt, { keepPublicKey: true, manualDownload: true })
    expect(patched).toContain(RELEASE_122_PUBLIC_KEY_B64)
    expect(patched).toContain('e2eAutoUpdate()')
    expect(patched).toContain('using app-update.yml')
  })

  it('rewrites an installed app.asar', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'flowa-patch-'))
    const resources = path.join(root, 'resources')
    const unpacked = path.join(root, 'unpacked')
    const mainDir = path.join(unpacked, 'out', 'main')
    require('node:fs').mkdirSync(mainDir, { recursive: true })
    require('node:fs').mkdirSync(resources, { recursive: true })
    writeFileSync(path.join(mainDir, 'index.js'), excerpt)
    const asarPath = path.join(resources, 'app.asar')
    await asar.createPackage(unpacked, asarPath)
    const pair = generateUpdateKeyPair()
    await patchInstalledResources(resources, { feedUrl: 'http://127.0.0.1:4321/', publicKeyPem: pair.publicKey })
    const yml = readFileSync(path.join(resources, 'app-update.yml'), 'utf8')
    expect(yml).toContain('url: http://127.0.0.1:4321/')
    const again = path.join(root, 'again')
    asar.extractAll(asarPath, again)
    const source = readFileSync(path.join(again, 'out', 'main', 'index.js'), 'utf8')
    expect(source).toContain(publicKeyBody(pair.publicKey))
    expect(source).toContain('using app-update.yml')
    rmSync(root, { recursive: true, force: true })
  })

  it('finds a squashfs header after the runtime prefix', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'flowa-sq-')), 'app.AppImage')
    writeFileSync(file, Buffer.concat([Buffer.alloc(32, 1), Buffer.from('hsqs'), Buffer.from('rest')]))
    expect(squashfsOffset(file)).toBe(32)
  })
})
