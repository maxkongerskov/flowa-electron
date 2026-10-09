// Dev-only self-tests, driven by env vars so each port stage can be verified
// without pressing the hotkey. Never active in packaged builds.
//
//   FLOWA_SELFTEST=capture             record 3 s from the default mic, log stats
//   FLOWA_SELFTEST=transcribe:<file>   transcribe a 16 kHz WAV via the engine, log text
//   FLOWA_SELFTEST_QUIT=1              quit when the self-test finishes

import { app } from 'electron'
import type { DictationPipeline, CaptureBridge } from './pipeline'

export async function runSelfTest(pipeline: DictationPipeline, capture: CaptureBridge): Promise<void> {
  const spec = process.env.FLOWA_SELFTEST
  if (!spec || app.isPackaged) return
  const done = (): void => {
    if (process.env.FLOWA_SELFTEST_QUIT) setTimeout(() => app.quit(), 300)
  }
  try {
    if (spec === 'capture') {
      const gen = 9000
      const res = await capture.start({ deviceId: 'default', maxDurationSeconds: 60, generation: gen })
      if (!res.ok) {
        console.log(`[selftest] capture start FAILED: ${res.message}`)
        return done()
      }
      await new Promise((r) => setTimeout(r, 3000))
      const out = await capture.stop(gen)
      console.log(
        `[selftest] capture ok samples=${out.samples.length} (~${(out.samples.length / 16000).toFixed(2)}s @16k) peak=${out.peak.toFixed(4)} kind=${out.deviceKind}`
      )
    } else if (spec.startsWith('transcribe:')) {
      const file = spec.slice('transcribe:'.length)
      const t = pipeline.transcriber
      await t.loadIfNeeded()
      console.log(`[selftest] engine status=${JSON.stringify(t.status)} info=${JSON.stringify(t.engineInfo)}`)
      const lang = process.env.FLOWA_SELFTEST_LANG || null
      const t0 = Date.now()
      const text = await t.transcribe(file, lang)
      console.log(`[selftest] transcript (${((Date.now() - t0) / 1000).toFixed(2)}s, lang=${lang ?? 'auto'}): ${JSON.stringify(text)}`)
      if (!text) console.log(`[selftest] decode error: ${t.lastDecodeErrorMessage ?? '-'}`)
    }
  } catch (err) {
    console.log(`[selftest] FAILED: ${(err as Error).stack ?? err}`)
  }
  done()
}
