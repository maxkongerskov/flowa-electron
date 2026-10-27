// Flowa — Electron main process. Port of FlowaApp.swift (app root, window,
// menu bar extra, app delegate) wiring the ported services together.

import { app, autoUpdater, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, clipboard } from 'electron'
import type { AppState } from '@shared/types'
import { PrefKey, normalizedMicrophoneUID, sanitizedMaxDurationMinutes, type Prefs } from '@shared/prefs'
import { defaultShortcut, needsInputMonitoring, shortcutKind, shortcutLabel, validateShortcut } from '@shared/shortcut'
import { isEphemeralAggregateUID } from '@shared/micDeviceKind'
import { allGranted, machineNoun, menuStatusText, trayIconName } from '@shared/status'
import { languageDisplayName } from '@shared/languages'
import { isHardwarePref, isSpeechModelId, collectEngineNotices } from '@shared/speech'
import { configureUserDataPath, paths } from './paths'
import { clearVulkanAutoSkip, readVulkanAutoSkip } from './vulkanSkip'
import { prefs } from './store'
import { permissions } from './permissions'
import { fnConflict } from './fnConflict'
import { DictationPipeline } from './pipeline'
import { GlobalHotkey } from './hotkey'
import { dictationShortcutMenu } from './shortcutMenu'
import { createMainWindow, FlowBar, pageBackground } from './windows'
import { FlowaTray } from './tray'
import { isLoginItemEnabled, setLoginItemEnabled } from './loginItem'
import { runRepair } from './repair'
import { openKeyboardSettings } from './permissions'
import { runSelfTest } from './selftest'
import { isE2EBuild } from '@shared/updateTrust'
import { E2E_BUNDLE_ID, RELEASE_BUNDLE_ID, isQuittingForUpdate, markQuittingForUpdate, shouldKeepWindowOpen } from '../../scripts/update-install.mjs'
import { installE2ESession } from './e2eSession'
import { noteE2E, UpdateChecker } from './updates'

configureUserDataPath()
if (isE2EBuild()) {
  installE2ESession()
  app.disableHardwareAcceleration()
  if (process.env.FLOWA_E2E_NO_SANDBOX === '1') {
    app.commandLine.appendSwitch('no-sandbox')
    app.commandLine.appendSwitch('disable-setuid-sandbox')
  }
}
app.setName(isE2EBuild() ? 'FlowaE2E' : 'Flowa')
if (process.platform === 'win32') app.setAppUserModelId(isE2EBuild() ? E2E_BUNDLE_ID : RELEASE_BUNDLE_ID)

// The packaged update test restarts a second copy before the first has quit.
// Production builds still take the lock.
const skipSingleInstance = isE2EBuild() && process.env.FLOWA_E2E_AUTO_UPDATE === '1'
if (!skipSingleInstance && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void main()
}

