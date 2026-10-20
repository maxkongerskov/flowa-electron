// E2E builds only. The first boot still has FLOWA_E2E_* because the rehearsal
// spawned it. ShipIt (LaunchServices) and NSIS (ExecShellAsUser) start the
// next version without that environment, so the settings live in the login
// user's app-support folder. os.userInfo().homedir comes from the account
// database, not from HOME, which the rehearsal overrides.

import fs from 'node:fs'
import os from 'node:os'
import { isE2EBuild } from '@shared/updateTrust'
import { restoreE2ESession, writeE2ESessionFile } from '../../scripts/update-install.mjs'

export function installE2ESession(): void {
  if (!isE2EBuild()) return
  restoreE2ESession({
    e2e: true,
    env: process.env,
    platform: process.platform,
    loginHome: os.userInfo().homedir,
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    writeText: writeE2ESessionFile
  })
}
