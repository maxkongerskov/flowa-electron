import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import { cliInvocation, windowsInstalledExe, windowsInstallerArgs } from '../scripts/e2e-update.mjs'
import {
  E2E_BUNDLE_ID,
  E2E_PRODUCT_NAME,
  RELEASE_BUNDLE_ID,
  UPDATE_QUIT_DEADLINE_MS,
  e2eSessionPath,
  installQuitFailure,
  installRelaunchReady,
  installRelaunchTimeoutMessage,
  isQuittingForUpdate,
  markQuittingForUpdate,
  noteInstalling,
  parseE2ESession,
  quitAndRelaunch,
  resetQuittingForUpdate,
  restoreE2ESession,
  shipItCleanupPlan,
  shouldKeepWindowOpen,
  userDataFolderName,
  writeE2ESessionFile
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

describe('windows rehearsal command', () => {
  it('starts the package CLIs with node so Windows never spawns a .cmd', () => {
    const modules = path.join('C:\\repo', 'node_modules')
    const vite = cliInvocation('electron-vite', ['build'], 'C:\\Program Files\\nodejs\\node.exe', modules)
    const builder = cliInvocation('electron-builder', ['--win', 'nsis'], 'C:\\Program Files\\nodejs\\node.exe', modules)
    expect(vite.command).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(builder.command).toBe(vite.command)
    expect(vite.args[0]).toBe(path.join(modules, 'electron-vite', 'bin', 'electron-vite.js'))
    expect(vite.args.slice(1)).toEqual(['build'])
    expect(builder.args[0]).toBe(path.join(modules, 'electron-builder', 'cli.js'))
    expect(builder.args.slice(1)).toEqual(['--win', 'nsis'])
    for (const invoked of [vite, builder]) {
      expect(invoked.command.endsWith('.cmd')).toBe(false)
      expect(invoked.args.some((arg) => arg.endsWith('.cmd'))).toBe(false)
    }
    expect(() => cliInvocation('npx', [])).toThrow(/unknown cli/)
    const script = readFileSync(path.resolve('scripts/e2e-update.mjs'), 'utf8')
    expect(script).not.toContain('npx.cmd')
    expect(script).toContain('runNodeCli')
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
    expect(e2e).toContain('oneClick: false')
    expect(e2e).toContain('allowToChangeInstallationDirectory: true')
    expect(windowsInstallerArgs()).toEqual(['/S', '/currentuser'])
    expect(windowsInstalledExe('C:\\Users\\runneradmin\\AppData\\Local')).toBe(
      'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\FlowaE2E\\FlowaE2E.exe'
    )
    const winFn = script.slice(script.indexOf('async function windows('))
    expect(winFn).toContain('windowsInstallerArgs()')
    expect(winFn).toContain('windowsInstalledExe(')
    expect(winFn).toContain('finishLaunch')
  })
})

const PEM = '-----BEGIN PUBLIC KEY-----\nABC\n-----END PUBLIC KEY-----'

describe('e2e session survives a relaunch without the test environment', () => {
  it('stores the file in the login app-support folder, not an overridden HOME', () => {
    expect(e2eSessionPath('darwin', '/Users/max', { HOME: '/tmp/flowa-fake-home' })).toBe(
      '/Users/max/Library/Application Support/Flowa-Electron-e2e/e2e.json'
    )
    expect(e2eSessionPath('linux', '/home/max', { HOME: '/tmp/flowa-fake-home', XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      '/home/max/.config/Flowa-Electron-e2e/e2e.json'
    )
    expect(
      e2eSessionPath('win32', 'C:\\Users\\max', { APPDATA: 'C:\\Users\\max\\AppData\\Roaming' })
    ).toBe('C:\\Users\\max\\AppData\\Roaming\\Flowa-Electron-e2e\\e2e.json')
  })

  it('does not read or write the file for a production build', () => {
    let reads = 0
    const env = { FLOWA_E2E_STATUS: '/tmp/status.txt', FLOWA_UPDATE_FEED: 'http://127.0.0.1:9/feed/' }
    const result = restoreE2ESession({
      e2e: false,
      env,
      platform: 'darwin',
      loginHome: '/Users/max',
      readText: () => {
        reads += 1
        return '{}'
      },
      writeText: () => {
        throw new Error('production must not write e2e.json')
      }
    })
    expect(reads).toBe(0)
    expect(result).toEqual({ persisted: false, path: null })
    expect(env.FLOWA_E2E_STATUS).toBe('/tmp/status.txt')
  })

  it('persists the first boot and restores it when the relaunch has an empty environment', () => {
    const first: NodeJS.ProcessEnv = {
      HOME: '/tmp/flowa-fake-home',
      FLOWA_E2E_STATUS: '/tmp/flowa/status-positive.txt',
      FLOWA_UPDATE_FEED: 'http://127.0.0.1:9/feed',
      FLOWA_UPDATE_PUBLIC_KEY: PEM,
      FLOWA_E2E_AUTO_UPDATE: '1',
      FLOWA_E2E_NO_SANDBOX: '1'
    }
    let stored = ''
    const written = restoreE2ESession({
      e2e: true,
      env: first,
      platform: 'darwin',
      loginHome: '/Users/max',
      readText: () =>
        JSON.stringify({
          statusFile: '/tmp/flowa/status-old.txt',
          feedUrl: 'http://127.0.0.1:1/',
          publicKey: PEM,
          autoUpdate: true,
          noSandbox: true
        }),
      writeText: (_file, text) => {
        stored = text
      }
    })
    expect(written.persisted).toBe(true)
    expect(written.path).toBe('/Users/max/Library/Application Support/Flowa-Electron-e2e/e2e.json')
    expect(JSON.parse(stored).statusFile).toBe('/tmp/flowa/status-positive.txt')
    expect(JSON.parse(stored).feedUrl).toBe('http://127.0.0.1:9/feed/')

    const relaunch: NodeJS.ProcessEnv = {}
    const restored = restoreE2ESession({
      e2e: true,
      env: relaunch,
      platform: 'darwin',
      loginHome: '/Users/max',
      readText: () => stored,
      writeText: () => {
        throw new Error('a boot with no rehearsal env must not rewrite e2e.json')
      }
    })
    expect(restored.persisted).toBe(false)
    expect(relaunch.FLOWA_E2E_STATUS).toBe('/tmp/flowa/status-positive.txt')
    expect(relaunch.FLOWA_UPDATE_FEED).toBe('http://127.0.0.1:9/feed/')
    expect(relaunch.FLOWA_UPDATE_PUBLIC_KEY).toBe(PEM)
    expect(relaunch.FLOWA_E2E_AUTO_UPDATE).toBe('1')
    expect(relaunch.FLOWA_E2E_NO_SANDBOX).toBe('1')
  })

  it('drops a non-local feed and a relative status path', () => {
    const env: NodeJS.ProcessEnv = {
      FLOWA_UPDATE_FEED: 'https://github.com/maxkongerskov/flowa-electron/',
      FLOWA_E2E_STATUS: 'status.txt',
      FLOWA_UPDATE_PUBLIC_KEY: 'not a key'
    }
    let stored = ''
    const result = restoreE2ESession({
      e2e: true,
      env,
      platform: 'linux',
      loginHome: '/home/max',
      readText: () => null,
      writeText: (_file, text) => {
        stored = text
      }
    })
    expect(result.persisted).toBe(false)
    expect(stored).toBe('')
    expect(env.FLOWA_UPDATE_FEED).toBe('https://github.com/maxkongerskov/flowa-electron/')
    expect(parseE2ESession('not json', 'darwin')).toBeNull()
  })

  it('round-trips the session file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flowa-e2e-session-'))
    const file = path.join(dir, 'e2e.json')
    writeE2ESessionFile(file, `${JSON.stringify({ statusFile: '/tmp/status.txt', feedUrl: 'http://127.0.0.1:9/', publicKey: PEM, autoUpdate: true, noSandbox: true })}\n`)
    expect(parseE2ESession(readFileSync(file, 'utf8'), 'linux')).toMatchObject({
      statusFile: '/tmp/status.txt',
      feedUrl: 'http://127.0.0.1:9/',
      autoUpdate: true,
      noSandbox: true
    })
  })

  it('names only the e2e ShipIt job', () => {
    const plan = shipItCleanupPlan('/Users/max', 501)
    expect(plan.label).toBe('com.maxkongerskov.FlowaElectron.e2e.ShipIt')
    expect(plan.label).not.toBe('com.maxkongerskov.FlowaElectron.ShipIt')
    expect(plan.plist).toBe('/Users/max/Library/LaunchAgents/com.maxkongerskov.FlowaElectron.e2e.ShipIt.plist')
    expect(plan.cacheDir).toBe('/Users/max/Library/Caches/com.maxkongerskov.FlowaElectron.e2e.ShipIt')
    expect(plan.bootout).toEqual(['launchctl', 'bootout', 'gui/501/com.maxkongerskov.FlowaElectron.e2e.ShipIt'])
    expect(plan.remove).toEqual(['launchctl', 'remove', 'com.maxkongerskov.FlowaElectron.e2e.ShipIt'])
  })

  it('loads the session before the sandbox switch, and only in an e2e build', () => {
    const index = readFileSync(path.resolve('src/main/index.ts'), 'utf8')
    const session = readFileSync(path.resolve('src/main/e2eSession.ts'), 'utf8')
    const block = index.slice(index.indexOf('if (isE2EBuild())'), index.indexOf('app.setName'))
    expect(block).toContain('installE2ESession()')
    expect(block.indexOf('installE2ESession()')).toBeLessThan(block.indexOf("appendSwitch('no-sandbox')"))
    expect(index.indexOf('installE2ESession()')).toBeLessThan(index.indexOf('skipSingleInstance'))
    expect(session).toContain('if (!isE2EBuild()) return')
    expect(session).toContain('os.userInfo().homedir')
    expect(session).not.toContain('process.env.HOME')
    expect(session).not.toContain('getPath(')
  })
})
