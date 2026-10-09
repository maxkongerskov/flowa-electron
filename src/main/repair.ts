// Port of Flowa/Permissions/Repair.swift.
//
// macOS (packaged): reset the three TCC grants for our bundle id, re-register
// with LaunchServices, reset the speech-engine install, relaunch.
// Windows/Linux: there is no TCC; reset the install state and relaunch.

import { app } from 'electron'
import path from 'node:path'
import { run } from './proc'

export const bundleId = 'com.maxkongerskov.FlowaElectron'

export interface RepairOptions {
  permissions: boolean
  speechModel: boolean
}

/** Pure: the commands a permissions repair runs on macOS (unit-tested). */
export function macPermissionResetCommands(id: string, bundlePath: string): Array<[string, string[]]> {
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  return [
    ['/usr/bin/tccutil', ['reset', 'Microphone', id]],
    ['/usr/bin/tccutil', ['reset', 'ListenEvent', id]],
    ['/usr/bin/tccutil', ['reset', 'Accessibility', id]],
    [lsregister, ['-f', bundlePath]]
  ]
}

export async function runRepair(opts: RepairOptions, resetSpeechModel: () => void): Promise<void> {
  if (opts.permissions && process.platform === 'darwin') {
    if (app.isPackaged) {
      const bundlePath = path.resolve(process.execPath, '../../..')
      for (const [cmd, args] of macPermissionResetCommands(bundleId, bundlePath)) {
        const r = await run(cmd, args, 10_000)
        if (r.code !== 0) console.error('[Flowa][repair]', cmd, args.join(' '), r.stderr.trim())
      }
    } else {
      // In dev the TCC client is com.github.Electron (shared with every Electron
      // app on this Mac), so we never reset it automatically.
      console.warn('[Flowa][repair] dev build: skipping tccutil reset for com.github.Electron')
    }
  }
  if (opts.speechModel) resetSpeechModel()
  // Swift spawned `sh -c 'sleep 1; open "$0"'` before terminating; Electron's
  // relaunch() does the same job cross-platform.
  app.relaunch()
  setTimeout(() => app.exit(0), 300)
}
