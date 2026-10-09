import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Where Flowa-Electron keeps its data. Deliberately NOT the Swift app's
 * ~/Library/Application Support/Flowa so both apps can run side by side
 * without sharing recent.json while Max tests. (Swift used Application
 * Support/Flowa/recent.json; we use the same file name in our own folder.)
 */
export function configureUserDataPath(): void {
  app.setPath('userData', path.join(app.getPath('appData'), 'Flowa-Electron'))
}

export const paths = {
  get userData(): string {
    return app.getPath('userData')
  },
  get prefs(): string {
    return path.join(app.getPath('userData'), 'prefs.json')
  },
  get recent(): string {
    return path.join(app.getPath('userData'), 'recent.json')
  },
  get downloadedModels(): string {
    return path.join(app.getPath('userData'), 'models')
  },
  /** Root for bundled resources: process.resourcesPath when packaged, project root in dev. */
  get resourcesRoot(): string {
    return app.isPackaged ? process.resourcesPath : app.getAppPath()
  },
  /** whisper.cpp binaries: resources/bin/<platform>-<arch>/ in dev, bin/ when packaged. */
  get binDir(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(app.getAppPath(), 'resources', 'bin', `${process.platform}-${process.arch}`)
  },
  /** Bundled model folder (models/ in the project, Resources/models when packaged). */
  get bundledModels(): string {
    return path.join(this.resourcesRoot, 'models')
  },
  get macHelper(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, 'mac', 'flowa-helper')
      : path.join(app.getAppPath(), 'resources', 'mac', 'flowa-helper')
  },
  get assets(): string {
    return app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'resources')
  }
}

export function writeFileAtomic(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}
