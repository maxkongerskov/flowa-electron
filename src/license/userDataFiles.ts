import path from 'node:path'
import { LEGACY_BRIDGE_FILE, LEGACY_FILE, UPDATER_CACHE_DIR_NAME } from './legacy'
import {
  DEVICE_ID_FILE,
  KEY_FILE,
  LICENSE_FILE,
  LICENSE_PREV_FILE,
  META_FILE,
  USAGE_FILE
} from './locations'

/** License files sit next to prefs.json and recent.json. The directory is the frozen userData path. */
export function licenseStoragePaths(userDataDir: string): {
  directory: string
  license: string
  prev: string
  usage: string
  meta: string
  key: string
  deviceId: string
  legacy: string
  bridge: string
  updaterId: string
} {
  return {
    directory: userDataDir,
    license: path.join(userDataDir, LICENSE_FILE),
    prev: path.join(userDataDir, LICENSE_PREV_FILE),
    usage: path.join(userDataDir, USAGE_FILE),
    meta: path.join(userDataDir, META_FILE),
    key: path.join(userDataDir, KEY_FILE),
    deviceId: path.join(userDataDir, DEVICE_ID_FILE),
    legacy: path.join(userDataDir, LEGACY_FILE),
    bridge: path.join(userDataDir, LEGACY_BRIDGE_FILE),
    updaterId: path.join(userDataDir, '.updaterId')
  }
}

/** Mirrors electron-updater's getAppCacheDir. Not inside userData. */
export function updaterCacheRoot(platform: string, env: NodeJS.ProcessEnv, homedir: string): string {
  if (platform === 'win32') return env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches')
  return env.XDG_CACHE_HOME || path.join(homedir, '.cache')
}

export function pendingUpdateInfoPath(cacheRoot: string): string {
  return path.join(cacheRoot, UPDATER_CACHE_DIR_NAME, 'pending', 'update-info.json')
}

/** NSIS stores the setup exe here. It is not inside `pending/`. */
export function updaterInstallerExePath(cacheRoot: string): string {
  return path.join(cacheRoot, UPDATER_CACHE_DIR_NAME, 'installer.exe')
}
