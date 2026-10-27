// Pipeline wiring for the beta flag: off = today's path, on = live session.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  saved: [] as { text: string; targetAppName: string | null }[][],
  paste: vi.fn(),
  captureTarget: vi.fn(),
  transcribe: vi.fn(),
  transcribeSegment: vi.fn(),
  dir: ''
}))

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir(), getVersion: () => '0' }, net: {}, clipboard: {} }))
vi.mock('../src/main/store', () => ({
  prefs: { get: (k: string) => h.prefs[k], set: () => {} },
  loadRecent: () => [],
  saveRecent: (r: { text: string; targetAppName: string | null }[]) => h.saved.push(r)
}))
vi.mock('../src/main/textInserter', () => ({ paste: h.paste, captureTarget: h.captureTarget }))
vi.mock('../src/main/liveRecovery', () => ({ liveRecoveryDir: () => h.dir, pruneRecovery: () => {} }))
vi.mock('../src/main/transcriber', () => ({
  Transcriber: class extends EventEmitter {
    status = { kind: 'ready' }
    lastDecodeErrorMessage: string | null = null
    needsSetup = false
    loadIfNeeded = async (): Promise<void> => {}
    transcribe = h.transcribe
    transcribeSegment = h.transcribeSegment
  }
}))

import { DictationPipeline, type CaptureBridge } from '../src/main/pipeline'
import type { CaptureResult, CaptureStartRequest } from '@shared/types'

const sr = 16_000
const startTarget = { platform: 'darwin', name: 'Notes', pid: 1 }
const stopTarget = { platform: 'darwin', name: 'Mail', pid: 2 }

function bridge(samples: Float32Array) {
  const starts: CaptureStartRequest[] = []
  const b: CaptureBridge & { starts: CaptureStartRequest[] } = {
    starts,
    onBlock: null,
    async start(req) {
      starts.push(req)
      return { ok: true }
    },
    async stop(generation): Promise<CaptureResult> {
      return { generation, samples, peak: 0.5, deviceKind: 'standard', stoppedForMaxDuration: false }
    },
    cancel: vi.fn()
  }
  return b
}
const speech = (seconds: number): Float32Array => new Float32Array(seconds * sr).fill(0.2)

beforeEach(() => {
  h.prefs = { 'flowa.maxDurationMinutes': 60, 'flowa.language': 'en', 'flowa.experimental.liveTranscription': false }
  h.saved = []
  h.paste.mockReset().mockImplementation(async (_t: string, target: { name: string } | null) => (target ? { kind: 'pasted', appName: target.name } : { kind: 'clipboardOnly' }))
  h.captureTarget.mockReset().mockResolvedValue(stopTarget)
  h.transcribe.mockReset().mockResolvedValue('single pass text')
  let n = 0
  h.transcribeSegment.mockReset().mockImplementation(async () => ({ text: `part${n++}`, language: null }))
  h.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowa-livepipe-'))
})

describe('beta flag off (default) = today', () => {
  it('buffers in the renderer, single-pass transcribe, pastes into the start target', async () => {
    delete h.prefs['flowa.experimental.liveTranscription'] // missing pref = off
    const cap = bridge(speech(3))
    const p = new DictationPipeline(cap)
    await p.start(Promise.resolve(startTarget), 'default')
    expect(cap.starts[0]).toEqual({ deviceId: 'default', maxDurationSeconds: 3600, generation: 1 })
    expect('stream' in cap.starts[0]).toBe(false)
    await p.commit('en')
    expect(h.transcribe).toHaveBeenCalledTimes(1)
    expect(h.transcribeSegment).not.toHaveBeenCalled()
    expect(h.captureTarget).not.toHaveBeenCalled()
    expect(h.paste).toHaveBeenCalledWith('single pass text', startTarget)
    expect(h.saved.at(-1)![0]).toMatchObject({ text: 'single pass text', targetAppName: 'Notes' })
    expect(fs.readdirSync(h.dir)).toEqual([])
  })
})

describe('beta flag on', () => {
  beforeEach(() => {
    h.prefs['flowa.experimental.liveTranscription'] = true
  })

  async function record(seconds: number) {
    const cap = bridge(new Float32Array(0)) // streaming: stop reply carries no samples
    const p = new DictationPipeline(cap)
    await p.start(Promise.resolve(startTarget), 'default')
    for (let i = 0; i < seconds; i++) cap.onBlock!(cap.starts[0].generation, speech(1))
    return { cap, p }
  }

  it('streams, transcribes segments in the background, then clipboard + paste at the focus at stop + Recent', async () => {
    const { cap, p } = await record(100)
    expect(cap.starts[0].stream).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.transcribeSegment).toHaveBeenCalledTimes(1) // 0–90 s done before stop
    await p.commit('en')
    expect(h.transcribe).not.toHaveBeenCalled()
    expect(h.transcribeSegment).toHaveBeenCalledTimes(2)
    expect(h.captureTarget).toHaveBeenCalledTimes(1)
    // paste() puts the text on the clipboard first, then pastes (see paste.test.ts)
    expect(h.paste).toHaveBeenCalledWith('part0 part1', stopTarget)
    expect(h.saved.at(-1)![0]).toMatchObject({ text: 'part0 part1', targetAppName: 'Mail' })
    expect(p.lastErrorMessage).toBeNull()
    expect(fs.readdirSync(h.dir)).toEqual([]) // spill deleted on success
  })

  it('a failed segment: partial text to clipboard (no paste) + Recent, audio kept', async () => {
    let n = 0
    h.transcribeSegment.mockImplementation(async () => {
      if (n++ >= 1) throw new Error('engine stopped')
      return { text: 'first part', language: null }
    })
    const { p } = await record(100)
    await p.commit('en')
    expect(h.paste).toHaveBeenCalledWith('first part', null)
    expect(h.saved.at(-1)![0]).toMatchObject({ text: 'first part', targetAppName: null })
    expect(p.lastErrorMessage).toContain('on the clipboard and in Recent')
    const kept = fs.readdirSync(h.dir)
    expect(kept).toHaveLength(1)
    expect(p.lastErrorMessage).toContain(kept[0])
  })

  it('cancel deletes the spill and pastes nothing', async () => {
    const { p } = await record(5)
    p.cancel()
    expect(fs.readdirSync(h.dir)).toEqual([])
    expect(h.paste).not.toHaveBeenCalled()
  })

  it('blocks from an old generation are ignored', async () => {
    const { cap, p } = await record(3)
    cap.onBlock!(999, speech(50))
    await p.commit('en')
    expect(h.transcribeSegment).toHaveBeenCalledTimes(1)
  })
})