async function main(): Promise<void> {
  await app.whenReady()
  console.log(`[Flowa] version ${app.getVersion()}`)
  noteE2E(`booted ${app.getVersion()} pid=${process.pid}`)
  // A skip written by an older build is dropped before the first engine plan.
  readVulkanAutoSkip(paths.userData, app.getVersion())

  // Only our own pages may use the microphone.
  const ours = (url: string): boolean => url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media' && ours(wc.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && ours(wc.getURL()))

  let quitting = false
  let mainWindow: BrowserWindow | null = null
  const bar = new FlowBar()
  const pipeline = new DictationPipeline(bar)
  const hotkey = new GlobalHotkey(pipeline, bar)
  bar.onCrashed = () => {
    if (hotkey.session === 'recording') hotkey.cancelListening()
    pipeline.abortBarCrash()
  }
  bar.onCancel = () => hotkey.cancelListening()
  bar.onCommit = () => hotkey.commitListening()
  let launchAtLogin = isLoginItemEnabled()
  let recordNonce = 0
  let menuKey = ''
  let stateRevision = 0

  const showMain = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createMainWindow(prefs.get(PrefKey.colorSchemeDark))
      mainWindow.on('close', (e) => {
        // applicationShouldTerminateAfterLastWindowClosed → false: keep running for the hotkey + tray.
        // An update sets the quit flag before quitAndInstall, because Squirrel closes
        // windows before `before-quit`. Hiding the window here cancels that quit.
        if (shouldKeepWindowOpen(quitting, isQuittingForUpdate())) {
          e.preventDefault()
          mainWindow?.hide()
        }
      })
      mainWindow.on('hide', () => {
        // Closing the window does not unmount the shortcut recorder, so resume here too.
        void hotkey.resume()
      })
      mainWindow.on('focus', () => {
        void permissions.check()
        if (!hotkey.suspended && !hotkey.isAuthorized) void hotkey.restart()
      })
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
    }
    mainWindow.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  }

  // Assigned once `broadcast` exists. Update checks must not run before that.
  let publishState = (): void => {}
  const updates = new UpdateChecker(() => publishState())
  const checkForUpdates = (): void => {
    showMain()
    void updates.check(true)
  }

  const conflictStatus = (): AppState['conflict'] => {
    const macModifierDenied = hotkey.kind === 'modifier' && needsInputMonitoring(hotkey.accelerator, process.platform) && !permissions.state.inputMonitoring
    if (!hotkey.suspended && !hotkey.usesFn && hotkey.accelerator && !hotkey.isAuthorized && !macModifierDenied) {
      return { kind: 'shortcutTaken', accelerator: hotkey.accelerator }
    }
    return fnConflict.status
  }

  const applyShortcut = async (value: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (typeof value !== 'string') return { ok: false, message: 'Press a key to use as the shortcut.' }
    const verdict = validateShortcut(value, process.platform)
    if (!verdict.ok) return verdict
    const previous = prefs.get(PrefKey.shortcut)
    if (previous !== verdict.shortcut) prefs.set(PrefKey.shortcut, verdict.shortcut as Prefs[typeof PrefKey.shortcut])
    await hotkey.restart()
    if (!hotkey.isAuthorized && previous !== verdict.shortcut && verdict.kind !== 'fn') {
      console.warn('[Flowa] shortcut not registered:', verdict.shortcut)
    }
    void permissions.check()
    void fnConflict.check()
    return { ok: true }
  }

  const recordShortcut = (): void => {
    recordNonce += 1
    showMain()
    broadcast()
  }

  const shortcutMenuArgs = () => ({
    current: hotkey.accelerator || prefs.get(PrefKey.shortcut),
    platform: process.platform,
    onSelect: (shortcut: string) => void applyShortcut(shortcut),
    onRecord: recordShortcut,
    onReset: () => void applyShortcut(defaultShortcut(process.platform))
  })

  const buildState = (): AppState => {
    const t = pipeline.transcriber
    const perms = permissions.state
    const acc = hotkey.accelerator || prefs.get(PrefKey.shortcut)
    stateRevision += 1
    return {
      stateRevision,
      platform: process.platform,
      machineNoun: machineNoun(process.platform),
      version: app.getVersion(),
      prefs: prefs.all,
      prefsWarning: prefs.warning,
      permissions: perms,
      allGranted: allGranted(perms),
      conflict: conflictStatus(),
      transcriber: t.status,
      transcriberReady: t.isReady,
      needsSetup: t.needsSetup,
      isTranscribing: pipeline.isTranscribing,
      session: hotkey.session,
      lastErrorMessage: pipeline.lastErrorMessage,
      recent: pipeline.recent,
      launchAtLogin,
      shortcut: {
        accelerator: acc,
        label: shortcutLabel(acc, process.platform),
        usesFn: hotkey.usesFn || acc === 'fn',
        kind: shortcutKind(acc),
        active: hotkey.isAuthorized,
        recordNonce
      },
      engine: { modelName: t.modelName, ...t.engineInfo },
      engineNotices: collectEngineNotices(t.notice),
      update: updates.state
    }
  }

  const confirmReinstall = async (): Promise<void> => {
    const noun = machineNoun(process.platform)
    const r = await dialog.showMessageBox({
      type: 'info',
      message: 'Re-run installation?',
      detail: `This prepares Flowa’s speech engine again for this ${noun} and re-checks its files. Nothing is downloaded unless a file is damaged.\n\nUse this if dictation records but never produces text.`,
      buttons: ['Install again', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (r.response === 0) {
      pipeline.reinstallSpeechModel()
      showMain()
    }
  }

  const confirmRepair = async (): Promise<void> => {
    const mac = process.platform === 'darwin'
    const r = await dialog.showMessageBox({
      type: 'warning',
      message: 'Repair Flowa?',
      detail: mac
        ? 'This will:\n• Reset Microphone, Input Monitoring, and Accessibility permissions\n• Re-run the one-time speech engine install for this Mac\n• Re-register Flowa.app and relaunch\n\nYou\'ll grant permissions again; installation is offline. Use this after moving Flowa or if something stopped working.'
        : 'This will:\n• Re-check the speech engine files and prepare it again\n• Re-register the shortcut and relaunch\n\nUse this if something stopped working.',
      buttons: ['Repair and Relaunch', 'Cancel'],
      defaultId: 0,
      cancelId: 1
    })
    if (r.response === 0) {
      await runRepair({ permissions: true, speechModel: true }, () => {
        prefs.set(PrefKey.firstRunComplete, false)
        pipeline.transcriber.resetForReinstall()
      })
    }
  }

  const quit = (): void => {
    quitting = true
    app.quit()
  }

  const tray = new FlowaTray({
    icon: 'download',
    statusText: 'Starting…',
    shortcut: prefs.get(PrefKey.shortcut),
    platform: process.platform,
    onShow: showMain,
    onReinstall: confirmReinstall,
    onRepair: confirmRepair,
    onQuit: quit,
    onCheckForUpdates: checkForUpdates,
    onShortcut: (shortcut) => void applyShortcut(shortcut),
    onRecordShortcut: recordShortcut,
    onResetShortcut: () => void applyShortcut(defaultShortcut(process.platform))
  })

  // Broadcast state (coalesced) to every renderer + refresh tray.
  let scheduled = false
  const broadcast = (): void => {
    if (scheduled) return
    scheduled = true
    setImmediate(() => {
      scheduled = false
      const s = buildState()
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('state', s)
      tray.update({
        icon: trayIconName({
          isTranscribing: s.isTranscribing,
          needsSetup: s.needsSetup,
          allGranted: s.allGranted,
          // Swift treats .unknown as "not clean" only when fn is the shortcut.
          conflict: s.conflict.kind === 'unknown' && s.shortcut.usesFn ? { kind: 'conflict', behavior: 2, displayName: '' } : s.conflict
        }),
        statusText: menuStatusText({
          transcriber: s.transcriber,
          needsSetup: s.needsSetup,
          permissions: s.permissions,
          conflict: s.conflict.kind === 'unknown' ? { kind: 'clean' } : s.conflict,
          isTranscribing: s.isTranscribing,
          keyLabel: s.shortcut.label
        }),
        shortcut: s.shortcut.accelerator,
        platform: s.platform,
        onShow: showMain,
        onReinstall: confirmReinstall,
        onRepair: confirmRepair,
        onQuit: quit,
        onCheckForUpdates: checkForUpdates,
        onShortcut: (shortcut) => void applyShortcut(shortcut),
        onRecordShortcut: recordShortcut,
        onResetShortcut: () => void applyShortcut(defaultShortcut(process.platform))
      })
      const nextMenuKey = `${s.shortcut.accelerator}|${s.platform}`
      if (nextMenuKey !== menuKey) {
        menuKey = nextMenuKey
        installAppMenu()
      }
    })
  }
  publishState = broadcast

  const installAppMenu = (): void => {
    const dictation = dictationShortcutMenu(shortcutMenuArgs())
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          dictation,
          { role: 'editMenu' },
          { label: 'Window', submenu: [{ label: 'Show Flowa', accelerator: 'Command+0', click: showMain }, { label: 'Check for Updates…', click: checkForUpdates }, { role: 'minimize' }, { role: 'close' }] }
        ])
      )
    } else {
      // Hidden until Alt (autoHideMenuBar). The tray has the same items.
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Flowa',
            submenu: [
              { label: 'Show Flowa', accelerator: 'CommandOrControl+0', click: showMain },
              { label: 'Check for Updates…', click: checkForUpdates },
              { type: 'separator' },
              { label: 'Quit Flowa', accelerator: 'CommandOrControl+Q', click: quit }
            ]
          },
          dictation
        ])
      )
    }
  }

  pipeline.on('change', broadcast)
  pipeline.on('showMainWindow', showMain)
  hotkey.on('change', broadcast)
  // A tap created before the grant never receives events, so on every
  // denied→granted flip of Input Monitoring start a fresh fn watcher
  // (Swift relaunches via Repair; here it's automatic). Never mid-recording.
  let imWasGranted = false
  let launched = false
  permissions.on('change', () => {
    broadcast()
    if (!launched) return
    const im = permissions.state.inputMonitoring
    const flippedOn = im && !imWasGranted
    imWasGranted = im
    if (!hotkey.suspended && im && hotkey.session === 'idle' && (flippedOn || !hotkey.isAuthorized)) {
      console.log(`[Flowa] Input Monitoring ${flippedOn ? 'granted' : 'available'} → restarting fn watcher`)
      void hotkey.restart()
    }
  })
  fnConflict.on('change', broadcast)
  prefs.on('change', (key: string) => {
    if (key === PrefKey.hardware || key === PrefKey.speechModel) pipeline.transcriber.reloadForPrefs()
    broadcast()
  })

  // RootView.syncFirstRunWithTranscriber
  pipeline.transcriber.on('change', () => {
    const t = pipeline.transcriber
    if (t.isReady && !prefs.get(PrefKey.firstRunComplete)) prefs.set(PrefKey.firstRunComplete, true)
    else if (t.status.kind === 'error' && prefs.get(PrefKey.firstRunComplete)) prefs.set(PrefKey.firstRunComplete, false)
  })

  // MARK: IPC — main window

  const fromMain = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean =>
    !!mainWindow && !mainWindow.isDestroyed() && e.sender === mainWindow.webContents

  ipcMain.handle('state:get', () => buildState())

  ipcMain.handle('prefs:set', async (e, key: unknown, value: unknown) => {
    if (!fromMain(e)) return
    switch (key) {
      case PrefKey.language:
        if (typeof value === 'string' && languageDisplayName(value) !== value) prefs.set(key, value)
        break
      case PrefKey.microphone:
        if (typeof value === 'string') prefs.set(key, normalizedMicrophoneUID(value, isEphemeralAggregateUID))
        break
      case PrefKey.colorSchemeDark:
        if (typeof value === 'boolean') {
          prefs.set(key, value)
          nativeTheme.themeSource = value ? 'dark' : 'light'
          mainWindow?.setBackgroundColor(pageBackground(value))
        }
        break
      case PrefKey.onboardingComplete:
        if (typeof value === 'boolean') prefs.set(key, value)
        break
      case PrefKey.maxDurationMinutes:
        if (typeof value === 'number') prefs.set(key, sanitizedMaxDurationMinutes(value))
        break
      case PrefKey.shortcut:
        return applyShortcut(value)
      case PrefKey.hardware:
        if (isHardwarePref(value)) {
          // A new choice is allowed to try Vulkan again, including re-selecting automatic.
          clearVulkanAutoSkip(paths.userData)
          prefs.set(key, value)
        }
        break
      case PrefKey.speechModel:
        if (isSpeechModelId(value)) prefs.set(key, value)
        break
      case PrefKey.liveTranscription:
        // Read at the next recording start; a running session keeps its mode.
        if (typeof value === 'boolean') prefs.set(key, value)
        break
    }
  })

  const actions: Record<string, (...args: unknown[]) => unknown> = {
    requestMicrophone: () => permissions.requestMicrophone(),
    requestInputMonitoring: () => permissions.requestInputMonitoring(),
    requestAccessibility: async () => {
      await permissions.requestAccessibility()
      if (process.platform === 'linux' && !permissions.state.accessibility) {
        await dialog.showMessageBox({
          type: 'info',
          message: 'Auto-paste needs a small helper',
          detail:
            'Install one of these, then come back:\n\n• X11: sudo apt install xdotool\n• Wayland: sudo apt install wtype   (or ydotool)\n\nWithout it, dictations land on the clipboard.'
        })
      }
    },
    openKeyboardSettings: () => openKeyboardSettings(),
    dismissError: () => pipeline.dismissError(),
    reinstallSpeechModel: () => pipeline.reinstallSpeechModel(),
    retryInstall: () => pipeline.transcriber.loadIfNeeded(),
    downloadSpeechModel: () => pipeline.transcriber.downloadSelectedModel(),
    setLaunchAtLogin: (v) => {
      if (typeof v !== 'boolean') return
      setLoginItemEnabled(v)
      launchAtLogin = isLoginItemEnabled()
      broadcast()
    },
    copyText: (t) => typeof t === 'string' && clipboard.writeText(t),
    clearRecent: async () => {
      const opts = {
        type: 'warning' as const,
        message: 'Clear recent dictations?',
        detail: `All ${pipeline.recent.length} transcripts will be removed. This can't be undone.`,
        buttons: ['Clear', 'Cancel'],
        defaultId: 1,
        cancelId: 1
      }
      const r = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts)
      if (r.response === 0) pipeline.clearRecent()
    },
    popupMicMenu: (devices, current) =>
      new Promise<string | null>((resolve) => {
        if (!Array.isArray(devices) || typeof current !== 'string') return resolve(null)
        const list = devices.filter(
          (d): d is { uid: string; displayName: string } => !!d && typeof d.uid === 'string' && typeof d.displayName === 'string'
        )
        let chosen: string | null = null
        const isDefault = current === 'default' || current === ''
        const menu = Menu.buildFromTemplate([
          { label: 'System default', type: 'checkbox', checked: isDefault, click: () => (chosen = 'default') },
          ...(list.length ? [{ type: 'separator' as const }] : []),
          ...list.map((d) => ({ label: d.displayName, type: 'checkbox' as const, checked: d.uid === current, click: () => (chosen = d.uid) }))
        ])
        menu.popup({ window: mainWindow ?? undefined, callback: () => setImmediate(() => resolve(chosen)) })
      }),
    reloadShortcut: () => hotkey.restart(),
    suspendShortcut: () => hotkey.suspend(),
    resumeShortcut: () => hotkey.resume(),
    checkForUpdates: () => checkForUpdates(),
    openUpdate: () => updates.accept(),
    dismissUpdateNote: () => updates.dismissNote()
  }

  ipcMain.handle('action', async (e, name: unknown, ...args: unknown[]) => {
    if (!fromMain(e) || typeof name !== 'string' || !(name in actions)) return undefined
    return actions[name](...args)
  })

  // Bar renderer asks for current mic pref etc. via state as well.
  ipcMain.handle('bar:state', (e) => (e.sender === bar.win.webContents ? buildState() : null))

  installAppMenu()

  app.on('activate', showMain)
  app.on('second-instance', showMain)
  app.on('window-all-closed', () => {
    /* keep running in the tray */
  })
  const beginQuit = (): void => {
    quitting = true
    markQuittingForUpdate()
    for (const win of BrowserWindow.getAllWindows()) {
      win.removeAllListeners('close')
    }
  }
  autoUpdater.on('before-quit-for-update', beginQuit)
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('will-quit', () => {
    hotkey.stop()
    pipeline.transcriber.shutdown()
  })

  // onAppear: start hotkey, conflict detector, permissions, prewarm.
  showMain()
  permissions.start()
  fnConflict.start()
  await permissions.check()
  // RootView.onAppear: if permissions.allGranted → onboardingComplete = true
  if (permissions.allGranted && !prefs.get(PrefKey.onboardingComplete)) prefs.set(PrefKey.onboardingComplete, true)
  imWasGranted = permissions.state.inputMonitoring
  await hotkey.start()
  launched = true
  // Safety net: if the fn watcher died (helper crash, tap revoked), bring it back.
  setInterval(() => {
    if (!hotkey.suspended && hotkey.needsMacNativeWatch && permissions.state.inputMonitoring && !hotkey.isAuthorized && hotkey.session === 'idle') {
      void hotkey.start()
    }
  }, 5000)
  console.log(
    `[Flowa] launched. mic=${permissions.state.microphone} im=${permissions.state.inputMonitoring} ax=${permissions.state.accessibility} loginItem=${launchAtLogin}`
  )
  if (process.platform === 'darwin') {
    // Diagnostics: is the helper (which posts ⌘V) itself trusted for Accessibility?
    void import('./macHelper').then(async (m) => {
      if (m.macHelperAvailable()) console.log(`[Flowa] helper accessibility=${(await m.helper(['check-ax'])).out}`)
    })
  }
  pipeline.prewarm()
  broadcast()
  void updates.check(false)
  void runSelfTest(pipeline, bar)
}
