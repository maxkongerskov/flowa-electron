// Launch-time (and manual) update check via electron-updater.
// The app is unsigned, so this never downloads or swaps the running binary.
// autoDownload and autoInstallOnAppQuit stay off; the banner opens the
// GitHub release or the matching installer in the user's browser.

import { app, shell } from 'electron'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import {
  UPDATE_REPOSITORY,
  interpretUpdateCheck,
  isFlowaReleaseUrl,
  type UpdateCheckOutcome,
  type UpdateState
} from '@shared/updates'

type UpdaterModule = { autoUpdater: AppUpdater }

const log = {
  info: (message?: unknown): void => console.log(`[Flowa] ${message ?? ''}`),
  warn: (message?: unknown): void => console.warn(`[Flowa] ${message ?? ''}`),
  error: (message?: unknown): void => console.warn(`[Flowa] ${message ?? ''}`)
}

export class UpdateChecker {
  state: UpdateState = { kind: 'idle' }
  private readonly onChange: () => void
  private pending: Promise<void> | null = null
  private updater: AppUpdater | null = null

  constructor(onChange: () => void) {
    this.onChange = onChange
  }

  check(manual: boolean): Promise<void> {
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

  /** Open the installer URL, or the release page when we can't name the asset. */
  open(): void {
    if (this.state.kind !== 'available') return
    const url = this.state.downloadUrl ?? this.state.releaseUrl
    if (!isFlowaReleaseUrl(url)) {
      console.warn('[Flowa] refused to open update url')
      return
    }
    void shell.openExternal(url)
  }

  private async run(manual: boolean): Promise<void> {
    const previous = this.state
    if (!app.isPackaged) {
      this.apply(
        interpretUpdateCheck({
          packaged: false,
          manual,
          currentVersion: app.getVersion(),
          platform: process.platform,
          arch: process.arch,
          previous,
          outcome: { ok: false }
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
      // Flags are set again here so a future edit cannot quietly turn install back on.
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.autoRunAppAfterInstall = false
      const checked = await updater.checkForUpdates()
      if (checked?.downloadPromise) {
        console.warn('[Flowa] updater started a download; it will not be installed')
      }
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
        outcome
      }),
      previous
    )
  }

  private async prepare(): Promise<AppUpdater> {
    if (this.updater) return this.updater
    const mod = (await import('electron-updater')) as UpdaterModule & { default?: UpdaterModule }
    const updater = mod.autoUpdater ?? mod.default?.autoUpdater
    if (!updater) throw new Error('electron-updater unavailable')
    updater.logger = log
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.autoRunAppAfterInstall = false
    updater.allowDowngrade = false
    updater.allowPrerelease = false
    updater.disableWebInstaller = true
    updater.setFeedURL({
      provider: 'github',
      owner: UPDATE_REPOSITORY.owner,
      repo: UPDATE_REPOSITORY.repo
    })
    this.updater = updater
    return updater
  }

  private apply(next: UpdateState, previous: UpdateState): void {
    if (sameUpdate(previous, next) && sameUpdate(this.state, next)) return
    this.state = next
    if (next.kind === 'available') console.log(`[Flowa] update available: ${next.version}`)
    this.onChange()
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
    return a.version === b.version && a.notes === b.notes && a.downloadUrl === b.downloadUrl && a.releaseUrl === b.releaseUrl
  }
  if ((a.kind === 'error' || a.kind === 'skipped') && (b.kind === 'error' || b.kind === 'skipped')) return a.message === b.message
  return true
}
