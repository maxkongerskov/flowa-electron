// Check → download with progress → quitAndInstall.
// autoDownload stays off until the user clicks Download. The updater zip is
// never opened in a browser. Unsigned macOS builds and unsupported packages
// keep the public installer link (dmg / exe / AppImage / deb).

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { app, shell } from 'electron'
import type { AppUpdater, ProgressInfo, UpdateInfo } from 'electron-updater'
import {
  UPDATE_REPOSITORY,
  installKindForRuntime,
  interpretUpdateCheck,
  isFlowaReleaseUrl,
  noteDownloadComplete,
  noteDownloadFailed,
  noteDownloadProgress,
  noteInstall,
  startDownload,
  type UpdateCheckOutcome,
  type UpdateInstallKind,
  type UpdateState
} from '@shared/updates'

type UpdaterModule = { autoUpdater: AppUpdater }

const DOWNLOAD_FAILED = "Couldn't download the update. You can download it from the release page."

const log = {
  info: (message?: unknown): void => console.log(`[Flowa] ${message ?? ''}`),
  warn: (message?: unknown): void => console.warn(`[Flowa] ${message ?? ''}`),
  error: (message?: unknown): void => console.warn(`[Flowa] ${message ?? ''}`)
}

export class UpdateChecker {
  state: UpdateState = { kind: 'idle' }
  private readonly onChange: () => void
  private pending: Promise<void> | null = null
  private downloadTask: Promise<void> | null = null
  private updater: AppUpdater | null = null
  private installStarted = false

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  check(manual: boolean): Promise<void> {
    if (this.state.kind === 'downloading' || this.state.kind === 'downloaded' || this.state.kind === 'installing') return Promise.resolve()
    if (this.pending) return this.pending
    const run = this.run(manual).finally(() => {
      this.pending = null
    })
    this.pending = run
    return run
  }

  /** Drop a manual "up to date" / error note. An available update stays put. */
  dismissNote(): void {
    if (this.state.kind === 'current' || this.state.kind === 'error' || this.state.kind === 'skipped') {
      this.state = { kind: 'idle' }
      this.onChange()
    }
  }

  /**
   * Download starts the in-app install when this build can apply it.
   * Otherwise the public installer (never the updater zip) opens in the browser.
   */
  accept(): void {
    if (this.state.kind === 'available' && this.state.autoInstall) {
      void this.download()
      return
    }
    this.open()
  }

  /** Open the public installer URL, or the release page when we can't name the asset. */
  open(): void {
    if (this.state.kind !== 'available') return
    const url = this.state.downloadUrl ?? this.state.releaseUrl
    if (!isFlowaReleaseUrl(url)) {
      console.warn('[Flowa] refused to open update url')
      return
    }
    void shell.openExternal(url)
  }

  private async download(): Promise<void> {
    if (this.downloadTask) return this.downloadTask
    if (this.state.kind !== 'available' || !this.state.autoInstall) return
    const task = this.runDownload().finally(() => {
      this.downloadTask = null
    })
    this.downloadTask = task
    return task
  }

  private async runDownload(): Promise<void> {
    const next = startDownload(this.state)
    if (next.kind !== 'downloading') return
    this.state = next
    this.onChange()
    try {
      const updater = await this.prepare()
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = true
      updater.autoRunAppAfterInstall = true
      await updater.downloadUpdate()
      if (this.state.kind === 'downloading') {
        this.state = noteDownloadComplete(this.state)
        this.onChange()
        this.install()
      }
    } catch (err) {
      console.warn('[Flowa] update download failed:', err instanceof Error ? err.message : err)
      if (this.state.kind === 'downloading' || this.state.kind === 'downloaded' || this.state.kind === 'installing') {
        this.state = noteDownloadFailed(this.state, DOWNLOAD_FAILED)
        this.onChange()
      }
    }
  }

  private install(): void {
    if (this.installStarted) return
    const next = noteInstall(this.state)
    if (next.kind !== 'installing') return
    this.installStarted = true
    this.state = next
    this.onChange()
    // Silent NSIS (/S) plus relaunch. MacUpdater ignores the flags and uses
    // autoRunAppAfterInstall, which was set before the download finished.
    this.updater?.quitAndInstall(true, true)
  }

