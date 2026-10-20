// Quit-and-relaunch for an in-app update.
// Squirrel.Mac closes every window before `before-quit`. A close handler that
// hides the window unless that event has already run cancels the quit, so
// ShipIt waits forever and its state stays launchAfterInstallation = false.
// The quitting flag is therefore set before quitAndInstall. Mac relaunch is
// native `autoUpdater.quitAndInstall` when autoRunAppAfterInstall is true.
// Windows NSIS, AppImage, and deb relaunch when quitAndInstall(true, true)
// passes isForceRunAfter through.

export const UPDATE_QUIT_DEADLINE_MS = 20_000
export const E2E_BUNDLE_ID = 'com.maxkongerskov.FlowaElectron.e2e'
export const RELEASE_BUNDLE_ID = 'com.maxkongerskov.FlowaElectron'
export const E2E_PRODUCT_NAME = 'FlowaE2E'
export const E2E_USER_DATA_FOLDER = 'Flowa-Electron-e2e'
export const RELEASE_USER_DATA_FOLDER = 'Flowa-Electron'

let quittingForUpdate = false

export function markQuittingForUpdate() {
  quittingForUpdate = true
}

export function isQuittingForUpdate() {
  return quittingForUpdate
}

export function resetQuittingForUpdate() {
  quittingForUpdate = false
}

export function userDataFolderName(e2e) {
  return e2e ? E2E_USER_DATA_FOLDER : RELEASE_USER_DATA_FOLDER
}

/** True when the main window should hide instead of closing. */
export function shouldKeepWindowOpen(menuQuit, updateQuit) {
  return !menuQuit && !updateQuit
}

/**
 * Sets the quit flag, arms relaunch, then calls quitAndInstall.
 * Throws if the flag is still false when quitAndInstall would run.
 */
export function quitAndRelaunch(client) {
  client.setQuitting()
  if (!client.isQuitting()) throw new Error('quitting flag was not set before quitAndInstall')
  client.setAutoRunAfterInstall(true)
  client.quitAndInstall(true, true)
}

export function noteInstalling(text, from, to, now, watch) {
  if (watch.installingAt != null) return watch
  if (!text.includes(`installing ${to}`)) return watch
  const line = text.split('\n').find((entry) => entry.startsWith(`booted ${from} `))
  const pid = Number(line?.match(/pid=(\d+)/)?.[1])
  return { installingAt: now, fromPid: Number.isInteger(pid) ? pid : null }
}

/**
 * After `installing`, the old process must die within the deadline.
 * A dead process whose replacement has not booted yet is still in progress:
 * ShipIt / NSIS / AppImage relaunch can take longer than the quit itself.
 */
export function installQuitFailure(args) {
  const deadline = args.deadlineMs ?? UPDATE_QUIT_DEADLINE_MS
  if (args.watch.installingAt == null) return null
  if (args.now - args.watch.installingAt < deadline) return null
  if (args.watch.fromPid == null) {
    return `app did not record a pid before installing ${args.to}`
  }
  if (args.pidAlive(args.watch.fromPid)) {
    const seconds = Math.round(deadline / 1000)
    return `app did not exit within ${seconds}s after installing ${args.to} (pid ${args.watch.fromPid} still running)`
  }
  return null
}

export function installRelaunchReady(text, from, to, fromPid, pidAlive) {
  if (fromPid == null || pidAlive(fromPid)) return false
  return text.includes(`booted ${from}`) && text.includes(`installing ${to}`) && text.includes(`booted ${to}`)
}

export function installRelaunchTimeoutMessage(text, to, fromPid, pidAlive) {
  if (!text.includes(`installing ${to}`)) return 'update did not reach quitAndInstall'
  if (fromPid != null && !pidAlive(fromPid)) {
    return `app exited after installing ${to} but ${to} did not start on its own`
  }
  return `app did not exit after installing ${to}`
}
