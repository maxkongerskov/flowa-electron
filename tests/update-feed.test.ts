import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextVersion } from '../scripts/next-version.mjs'
import {
  channelForArtifact,
  hashFile,
  macArtifactGaps,
  macZipName,
  sortFeedFiles,
  verifyUpdateFeeds,
  writeUpdateFeeds
} from '../scripts/update-feed.mjs'

describe('next version', () => {
  it('bumps patch, minor, and major, and accepts an explicit version', () => {
    expect(nextVersion('1.2.1', 'patch')).toBe('1.2.2')
    expect(nextVersion('1.2.1', 'minor')).toBe('1.3.0')
    expect(nextVersion('1.2.1', 'major')).toBe('2.0.0')
    expect(nextVersion('1.2.0', '1.2.1')).toBe('1.2.1')
    expect(nextVersion('1.2.1', '1.2.1')).toBe('1.2.1')
  })

  it('rejects an older or unparseable version', () => {
    expect(() => nextVersion('1.2.1', '1.2.0')).toThrow(/older/)
    expect(() => nextVersion('1.2.1', 'beta')).toThrow(/patch, minor, major/)
    expect(() => nextVersion('1.2', 'patch')).toThrow(/major.minor.patch/)
  })
})

describe('update feed', () => {
  it('names the x64 zip so MacUpdater will not treat it as arm64', () => {
    expect(macZipName('1.2.1', 'arm64')).toBe('Flowa-1.2.1-arm64-mac.zip')
    expect(macZipName('1.2.1', 'x64')).toBe('Flowa-1.2.1-x64-mac.zip')
    expect(macZipName('1.2.1', 'x64').includes('arm64')).toBe(false)
    expect(channelForArtifact('Flowa-1.2.1-x64-mac.zip')).toBe('latest-mac.yml')
    expect(channelForArtifact('Flowa-Setup-1.2.1-x64.exe')).toBe('latest.yml')
    expect(channelForArtifact('Flowa-1.2.1.AppImage')).toBe('latest-linux.yml')
    expect(channelForArtifact('flowa_1.2.1_amd64.deb')).toBe('latest-linux.yml')
    expect(channelForArtifact('Flowa-1.2.1-arm64.AppImage')).toBe('latest-linux-arm64.yml')
    expect(channelForArtifact('latest-mac.yml')).toBeNull()
  })

  it('puts the updater archive first and the x64 file ahead of arm64', () => {
    expect(
      sortFeedFiles([
        'Flowa-1.2.1-arm64.dmg',
        'Flowa-1.2.1-arm64-mac.zip',
        'Flowa-1.2.1-x64.dmg',
        'Flowa-1.2.1-x64-mac.zip'
      ])
    ).toEqual([
      'Flowa-1.2.1-x64-mac.zip',
      'Flowa-1.2.1-arm64-mac.zip',
      'Flowa-1.2.1-x64.dmg',
      'Flowa-1.2.1-arm64.dmg'
    ])
  })

  it('writes sha512 and size from the final bytes, including both mac archs', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-feed-'))
    const files = [
      'Flowa-1.2.1-arm64-mac.zip',
      'Flowa-1.2.1-x64-mac.zip',
      'Flowa-1.2.1-arm64.dmg',
      'Flowa-1.2.1-x64.dmg',
      'Flowa-Setup-1.2.1-x64.exe',
      'Flowa-1.2.1.AppImage',
      'flowa_1.2.1_amd64.deb'
    ]
    for (const name of files) writeFileSync(path.join(dir, name), `bytes for ${name}\n`)
    writeFileSync(path.join(dir, 'Flowa-1.2.1-arm64.dmg.blockmap'), 'stale')

    const written = await writeUpdateFeeds(dir, '1.2.1', { releaseDate: '2026-10-19T18:00:00.000Z' })
    expect(written).toEqual(['latest-linux.yml', 'latest-mac.yml', 'latest.yml'])

    const mac = readFileSync(path.join(dir, 'latest-mac.yml'), 'utf8')
    expect(mac).toContain('version: 1.2.1')
    expect(mac).toContain('path: Flowa-1.2.1-x64-mac.zip')
    for (const name of files.filter((file) => file.endsWith('.zip') || file.endsWith('.dmg'))) {
      const buf = readFileSync(path.join(dir, name))
      const sha = createHash('sha512').update(buf).digest('base64')
      expect(mac).toContain(sha)
      expect(mac).toContain(`size: ${buf.length}`)
    }
    expect(readFileSync(path.join(dir, 'latest.yml'), 'utf8')).toContain('path: Flowa-Setup-1.2.1-x64.exe')
    const linux = readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8')
    expect(linux).toContain('path: Flowa-1.2.1.AppImage')
    expect(linux).toContain('flowa_1.2.1_amd64.deb')
    expect(await hashFile(path.join(dir, 'Flowa-1.2.1-x64-mac.zip'))).toEqual({
      sha512: createHash('sha512').update(readFileSync(path.join(dir, 'Flowa-1.2.1-x64-mac.zip'))).digest('base64'),
      size: readFileSync(path.join(dir, 'Flowa-1.2.1-x64-mac.zip')).length
    })

    writeFileSync(path.join(dir, 'Flowa-1.2.1-arm64.dmg'), 'stapled bytes differ\n')
    const errors = await verifyUpdateFeeds(dir, '1.2.1')
    expect(errors.some((line) => line.includes('Flowa-1.2.1-arm64.dmg'))).toBe(true)
  })

  it('demands both arches and both dmgs unless the rehearsal names one arch', async () => {
    const armOnly = mkdtempSync(path.join(tmpdir(), 'flowa-feed-arm-'))
    writeFileSync(path.join(armOnly, 'Flowa-9.9.1-arm64-mac.zip'), 'arm zip')
    await expect(
      writeUpdateFeeds(armOnly, '9.9.1', { blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
    ).rejects.toThrow('missing x64 updater zip\nmissing arm64 dmg\nmissing x64 dmg')
    expect(macArtifactGaps(['Flowa-9.9.1-arm64-mac.zip'])).toEqual([
      'missing x64 updater zip',
      'missing arm64 dmg',
      'missing x64 dmg'
    ])
    expect(macArtifactGaps(['Flowa-9.9.1-arm64-mac.zip'], 'arm64')).toEqual([])
    expect(macArtifactGaps(['Flowa-9.9.1-x64-mac.zip'], 'arm64')).toEqual(['missing arm64 updater zip'])
    expect(() => macArtifactGaps(['Flowa-9.9.1-arm64-mac.zip'], 'universal' as 'arm64')).toThrow(/unsupported mac arch/)

    const release = mkdtempSync(path.join(tmpdir(), 'flowa-feed-release-'))
    for (const name of [
      'Flowa-1.2.2-arm64-mac.zip',
      'Flowa-1.2.2-x64-mac.zip',
      'Flowa-1.2.2-arm64.dmg',
      'Flowa-1.2.2-x64.dmg'
    ]) {
      writeFileSync(path.join(release, name), name)
    }
    await expect(
      writeUpdateFeeds(release, '1.2.2', { blockMaps: false, releaseDate: '2026-10-20T00:00:00.000Z' })
    ).resolves.toEqual(['latest-mac.yml'])
    rmSync(path.join(release, 'Flowa-1.2.2-x64.dmg'))
    const gaps = await verifyUpdateFeeds(release, '1.2.2', { requireBlockMaps: false })
    expect(gaps).toContain('latest-mac.yml: missing Flowa-1.2.2-x64.dmg')
    expect(gaps).toContain('missing x64 dmg')
  })
})

describe('release script', () => {
  it('publishes only after a notarized build, and aborts the shell on any failure', () => {
    const release = readFileSync(path.resolve(process.cwd(), 'scripts/release.sh'), 'utf8')
    const build = readFileSync(path.resolve(process.cwd(), 'scripts/build-release.sh'), 'utf8')
    expect(release).toContain('set -euo pipefail')
    expect(build).toContain('set -euo pipefail')
    const testAt = release.indexOf('npm test')
    const e2eAt = release.indexOf('scripts/e2e-update')
    const buildAt = release.indexOf('FLOWA_REQUIRE_NOTARY=1')
    const tagAt = release.indexOf('git tag -a')
    const push = release.indexOf('git push -u origin HEAD')
    const publish = release.indexOf('bash scripts/publish-release.sh')
    expect(testAt).toBeGreaterThan(0)
    expect(e2eAt).toBeGreaterThan(testAt)
    expect(buildAt).toBeGreaterThan(e2eAt)
    expect(tagAt).toBeGreaterThan(buildAt)
    expect(push).toBeGreaterThan(tagAt)
    expect(publish).toBeGreaterThan(push)
    expect(build).toContain('ditto -c -k --keepParent')
    expect(build).toContain('node scripts/update-feed.mjs')
    expect(build.indexOf('app-update-yml.mjs write')).toBeLessThan(build.indexOf('scripts/sign-mac.sh'))
    expect(build).toContain('app-update-yml.mjs assert')
    expect(build).not.toContain('codesign --force --timestamp --sign "$SIGN_ID" "$ZIP"')
    expect(build.indexOf('stapler staple')).toBeLessThan(build.indexOf('node scripts/update-feed.mjs'))
    const publishScript = readFileSync(path.resolve(process.cwd(), 'scripts/publish-release.sh'), 'utf8')
    expect(publishScript).toContain('--draft')
    expect(publishScript).toContain('--draft=false')
    expect(publishScript).toContain('upload_one')
    expect(publishScript).not.toContain('"$OUT"/latest-linux-arm64.yml')
  })
})
