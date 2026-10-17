// Listen-only watcher for a modifier tapped by itself.
// macOS: flowa-helper `watch-modifiers` (CGEventTap). Needs Input Monitoring.
// Windows: resources/win/modifier-hook.ps1 (WH_KEYBOARD_LL). No extra binary,
//          so the NSIS installer can still be cross-built on macOS.
// Linux: Electron globalShortcut cannot register a modifier alone, and there
//        is no hook shipped here. Callers must not start this on Linux.

import fs from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { macHelperAvailable } from './macHelper'
import { paths } from './paths'

export interface ModifierWatch {
  kill: () => void
  ready: Promise<boolean>
}

export function watchModifier(onLine: (line: string) => void, onExit: (code: number | null) => void): ModifierWatch {
  if (process.platform === 'darwin') {
    if (!macHelperAvailable()) {
      onExit(null)
      return { kill() {}, ready: Promise.resolve(false) }
    }
    return pipe(spawn(paths.macHelper, ['watch-modifiers']), onLine, onExit)
  }
  if (process.platform === 'win32') {
    if (!fs.existsSync(paths.winModifierHook)) {
      console.error('[Flowa] missing modifier hook', paths.winModifierHook)
      onExit(null)
      return { kill() {}, ready: Promise.resolve(false) }
    }
    return pipe(
      spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.winModifierHook],
        { windowsHide: true }
      ),
      onLine,
      onExit
    )
  }
  onExit(null)
  return { kill() {}, ready: Promise.resolve(false) }
}

function pipe(child: ChildProcessWithoutNullStreams, onLine: (line: string) => void, onExit: (code: number | null) => void): ModifierWatch {
  let buf = ''
  let settle: (ok: boolean) => void = () => {}
  let settled = false
  const ready = new Promise<boolean>((resolve) => (settle = resolve))
  const finish = (ok: boolean): void => {
    if (settled) return
    settled = true
    settle(ok)
  }
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line === 'ready') finish(true)
      else if (line === 'denied') finish(false)
      else if (line) onLine(line)
    }
  })
  child.on('exit', (code) => {
    finish(false)
    onExit(code)
  })
  child.on('error', () => {
    finish(false)
    onExit(null)
  })
  return {
    ready,
    kill() {
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
      child.kill()
    }
  }
}
