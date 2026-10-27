import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FROM_TAG, LONG_DICTATION_SECONDS, TO, judgeLongDictation, loopPcmToWav, parseDictationLog, readPcm16
} from '../scripts/real-update-pr7.mjs'

const publishedLog = [
  '[Flowa] version 1.2.3',
  '[Flowa] speech plan: backend=cpu binary=default gpu=false',
  '[Flowa] Whisper ready in 48s (server, backend=cpu, gpu=false)',
  '[selftest] transcript (305.40s, lang=en): null',
  '[selftest] decode error: Transcription failed: fetch failed'
].join('\n')

const builtLog = [
  '[Flowa] version 1.2.4',
  '[Flowa] speech plan: backend=cpu binary=default gpu=false',
  '[Flowa] Whisper ready in 47s (server, backend=cpu, gpu=false)',
  '[selftest] transcript (412.00s, lang=en): "this is a long dictation test for Flowa"'
].join('\n')

describe('PR #7 real update', () => {
  it('targets published 1.2.3 and a test-only 1.2.4, without the release private key', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const script = readFileSync('scripts/real-update-pr7.mjs', 'utf8')
    expect(FROM_TAG).toBe('v1.2.3')
    expect(TO).toBe('1.2.4')
    expect(pkg.version).toBe(TO)
    expect(LONG_DICTATION_SECONDS).toBe(8 * 60)
    expect(script).not.toContain('FLOWA_UPDATE_KEY')
    expect(script).not.toContain('serve-mac')
  })

  it('loops 16-bit speech out to the requested length', () => {
    const pcm = Buffer.alloc(4)
    pcm.writeInt16LE(1000, 0)
    pcm.writeInt16LE(-1000, 2)
    const wav = loopPcmToWav(pcm, 1)
    expect(wav.length).toBe(44 + 16000 * 2)
    expect(readPcm16(wav).length).toBe(16000 * 2)
    expect(wav.readInt16LE(44)).toBe(1000)
    expect(wav.readInt16LE(46)).toBe(-1000)
    expect(wav.readInt16LE(48)).toBe(1000)
  })

  it('accepts the published timeout and the PR build text', () => {
    const published = parseDictationLog(publishedLog)
    const built = parseDictationLog(builtLog)
    expect(published.decodeSeconds).toBeCloseTo(305.4)
    expect(published.hasText).toBe(false)
    expect(published.decodeError).toContain('fetch failed')
    expect(built.hasText).toBe(true)
    expect(built.decodeSeconds).toBe(412)
    expect(judgeLongDictation(published, built)).toEqual([])
  })

  it('rejects a fast decode that never reaches the 300s headers timeout', () => {
    const published = parseDictationLog(publishedLog.replace('305.40s', '40.00s').replace('fetch failed', 'nope'))
    const built = parseDictationLog(builtLog.replace('412.00s', '90.00s'))
    const problems = judgeLongDictation(published, built)
    expect(problems.some((line) => line.includes('fetch failed'))).toBe(true)
    expect(problems.some((line) => line.includes('published decode was'))).toBe(true)
    expect(problems.some((line) => line.includes('pr build decode was'))).toBe(true)
  })
})
