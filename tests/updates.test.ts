import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  UPDATE_CHECK_FAILED,
  UPDATE_CHECK_UNPACKAGED,
  UPDATE_REPOSITORY,
  assetDownloadUrl,
  buildUpdateOffer,
  compareSemver,
  formatReleaseNotes,
  interpretUpdateCheck,
  isFlowaReleaseUrl,
  isNewerVersion,
  pickInstallerName,
  releasePageUrl,
  type UpdateState
} from '@shared/updates'

const idle: UpdateState = { kind: 'idle' }
const base = { currentVersion: '1.2.0', platform: 'darwin', arch: 'arm64', previous: idle, manual: false, packaged: true }

describe('semver', () => {
  it('orders numeric components and ignores a v prefix and build metadata', () => {
    expect(compareSemver('1.2.0', '1.2.0')).toBe(0)
    expect(compareSemver('v1.2.0', '1.2.0+build.4')).toBe(0)
    expect(isNewerVersion('1.2.1', '1.2.0')).toBe(true)
    expect(isNewerVersion('1.10.0', '1.9.0')).toBe(true)
    expect(isNewerVersion('1.2.0', '1.2.1')).toBe(false)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
  })

  it('treats a prerelease as older than the final release', () => {
    expect(isNewerVersion('1.3.0-beta.1', '1.2.0')).toBe(true)
    expect(isNewerVersion('1.2.0-beta', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2.0', '1.2.0-beta.2')).toBe(true)
    expect(isNewerVersion('1.2.0-beta.2', '1.2.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.2.0-rc.1', '1.2.0-beta.9')).toBe(true)
  })

  it('does not treat an unparseable version as newer', () => {
    expect(isNewerVersion('latest', '1.2.0')).toBe(false)
    expect(isNewerVersion('1.2', '1.2.0')).toBe(false)
  })
})

describe('installer link', () => {
  it('points at flowa-electron, not the homepage repo', () => {
    expect(releasePageUrl('v1.3.0')).toBe('https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.3.0')
    expect(assetDownloadUrl('1.3.0', 'Flowa-1.3.0-arm64.dmg')).toBe(
      'https://github.com/maxkongerskov/flowa-electron/releases/download/v1.3.0/Flowa-1.3.0-arm64.dmg'
    )
    expect(isFlowaReleaseUrl(releasePageUrl('1.3.0'))).toBe(true)
    expect(isFlowaReleaseUrl('http://github.com/maxkongerskov/flowa-electron/releases/tag/v1.3.0')).toBe(false)
    expect(isFlowaReleaseUrl('https://github.com/maxkongerskov/Flowa/releases/tag/v1.3.0')).toBe(false)
    expect(isFlowaReleaseUrl('https://example.com')).toBe(false)
  })

  it('offers the arm64 dmg even when latest-mac.yml only listed x64', () => {
    const name = pickInstallerName('darwin', 'arm64', '1.3.0', ['Flowa-1.3.0-x64.dmg'])
    expect(name).toBe('Flowa-1.3.0-arm64.dmg')
  })

  it('uses the channel file when it names the right asset', () => {
    expect(pickInstallerName('darwin', 'x64', '1.3.0', ['https://github.com/maxkongerskov/flowa-electron/releases/download/v1.3.0/Flowa-1.3.0-x64.dmg'])).toBe(
      'Flowa-1.3.0-x64.dmg'
    )
    expect(pickInstallerName('win32', 'x64', '1.3.0', ['Flowa-Setup-1.3.0-x64.exe'])).toBe('Flowa-Setup-1.3.0-x64.exe')
    expect(pickInstallerName('linux', 'x64', '1.3.0', ['Flowa-1.3.0.AppImage', 'flowa_1.3.0_amd64.deb'])).toBe('Flowa-1.3.0.AppImage')
  })

  it('does not invent an installer for an unpublished arch', () => {
    expect(pickInstallerName('win32', 'arm64', '1.3.0', ['Flowa-Setup-1.3.0-x64.exe'])).toBeNull()
    expect(pickInstallerName('linux', 'arm64', '1.3.0', ['Flowa-1.3.0.AppImage', 'flowa_1.3.0_amd64.deb'])).toBeNull()
    expect(pickInstallerName('linux', 'arm64', '1.3.0', ['Flowa-1.3.0-arm64.AppImage'])).toBe('Flowa-1.3.0-arm64.AppImage')
  })

  it('ignores blockmaps', () => {
    expect(pickInstallerName('darwin', 'x64', '1.3.0', ['Flowa-1.3.0-x64.dmg.blockmap'])).toBe('Flowa-1.3.0-x64.dmg')
  })
})

describe('release notes', () => {
  it('flattens GitHub HTML and truncates', () => {
    const html = '<p>Customizable dictation shortcut.</p><ul><li>macOS dmg</li><li>Windows exe</li></ul>'
    expect(formatReleaseNotes(html)).toBe('Customizable dictation shortcut. macOS dmg Windows exe')
    const long = `<p>${'word '.repeat(80)}</p>`
    const notes = formatReleaseNotes(long)
    expect(notes.endsWith('…')).toBe(true)
    expect(notes.length).toBeLessThanOrEqual(220)
  })

  it('joins electron-updater note lists', () => {
    expect(formatReleaseNotes([{ version: '1.3.0', note: 'Faster paste.' }, { version: '1.2.1', note: null }])).toBe('Faster paste.')
  })
})

describe('interpretUpdateCheck', () => {
  const files = ['Flowa-1.3.0-x64.dmg', 'Flowa-1.3.0-arm64.dmg']

  it('surfaces a newer packaged release and ignores the same version', () => {
    const available = interpretUpdateCheck({
      ...base,
      outcome: { ok: true, isUpdateAvailable: true, info: { version: '1.3.0', notes: '<p>Shorter startup.</p>', files } }
    })
    expect(available).toMatchObject({
      kind: 'available',
      version: '1.3.0',
      notes: 'Shorter startup.',
      releaseUrl: 'https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.3.0',
      downloadName: 'Flowa-1.3.0-arm64.dmg',
      downloadUrl: 'https://github.com/maxkongerskov/flowa-electron/releases/download/v1.3.0/Flowa-1.3.0-arm64.dmg'
    })
    expect(
      interpretUpdateCheck({
        ...base,
        outcome: { ok: true, isUpdateAvailable: false, info: { version: '1.2.0', files } }
      })
    ).toEqual({ kind: 'idle' })
    expect(
      interpretUpdateCheck({
        ...base,
        manual: true,
        outcome: { ok: true, isUpdateAvailable: false, info: { version: 'v1.2.0', files } }
      })
    ).toEqual({ kind: 'current' })
  })

  it('does not surface an older release', () => {
    expect(
      interpretUpdateCheck({
        ...base,
        manual: true,
        outcome: { ok: true, isUpdateAvailable: true, info: { version: '1.1.0', notes: 'old', files } }
      })
    ).toEqual({ kind: 'current' })
  })

  it('keeps dictation quiet when a launch check fails', () => {
    expect(interpretUpdateCheck({ ...base, outcome: { ok: false } })).toEqual({ kind: 'idle' })
    expect(interpretUpdateCheck({ ...base, outcome: { ok: true, info: null, isUpdateAvailable: false } })).toEqual({ kind: 'idle' })
    const previous: UpdateState = {
      kind: 'available',
      version: '1.3.0',
      notes: 'Shorter startup.',
      releaseUrl: releasePageUrl('1.3.0'),
      downloadUrl: null,
      downloadName: null
    }
    expect(interpretUpdateCheck({ ...base, previous, outcome: { ok: false } })).toEqual(previous)
  })

  it('explains a manual check without blocking', () => {
    expect(interpretUpdateCheck({ ...base, packaged: false, manual: true, outcome: { ok: false } })).toEqual({
      kind: 'skipped',
      message: UPDATE_CHECK_UNPACKAGED
    })
    expect(interpretUpdateCheck({ ...base, packaged: false, manual: false, outcome: { ok: false } })).toEqual(idle)
    expect(interpretUpdateCheck({ ...base, manual: true, outcome: { ok: false } })).toEqual({
      kind: 'error',
      message: UPDATE_CHECK_FAILED
    })
  })

  it('falls back to the release page when no installer matches', () => {
    const offer = buildUpdateOffer({
      currentVersion: '1.2.0',
      latestVersion: '1.3.0',
      notes: '',
      files: ['Flowa-1.3.0.AppImage'],
      platform: 'linux',
      arch: 'arm64'
    })
    expect(offer).toMatchObject({ kind: 'available', downloadUrl: null, downloadName: null })
    expect(offer?.releaseUrl).toContain(`/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/`)
  })
})

describe('electron-builder publish', () => {
  it('targets maxkongerskov/flowa-electron', () => {
    const yml = readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/provider:\s*github/)
    expect(yml).toContain(`owner: ${UPDATE_REPOSITORY.owner}`)
    expect(yml).toContain(`repo: ${UPDATE_REPOSITORY.repo}`)
    expect(yml).not.toContain('repo: Flowa')
  })
})
