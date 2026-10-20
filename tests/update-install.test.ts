import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  E2E_BUNDLE_ID,
  E2E_PRODUCT_NAME,
  RELEASE_BUNDLE_ID,
  UPDATE_QUIT_DEADLINE_MS,
  installQuitFailure,
  installRelaunchReady,
  installRelaunchTimeoutMessage,
  isQuittingForUpdate,
  markQuittingForUpdate,
  noteInstalling,
  quitAndRelaunch,
  resetQuittingForUpdate,
  shouldKeepWindowOpen,
  userDataFolderName
} from '../scripts/update-install.mjs'

afterEach(() => {
  resetQuittingForUpdate()
})

describe('quit and relaunch on install', () => {
  it('sets the quitting flag and the relaunch arguments before quitAndInstall', () => {
    let quitting = false
    let autoRun = false
    const calls: string[] = []
    quitAndRelaunch({
      setQuitting: () => {
        quitting = true
        markQuittingForUpdate()
        calls.push('setQuitting')
      },
      isQuitting: () => quitting && isQuittingForUpdate(),
      setAutoRunAfterInstall: (value) => {
        autoRun = value
        calls.push(`autoRun:${value}`)
      },
      quitAndInstall: (isSilent, isForceRunAfter) => {
        if (!quitting || !isQuittingForUpdate()) throw new Error('quitAndInstall ran before the quitting flag')
        calls.push(`quitAndInstall:${isSilent},${isForceRunAfter}`)
      }
    })
    expect(calls).toEqual(['setQuitting', 'autoRun:true', 'quitAndInstall:true,true'])
    expect(autoRun).toBe(true)
    expect(isQuittingForUpdate()).toBe(true)
  })

  it('refuses to call quitAndInstall when the flag does not stick', () => {
    expect(() =>
      quitAndRelaunch({
        setQuitting: () => {},
        isQuitting: () => false,
        setAutoRunAfterInstall: () => {},
        quitAndInstall: () => {
          throw new Error('quitAndInstall must not run')
        }
      })
    ).toThrow(/quitting flag was not set before quitAndInstall/)
  })

  it('keeps the window open only when nobody is quitting', () => {
    expect(shouldKeepWindowOpen(false, false)).toBe(true)
    expect(shouldKeepWindowOpen(true, false)).toBe(false)
    expect(shouldKeepWindowOpen(false, true)).toBe(false)
  })

  it('wires the close handler and before-quit-for-update to that flag', () => {
    const index = readFileSync(path.resolve('src/main/index.ts'), 'utf8')
    const updates = readFileSync(path.resolve('src/main/updates.ts'), 'utf8')
    const close = index.slice(index.indexOf("mainWindow.on('close'"), index.indexOf("mainWindow.on('hide'"))
    expect(close).toContain('shouldKeepWindowOpen(quitting, isQuittingForUpdate())')
    expect(index).toContain("autoUpdater.on('before-quit-for-update'")
    expect(updates).toContain('quitAndRelaunch(')
    expect(updates).not.toContain('quitAndInstall(true, true)')
    expect(index.indexOf('markQuittingForUpdate')).toBeGreaterThan(0)
  })
})

describe('install quit deadline', () => {
  const from = '9.9.0'
  const to = '9.9.1'
  const text = `booted ${from} pid=42\ninstalling ${to}\n`

  it('fails with a clear message when the old pid is still alive after the deadline', () => {
    const watch = noteInstalling(text, from, to, 1_000, { installingAt: null, fromPid: null })
    expect(watch).toEqual({ installingAt: 1_000, fromPid: 42 })
    expect(installQuitFailure({ text, to, now: 1_000 + UPDATE_QUIT_DEADLINE_MS - 1, watch, pidAlive: () => true })).toBeNull()
    expect(
      installQuitFailure({ text, to, now: 1_000 + UPDATE_QUIT_DEADLINE_MS, watch, pidAlive: () => true })
    ).toBe('app did not exit within 20s after installing 9.9.1 (pid 42 still running)')
    expect(installRelaunchReady(text, from, to, 42, () => true)).toBe(false)
  })

  it('is ready only after the old pid is gone and the new version has booted', () => {
    const booted = `${text}booted ${to} pid=99\n`
    const watch = noteInstalling(booted, from, to, 1_000, { installingAt: null, fromPid: null })
    expect(installQuitFailure({ text: booted, to, now: 1_000 + UPDATE_QUIT_DEADLINE_MS, watch, pidAlive: () => false })).toBeNull()
    expect(installRelaunchReady(booted, from, to, watch.fromPid, () => false)).toBe(true)
    expect(installRelaunchReady(text, from, to, watch.fromPid, () => false)).toBe(false)
    expect(installRelaunchTimeoutMessage(text, to, 42, () => false)).toBe(
      'app exited after installing 9.9.1 but 9.9.1 did not start on its own'
    )
  })
})

describe('e2e bundle identity', () => {
  it('uses a bundle id, product name, and data folder the release app does not use', () => {
    const e2e = readFileSync(path.resolve('electron-builder.e2e.cjs'), 'utf8')
    const release = readFileSync(path.resolve('electron-builder.yml'), 'utf8')
    expect(e2e).toContain(`appId: '${E2E_BUNDLE_ID}'`)
    expect(e2e).toContain(`productName: '${E2E_PRODUCT_NAME}'`)
    expect(e2e).toContain("packageName: 'flowa-e2e'")
    expect(release).toContain(`appId: ${RELEASE_BUNDLE_ID}\n`)
    expect(release).not.toContain(E2E_BUNDLE_ID)
    expect(userDataFolderName(true)).toBe('Flowa-Electron-e2e')
    expect(userDataFolderName(false)).toBe('Flowa-Electron')
    const script = readFileSync(path.resolve('scripts/e2e-update.mjs'), 'utf8')
    expect(script).toContain('extraMetadata.name=flowa-e2e')
    expect(script).toContain('waitForPositiveUpdate')
    expect(script.match(/'positive'/g)?.length).toBeGreaterThanOrEqual(3)
  })
})
