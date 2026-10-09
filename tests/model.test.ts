// The model identity and decoding settings must stay identical to Swift Flowa's WhisperKit setup.
import { describe, expect, it, vi } from 'vitest'
import { cleanTranscript, cliArgs, decoding, ggmlModel, hfCheckpoint, inferenceFields, serverArgs, swiftModelVariant } from '@shared/model'
import { macPermissionResetCommands } from '../src/main/repair'

describe('model parity', () => {
  it('same checkpoint as Swift, unquantized f16 ggml', () => {
    expect(swiftModelVariant).toBe('openai_whisper-large-v3-v20240930_turbo')
    expect(hfCheckpoint).toBe('openai/whisper-large-v3-turbo')
    expect(ggmlModel.fileName).toBe('ggml-large-v3-turbo.bin')
    expect(ggmlModel.fileName).not.toMatch(/q5|q8/)
  })
  it('WhisperKit DecodingOptions defaults', () => {
    expect(decoding).toMatchObject({ temperature: 0, temperatureInc: 0.2, beamSize: 1, logprobThreshold: -1, noSpeechThreshold: 0.6 })
  })
  it('auto language → "auto"', () => {
    expect(inferenceFields(null).language).toBe('auto')
    expect(inferenceFields('da').language).toBe('da')
    expect(inferenceFields('en').response_format).toBe('json')
  })
  it('server binds to loopback only', () => {
    const a = serverArgs('/m.bin', 1234, 4)
    expect(a[a.indexOf('--host') + 1]).toBe('127.0.0.1')
    expect(a).toContain('-bs')
  })
  it('server args only use flags whisper-server v1.9.5 accepts (it exits on unknown args)', () => {
    const supported = new Set(['-m', '--host', '--port', '-t', '-bs', '-bo', '-et', '-lpt', '-nth', '-l', '-ng', '-fa', '-nfa'])
    const flags = serverArgs('/m.bin', 1234, 4).filter((x) => /^--?[a-z]/.test(x))
    for (const f of flags) expect(supported.has(f), f).toBe(true)
    // temperature lives in the per-request fields instead
    expect(inferenceFields(null).temperature).toBe('0')
    expect(inferenceFields(null).temperature_inc).toBe('0.2')
  })
  it('cli args', () => {
    const a = cliArgs('/m.bin', '/a.wav', '/tmp/o', null, 4)
    expect(a[a.indexOf('-l') + 1]).toBe('auto')
    expect(a).toContain('-otxt')
  })
  it('cleans whisper.cpp output', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]\n Hello   world \n')).toBe('Hello world')
  })
})

vi.mock('electron', () => ({ app: {} }))

describe('Repair', () => {
  it('passes bundle path as its own argv element (Swift RepairTests intent)', () => {
    const path = "/Applications/Flowa Test's App.app"
    const cmds = macPermissionResetCommands('com.maxkongerskov.FlowaElectron', path)
    expect(cmds.map((c) => c[1][1])).toEqual(['Microphone', 'ListenEvent', 'Accessibility', path])
    expect(cmds[3][1]).toEqual(['-f', path])
  })
})
