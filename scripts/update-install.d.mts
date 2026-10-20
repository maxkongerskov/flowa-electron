export const UPDATE_QUIT_DEADLINE_MS: number
export const E2E_BUNDLE_ID: string
export const RELEASE_BUNDLE_ID: string
export const E2E_PRODUCT_NAME: string
export const E2E_USER_DATA_FOLDER: string
export const RELEASE_USER_DATA_FOLDER: string

export function markQuittingForUpdate(): void
export function isQuittingForUpdate(): boolean
export function resetQuittingForUpdate(): void
export function userDataFolderName(e2e: boolean): string
export function shouldKeepWindowOpen(menuQuit: boolean, updateQuit: boolean): boolean

export type UpdateInstallClient = {
  setQuitting: () => void
  isQuitting: () => boolean
  setAutoRunAfterInstall: (value: boolean) => void
  quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) => void
}
export function quitAndRelaunch(client: UpdateInstallClient): void

export type InstallWatch = { installingAt: number | null; fromPid: number | null }
export function noteInstalling(text: string, from: string, to: string, now: number, watch: InstallWatch): InstallWatch
export function installQuitFailure(args: {
  text: string
  to: string
  now: number
  watch: InstallWatch
  pidAlive: (pid: number) => boolean
  deadlineMs?: number
}): string | null
export function installRelaunchReady(
  text: string,
  from: string,
  to: string,
  fromPid: number | null,
  pidAlive: (pid: number) => boolean
): boolean
export function installRelaunchTimeoutMessage(
  text: string,
  to: string,
  fromPid: number | null,
  pidAlive: (pid: number) => boolean
): string
