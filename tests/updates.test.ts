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
  formatDownloadProgress,
  formatReleaseNotes,
  installKindForRuntime,
  interpretUpdateCheck,
  isFlowaReleaseUrl,
  isNewerVersion,
  macDeveloperIdSigned,
  noteDownloadComplete,
  noteDownloadFailed,
  noteDownloadProgress,
  noteInstall,
  pickInstallerName,
  releasePageUrl,
  startDownload,
  updaterAssetName,
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
  it('points at flowa-electron', () => {
    expect(UPDATE_REPOSITORY).toEqual({ owner: 'maxkongerskov', repo: 'flowa-electron' })
    expect(releasePageUrl('v1.3.0')).toBe('https://github.com/maxkongerskov/flowa-electron/releases/tag/v1.3.0')
    expect(assetDownloadUrl('1.3.0', 'Flowa-1.3.0-arm64.dmg')).toBe(
      'https://github.com/maxkongerskov/flowa-electron/releases/download/v1.3.0/Flowa-1.3.0-arm64.dmg'
    )
    expect(isFlowaReleaseUrl(releasePageUrl('1.3.0'))).toBe(true)
    expect(isFlowaReleaseUrl('https://github.com/maxkongerskov/flowa-electron/releases/download/v1.2.3/Flowa-1.2.3.AppImage')).toBe(true)
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
      downloadName: null,
      autoInstall: false
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

describe('in-app install', () => {
  const macFiles = [
    'Flowa-1.3.0-arm64-mac.zip',
    'Flowa-1.3.0-x64-mac.zip',
    'Flowa-1.3.0-arm64.dmg',
    'Flowa-1.3.0-x64.dmg'
  ]

  it('recognises a Developer ID signature and refuses an ad-hoc one', () => {
    expect(macDeveloperIdSigned('Authority=Developer ID Application: Max Køngerskov (TEAM)')).toBe(true)
    expect(macDeveloperIdSigned('Signature=adhoc\nAuthority=Developer ID Application: Nobody')).toBe(false)
    expect(macDeveloperIdSigned('Signature=adhoc')).toBe(false)
    expect(installKindForRuntime({ platform: 'darwin', packaged: true, codesignInfo: 'Authority=Developer ID Application: Max (T)' })).toBe('mac-zip')
    expect(installKindForRuntime({ platform: 'darwin', packaged: true, codesignInfo: 'Signature=adhoc' })).toBeNull()
    expect(installKindForRuntime({ platform: 'darwin', packaged: false, codesignInfo: 'Authority=Developer ID Application: Max (T)' })).toBeNull()
    expect(installKindForRuntime({ platform: 'win32', packaged: true })).toBe('nsis')
    expect(installKindForRuntime({ platform: 'linux', packaged: true, appImagePath: '/tmp/Flowa.AppImage' })).toBe('appimage')
    expect(installKindForRuntime({ platform: 'linux', packaged: true, linuxPackageType: 'deb\n' })).toBe('deb')
    expect(installKindForRuntime({ platform: 'linux', packaged: true })).toBeNull()
  })

  it('downloads the zip in-app and links the dmg, never the zip', () => {
    const offer = buildUpdateOffer({
      currentVersion: '1.2.1',
      latestVersion: '1.3.0',
      notes: 'Shorter startup.',
      files: macFiles,
      platform: 'darwin',
      arch: 'arm64',
      installKind: 'mac-zip'
    })
    expect(offer).toMatchObject({
      kind: 'available',
      version: '1.3.0',
      autoInstall: true,
      downloadName: 'Flowa-1.3.0-arm64.dmg'
    })
    expect(offer?.downloadName?.endsWith('.zip')).toBe(false)
    expect(updaterAssetName('mac-zip', macFiles, 'arm64')).toBe('Flowa-1.3.0-arm64-mac.zip')
    expect(updaterAssetName('mac-zip', macFiles, 'x64')).toBe('Flowa-1.3.0-x64-mac.zip')
    expect(updaterAssetName('mac-zip', macFiles, 'x64')?.includes('arm64')).toBe(false)
  })

  it('opens the dmg when the mac build is unsigned', () => {
    const offer = buildUpdateOffer({
      currentVersion: '1.2.1',
      latestVersion: '1.3.0',
      notes: '',
      files: macFiles,
      platform: 'darwin',
      arch: 'x64',
      installKind: null
    })
    expect(offer).toMatchObject({ autoInstall: false, downloadName: 'Flowa-1.3.0-x64.dmg' })
    expect(startDownload(offer!)).toEqual(offer)
  })

  it('auto-installs Windows NSIS and Linux AppImage, and a deb package', () => {
    expect(
      buildUpdateOffer({
        currentVersion: '1.2.1',
        latestVersion: '1.3.0',
        notes: '',
        files: ['Flowa-Setup-1.3.0-x64.exe'],
        platform: 'win32',
        arch: 'x64',
        installKind: 'nsis'
      })
    ).toMatchObject({ autoInstall: true, downloadName: 'Flowa-Setup-1.3.0-x64.exe' })
    const linuxFiles = ['Flowa-1.3.0.AppImage', 'flowa_1.3.0_amd64.deb']
    expect(
      buildUpdateOffer({
        currentVersion: '1.2.1',
        latestVersion: '1.3.0',
        notes: '',
        files: linuxFiles,
        platform: 'linux',
        arch: 'x64',
        installKind: 'appimage'
      })
    ).toMatchObject({ autoInstall: true, downloadName: 'Flowa-1.3.0.AppImage' })
    expect(
      buildUpdateOffer({
        currentVersion: '1.2.1',
        latestVersion: '1.3.0',
        notes: '',
        files: linuxFiles,
        platform: 'linux',
        arch: 'x64',
        installKind: 'deb'
      })
    ).toMatchObject({ autoInstall: true, downloadName: 'flowa_1.3.0_amd64.deb' })
    expect(
      buildUpdateOffer({
        currentVersion: '1.2.1',
        latestVersion: '1.3.0',
        notes: '',
        files: linuxFiles,
        platform: 'linux',
        arch: 'x64',
        installKind: null
      })
    ).toMatchObject({ autoInstall: false, downloadName: 'Flowa-1.3.0.AppImage' })
  })

  it('walks check → download progress → downloaded → install, and a failed download keeps the public link', () => {
    const offer = buildUpdateOffer({
      currentVersion: '1.2.1',
      latestVersion: '1.3.0',
      notes: 'Shorter startup.',
      files: macFiles,
      platform: 'darwin',
      arch: 'arm64',
      installKind: 'mac-zip'
    })!
    let state: UpdateState = startDownload(offer)
    expect(state.kind).toBe('downloading')
    state = noteDownloadProgress(state, { percent: 41.2, transferred: 12 * 1024 * 1024, total: 20 * 1024 * 1024 })
    expect(state).toMatchObject({ kind: 'downloading', percent: 41.2, total: 20 * 1024 * 1024 })
    expect(formatDownloadProgress({ percent: 41.2, transferred: 12 * 1024 * 1024, total: 20 * 1024 * 1024 })).toBe('41% · 12 MB of 20 MB')
    state = noteDownloadComplete(state)
    expect(state.kind).toBe('downloaded')
    state = noteInstall(state)
    expect(state).toMatchObject({ kind: 'installing', version: '1.3.0', autoInstall: true })
    expect(interpretUpdateCheck({ ...base, currentVersion: '1.2.1', previous: state, outcome: { ok: false } })).toEqual(state)
    const failed = noteDownloadFailed(
      noteDownloadProgress(offer, { percent: 10, transferred: 1, total: 10 }),
      'Could not download.'
    )
    expect(failed).toMatchObject({
      kind: 'available',
      autoInstall: false,
      notes: 'Could not download.',
      downloadName: 'Flowa-1.3.0-arm64.dmg'
    })
  })
})

describe('electron-builder publish', () => {
  it('targets maxkongerskov/flowa-electron', () => {
    const yml = readFileSync(resolve(process.cwd(), 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/provider:\s*github/)
    expect(yml).toContain(`owner: ${UPDATE_REPOSITORY.owner}`)
    expect(yml).toContain('repo: flowa-electron')
    expect(yml).not.toContain('repo: Flowa')
    const appUpdate = readFileSync(resolve(process.cwd(), 'scripts/app-update-yml.mjs'), 'utf8')
    expect(appUpdate).toContain(`repo: '${UPDATE_REPOSITORY.repo}'`)
  })
})
