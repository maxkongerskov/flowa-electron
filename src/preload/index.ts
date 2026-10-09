// Main-window preload. Exposes a narrow, typed API; no Node access in the renderer.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AppState } from '../shared/types'

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('state:get'),
  onState: (cb: (s: AppState) => void): (() => void) => {
    const h = (_e: IpcRendererEvent, s: AppState): void => cb(s)
    ipcRenderer.on('state', h)
    return () => ipcRenderer.removeListener('state', h)
  },
  setPref: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('prefs:set', key, value),
  action: (name: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke('action', name, ...args)
}

contextBridge.exposeInMainWorld('flowa', api)
export type FlowaApi = typeof api
