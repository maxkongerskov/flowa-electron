// Thin wrapper around resources/mac/flowa-helper (native/macos/flowa-helper.swift).
// It gives the Electron app the same macOS primitives the Swift app used directly:
// CGEventTap for the fn key, IOHIDCheckAccess (Input Monitoring), NSWorkspace
// frontmost app, NSRunningApplication.activate + CGEvent Cmd+V paste.

import fs from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { paths } from './paths'
import { run } from './proc'

export function macHelperAvailable(): boolean {
  if (process.platform !== 'darwin') return false
  try {
    fs.accessSync(paths.macHelper, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function helper(args: string[], timeoutMs = 4000): Promise<{ code: number; out: string }> {
  const r = await run(paths.macHelper, args, timeoutMs)
  return { code: r.code, out: r.stdout.trim() }
}

export interface FrontApp {
  pid: number
  bundleId: string | null
  name: string | null
}

export async function frontmostApp(): Promise<FrontApp | null> {
  if (!macHelperAvailable()) return null
  const r = await helper(['frontmost'])
  if (r.code !== 0) return null
  try {
    const j = JSON.parse(r.out)
    return { pid: Number(j.pid), bundleId: j.bundleId ?? null, name: j.name ?? null }
  } catch {
    return null
  }
}

/** Long-running fn watcher. Emits 'down' / 'up'; resolves ready=false if the tap could not be created. */
export function watchFn(onEvent: (e: 'down' | 'up') => void, onExit: (code: number | null) => void): {
  child: ChildProcessWithoutNullStreams
  ready: Promise<boolean>
} {
  const child = spawn(paths.macHelper, ['watch-fn'])
  let buf = ''
  let settle: (ok: boolean) => void = () => {}
  const ready = new Promise<boolean>((resolve) => (settle = resolve))
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line === 'ready') settle(true)
      else if (line === 'denied') settle(false)
      else if (line === 'fn-down') onEvent('down')
      else if (line === 'fn-up') onEvent('up')
    }
  })
  child.on('exit', (code) => {
    settle(false)
    onExit(code)
  })
  child.on('error', () => settle(false))
  return { child, ready }
}
