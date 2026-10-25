import fs from 'node:fs'
import path from 'node:path'
import type { LicenseStorage } from './types'

export function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  const fd = fs.openSync(tmp, 'w', mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, mode)
  } catch {
    /* some platforms reject chmod */
  }
}

export function createNodeStorage(dir: string): LicenseStorage {
  return {
    read(name: string): string | null {
      const file = path.join(dir, name)
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    writeAtomic(name: string, data: string): void {
      writeFileAtomic(path.join(dir, name), data, 0o600)
    },
    remove(name: string): void {
      try {
        fs.rmSync(path.join(dir, name), { force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
