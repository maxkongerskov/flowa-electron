// Flow Bar preload: capture requests from main + the pill's ✕ / ✓ buttons.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppState, CaptureResult, CaptureStartRequest } from '../shared/types'

type Handler<T> = (id: number, payload: T) => void
const on = <T>(channel: string, cb: Handler<T>): void => {
  ipcRenderer.on(channel, (_e: IpcRendererEvent, id: number, payload: T) => cb(id, payload))
}

const api = {
  onCaptureStart: (cb: Handler<CaptureStartRequest>) => on('capture:start', cb),
  onCaptureStop: (cb: Handler<number>) => on('capture:stop', cb),
  onCaptureCancel: (cb: Handler<number>) => on('capture:cancel', cb),
  onVisible: (cb: Handler<boolean>) => on('bar:visible', cb),
  reply: (id: number, value: { ok: true } | { ok: false; message: string } | CaptureResult) =>
    ipcRenderer.send('bar:reply', id, value),
  cancel: () => ipcRenderer.send('bar:cancel'),
  commit: () => ipcRenderer.send('bar:commit'),
  getState: (): Promise<AppState | null> => ipcRenderer.invoke('bar:state')
}

contextBridge.exposeInMainWorld('flowaBar', api)
export type FlowaBarApi = typeof api
