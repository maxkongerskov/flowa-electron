// Port of the MenuBarExtra + MenuBarMenu in FlowaApp.swift.

import { Menu, nativeImage, Tray } from 'electron'
import path from 'node:path'
import type { TrayIconName } from '@shared/status'
import { paths } from './paths'

export interface TrayModel {
  icon: TrayIconName
  statusText: string
  onShow: () => void
  onReinstall: () => void
  onRepair: () => void
  onQuit: () => void
}

const fileFor: Record<TrayIconName, string> = {
  waveform: 'waveform',
  ellipsis: 'ellipsis',
  download: 'download',
  waveformSlash: 'waveform-slash'
}

function image(name: TrayIconName): Electron.NativeImage {
  const mac = process.platform === 'darwin'
  // macOS: black template images (auto light/dark). Windows/Linux: white glyphs for dark taskbars.
  const file = mac ? `${fileFor[name]}Template.png` : `${fileFor[name]}-light.png`
  const img = nativeImage.createFromPath(path.join(paths.assets, 'tray', file))
  if (mac) img.setTemplateImage(true)
  return img
}

export class FlowaTray {
  private tray: Tray
  private last = ''

  constructor(model: TrayModel) {
    this.tray = new Tray(image(model.icon))
    this.tray.setToolTip('Flowa')
    this.update(model)
  }

  update(m: TrayModel): void {
    const key = `${m.icon}|${m.statusText}`
    if (key === this.last) return
    this.last = key
    this.tray.setImage(image(m.icon))
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Flowa', accelerator: 'CommandOrControl+0', click: m.onShow },
        { type: 'separator' },
        { label: m.statusText, enabled: false },
        { type: 'separator' },
        { label: 'Re-run Installation…', click: m.onReinstall },
        { label: 'Repair Flowa…', click: m.onRepair },
        { type: 'separator' },
        { label: 'Quit Flowa', accelerator: 'CommandOrControl+Q', click: m.onQuit }
      ])
    )
  }
}
