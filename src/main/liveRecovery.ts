// Beta live transcription: where spill WAVs live, and how many failed ones we keep.
import fs from 'node:fs'
import path from 'node:path'
import { paths } from './paths'

export const keepRecoveryFiles = 5

/** userData/live-recordings (spill WAVs; failed ones are kept for a retry). */
export function liveRecoveryDir(): string {
  return path.join(paths.userData, 'live-recordings')
}

/** Keep the newest `keep` WAVs (always including `keepPath`), delete older ones. */
export function pruneRecovery(dir: string, keepPath: string | null, keep = keepRecoveryFiles): void {
  let files: { f: string; t: number }[] = []
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
  } catch {
    return
  }
  files.sort((a, b) => b.t - a.t)
  let kept = 0
  for (const { f } of files) {
    if (f === keepPath || kept < keep) {
      kept++
      continue
    }
    fs.rmSync(f, { force: true })
  }
}
