// Quit-and-relaunch for an in-app update.
// Squirrel.Mac closes every window before `before-quit`. A close handler that
// hides the window unless that event has already run cancels the quit, so
// ShipIt waits forever and its state stays launchAfterInstallation = false.
// The quitting flag is therefore set before quitAndInstall. Mac relaunch is
// native `autoUpdater.quitAndInstall` when autoRunAppAfterInstall is true.
// Windows NSIS, AppImage, and deb relaunch when quitAndInstall(true, true)
// passes isForceRunAfter through.
//
// ShipIt relaunches through LaunchServices, and NSIS StartApp uses
// ExecShellAsUser. Neither keeps the rehearsal's environment. An e2e build
// therefore writes e2e.json into the login user's own app-support folder
// (not the HOME the test overrode) and reads it on the next boot. Production
// builds never call restoreE2ESession.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

export const E2E_SESSION_FILE = 'e2e.json'

function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Login app-support file. `loginHome` is the real profile, never the test HOME. */
export function e2eSessionPath(platform, loginHome, env = {}) {
  if (typeof loginHome !== 'string' || loginHome.length === 0) {
    throw new Error('e2e session path needs the login home')
  }
  const join = pathFor(platform).join
  if (platform === 'darwin') {
    return join(loginHome, 'Library', 'Application Support', E2E_USER_DATA_FOLDER, E2E_SESSION_FILE)
  }
  if (platform === 'win32') {
    const appData = absolutePath(env.APPDATA, 'win32') || join(loginHome, 'AppData', 'Roaming')
    return join(appData, E2E_USER_DATA_FOLDER, E2E_SESSION_FILE)
  }
  return join(loginHome, '.config', E2E_USER_DATA_FOLDER, E2E_SESSION_FILE)
}

function absolutePath(file, platform) {
  if (typeof file !== 'string') return ''
  const trimmed = file.trim()
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\n') || trimmed.includes('\r')) return ''
  return pathFor(platform).isAbsolute(trimmed) ? trimmed : ''
}

function localFeed(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  let url
  try {
    url = new URL(trimmed)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:') return ''
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return ''
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

function publicKeyPem(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  return trimmed.includes('BEGIN PUBLIC KEY') ? trimmed : ''
}

export function sessionFromEnv(env, platform) {
  return {
    statusFile: absolutePath(env.FLOWA_E2E_STATUS, platform),
    feedUrl: localFeed(env.FLOWA_UPDATE_FEED),
    publicKey: publicKeyPem(env.FLOWA_UPDATE_PUBLIC_KEY),
    autoUpdate: env.FLOWA_E2E_AUTO_UPDATE === '1',
    noSandbox: env.FLOWA_E2E_NO_SANDBOX === '1'
  }
}

export function parseE2ESession(text, platform) {
  if (typeof text !== 'string' || !text.trim()) return null
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  return {
    statusFile: absolutePath(data.statusFile, platform),
    feedUrl: localFeed(data.feedUrl),
    publicKey: publicKeyPem(data.publicKey),
    autoUpdate: data.autoUpdate === true,
    noSandbox: data.noSandbox === true
  }
}

export function mergeE2ESession(fromEnv, fromFile) {
  const file = fromFile ?? { statusFile: '', feedUrl: '', publicKey: '', autoUpdate: false, noSandbox: false }
  return {
    statusFile: fromEnv.statusFile || file.statusFile,
    feedUrl: fromEnv.feedUrl || file.feedUrl,
    publicKey: fromEnv.publicKey || file.publicKey,
    autoUpdate: fromEnv.autoUpdate || file.autoUpdate,
    noSandbox: fromEnv.noSandbox || file.noSandbox
  }
}

function sessionUseful(session) {
  return Boolean(session.statusFile || session.feedUrl || session.publicKey || session.autoUpdate || session.noSandbox)
}

export function applyE2ESession(env, session) {
  if (session.statusFile) env.FLOWA_E2E_STATUS = session.statusFile
  if (session.feedUrl) env.FLOWA_UPDATE_FEED = session.feedUrl
  if (session.publicKey) env.FLOWA_UPDATE_PUBLIC_KEY = session.publicKey
  if (session.autoUpdate) env.FLOWA_E2E_AUTO_UPDATE = '1'
  if (session.noSandbox) env.FLOWA_E2E_NO_SANDBOX = '1'
  return env
}

/**
 * Fills env from e2e.json when this boot has no rehearsal variables, and
 * rewrites the file when this boot does. No-ops unless `e2e` is true.
 */
export function restoreE2ESession({ e2e, env, platform, loginHome, readText, writeText }) {
  if (!e2e) return { persisted: false, path: null }
  const file = e2eSessionPath(platform, loginHome, env)
  const saved = parseE2ESession(readText(file), platform)
  const fromEnv = sessionFromEnv(env, platform)
  const merged = mergeE2ESession(fromEnv, saved)
  applyE2ESession(env, merged)
  if (!sessionUseful(fromEnv)) return { persisted: false, path: file }
  writeText(file, `${JSON.stringify(merged)}\n`)
  return { persisted: true, path: file }
}

export function writeE2ESessionFile(file, text) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export function shipItLabel(bundleId = E2E_BUNDLE_ID) {
  return `${bundleId}.ShipIt`
}

/** launchd job Squirrel.Mac installs for the e2e bundle id. */
export function shipItCleanupPlan(loginHome, uid, bundleId = E2E_BUNDLE_ID) {
  const label = shipItLabel(bundleId)
  const join = path.posix.join
  return {
    label,
    plist: join(loginHome, 'Library', 'LaunchAgents', `${label}.plist`),
    cacheDir: join(loginHome, 'Library', 'Caches', label),
    bootout: ['launchctl', 'bootout', `gui/${uid}/${label}`],
    remove: ['launchctl', 'remove', label]
  }
}
