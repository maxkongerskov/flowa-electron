import { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } from 'electron'
import path from 'node:path'
import type { CaptureResult, CaptureStartRequest } from '@shared/types'
import type { CaptureBridge } from './pipeline'
import type { FlowBarPanel } from './hotkey'
import { paths } from './paths'

const preload = (name: string): string => path.join(__dirname, '../preload', `${name}.js`)

function loadPage(win: BrowserWindow, page: 'index' | 'bar'): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) void win.loadURL(`${devUrl}/${page}.html`)
  else void win.loadFile(path.join(__dirname, '../renderer', `${page}.html`))
}

function hardenWebContents(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

// MARK: - Main window (Swift: WindowGroup(id: "main") 540×640, .contentSize)

export function pageBackground(dark: boolean): string {
  return dark ? '#1a1a1c' : '#f4f4f4'
}

export function createMainWindow(dark: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 540,
    height: 640,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Flowa',
    backgroundColor: pageBackground(dark),
    icon: path.join(paths.assets, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preload('index'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })
  nativeTheme.themeSource = dark ? 'dark' : 'light'
  hardenWebContents(win)
  loadPage(win, 'index')
  win.once('ready-to-show', () => win.show())
  return win
}

// MARK: - Flow Bar (Swift: borderless non-activating NSPanel 220×44, bottom-centre)
//
// The bar's renderer also owns microphone capture (getUserMedia + Web Audio),
// so it is created hidden at launch and never destroyed.

export class FlowBar implements FlowBarPanel, CaptureBridge {
  readonly win: BrowserWindow
  private presentationGeneration = 0
  private reqId = 0
  private pending = new Map<number, (v: unknown) => void>()
  onCancel: () => void = () => {}
  onCommit: () => void = () => {}

  constructor() {
    const mac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      width: 220,
      height: 44,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      ...(mac ? { type: 'panel' as const } : {}),
      webPreferences: {
        preload: preload('bar'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    })
    this.win.setAlwaysOnTop(true, 'floating')
    // ≈ .moveToActiveSpace + .fullScreenAuxiliary: visible on the active Space and over fullscreen apps.
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    hardenWebContents(this.win)
    loadPage(this.win, 'bar')

    ipcMain.on('bar:reply', (e, id: unknown, value: unknown) => {
      if (e.sender !== this.win.webContents || typeof id !== 'number') return
      const resolve = this.pending.get(id)
      if (resolve) {
        this.pending.delete(id)
        resolve(value)
      }
    })
    ipcMain.on('bar:cancel', (e) => e.sender === this.win.webContents && this.onCancel())
    ipcMain.on('bar:commit', (e) => e.sender === this.win.webContents && this.onCommit())
  }

  private request<T>(channel: string, payload: unknown, timeoutMs: number, fallback: T): Promise<T> {
    const id = ++this.reqId
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(fallback)
      }, timeoutMs)
      this.pending.set(id, (v) => {
        clearTimeout(timer)
        resolve(v as T)
      })
      this.win.webContents.send(channel, id, payload)
    })
  }

  // CaptureBridge
  start(req: CaptureStartRequest): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.request('capture:start', req, 15_000, {
      ok: false as const,
      message: "Couldn't start recording. Check your microphone and try again."
    })
  }

  async stop(generation: number): Promise<CaptureResult> {
    const r = await this.request<CaptureResult | null>('capture:stop', generation, 15_000, null)
    if (!r) {
      return { generation, samples: new Float32Array(0), peak: 0, deviceKind: 'standard', stoppedForMaxDuration: false }
    }
    // Structured clone may hand us a plain object for typed arrays in some paths.
    const samples = r.samples instanceof Float32Array ? r.samples : new Float32Array(r.samples as ArrayLike<number>)
    return { ...r, samples }
  }

  cancel(generation: number): void {
    this.win.webContents.send('capture:cancel', 0, generation)
  }

  // FlowBarPanel
  show(): void {
    this.presentationGeneration += 1
    this.positionAtBottomCentre()
    this.win.webContents.send('bar:visible', 0, true)
    this.win.showInactive()
    this.win.setAlwaysOnTop(true, 'floating')
  }

  hide(): void {
    this.presentationGeneration += 1
    const generation = this.presentationGeneration
    this.win.webContents.send('bar:visible', 0, false)
    // 0.14 s ease-in fade happens in CSS; only hide if no newer show superseded it.
    setTimeout(() => {
      if (this.presentationGeneration === generation) this.win.hide()
    }, 150)
  }

  /** Prefer the display the cursor is on (Swift: NSEvent.mouseLocation). */
  private positionAtBottomCentre(): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    const [w, h] = this.win.getSize()
    const x = Math.round(wa.x + wa.width / 2 - w / 2)
    const y = Math.round(wa.y + wa.height - 60 - h)
    this.win.setPosition(x, y, false)
  }
}