  private async run(manual: boolean): Promise<void> {
    const previous = this.state
    const kind = this.installKind()
    if (!app.isPackaged) {
      this.apply(
        interpretUpdateCheck({
          packaged: false,
          manual,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          previous,
          outcome: { ok: false },
          installKind: kind
        }),
        previous
      )
      return
    }
    if (manual && previous.kind !== 'available') {
      this.state = { kind: 'checking' }
      this.onChange()
    }
    let outcome: UpdateCheckOutcome
    try {
      const updater = await this.prepare()
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.autoRunAppAfterInstall = true
      const checked = await updater.checkForUpdates()
      outcome = outcomeFrom(checked)
    } catch (err) {
      console.warn('[Flowa] update check failed:', err instanceof Error ? err.message : err)
      outcome = { ok: false }
    }
    this.apply(
      interpretUpdateCheck({
        packaged: true,
        manual,
        currentVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        previous,
        outcome,
        installKind: kind
      }),
      previous
    )
  }

  private installKind(): UpdateInstallKind | null {
    return installKindForRuntime({
      platform: process.platform,
      packaged: app.isPackaged,
      codesignInfo: process.platform === 'darwin' && app.isPackaged ? readMacCodesign() : '',
      appImagePath: process.env.APPIMAGE ?? null,
      linuxPackageType: process.platform === 'linux' ? readLinuxPackageType() : null
    })
  }

  private async prepare(): Promise<AppUpdater> {
    if (this.updater) return this.updater
    const mod = (await import('electron-updater')) as UpdaterModule & { default?: UpdaterModule }
    const updater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!updater) throw new Error('electron-updater unavailable')
    updater.logger = log
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = true
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.disableWebInstaller = true
    updater.setFeedURL({
      provider: 'github',
      owner: UPDATE_REPOSITORY.owner,
      repo: UPDATE_REPOSITORY.repo
    })
    // Registered before any download so electron-updater emits progress.
    updater.on('download-progress', (progress: ProgressInfo) => {
      this.state = noteDownloadProgress(this.state, {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      })
      this.onChange()
    })
    updater.on('update-downloaded', () => {
      this.state = noteDownloadComplete(this.state)
      this.onChange()
      this.install()
    })
    updater.on('error', (err) => {
      if (this.state.kind !== 'downloading' && this.state.kind !== 'downloaded' && this.state.kind !== 'installing') return
      console.warn('[Flowa] updater error:', err instanceof Error ? err.message : err)
      this.state = noteDownloadFailed(this.state, DOWNLOAD_FAILED)
      this.onChange()
    })
    this.updater = updater
    return updater
  }

  private apply(next: UpdateState, previous: UpdateState): void {
    if (sameUpdate(previous, next) && sameUpdate(this.state, next)) return
    this.state = next
    if (next.kind === 'available') console.log(`[Flowa] update available: ${next.version} autoInstall=${next.autoInstall}`)
    this.onChange()
  }
}

function readMacCodesign(): string {
  const bundle = path.resolve(process.execPath, '..', '..', '..')
  const result = spawnSync('codesign', ['-dv', '--verbose=4', bundle], { encoding: 'utf8' })
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

function readLinuxPackageType(): string | null {
  try {
    return readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8')
  } catch {
    return null
  }
}

function outcomeFrom(checked: { isUpdateAvailable: boolean; updateInfo: UpdateInfo } | null): UpdateCheckOutcome {
  if (!checked?.updateInfo?.version) return { ok: true, info: null, isUpdateAvailable: false }
  const files = [
    ...(checked.updateInfo.files ?? []).map((file) => file.url),
    checked.updateInfo.path
  ].filter((url): url is string => typeof url === 'string' && url.length > 0)
  return {
    ok: true,
    isUpdateAvailable: checked.isUpdateAvailable,
    info: {
      version: checked.updateInfo.version,
      notes: checked.updateInfo.releaseNotes,
      files
    }
  }
}

function sameUpdate(a: UpdateState, b: UpdateState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'available' && b.kind === 'available') {
    return (
      a.version === b.version &&
      a.notes === b.notes &&
      a.downloadUrl === b.downloadUrl &&
      a.releaseUrl === b.releaseUrl &&
      a.autoInstall === b.autoInstall
    )
  }
  if (a.kind === 'downloading' && b.kind === 'downloading') {
    return a.version === b.version && Math.round(a.percent) === Math.round(b.percent) && a.total === b.total
  }
  if ((a.kind === 'downloaded' || a.kind === 'installing') && a.kind === b.kind) return a.version === b.version
  if ((a.kind === 'error' || a.kind === 'skipped') && (b.kind === 'error' || b.kind === 'skipped')) return a.message === b.message
  return true
}
