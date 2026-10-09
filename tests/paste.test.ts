// TextInserter port: clipboard-first contract + helper outcome mapping + debug fixture gate.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const clip = { text: 'previous clipboard' }
const helperCalls: string[][] = []
let helperReply = { code: 0, out: 'pasted front=PasteTarget' }
let axTrusted = true

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  clipboard: { writeText: (t: string) => (clip.text = t), readText: () => clip.text },
  systemPreferences: { isTrustedAccessibilityClient: () => axTrusted }
}))
vi.mock('../src/main/permissions', () => ({ linuxPasteTool: () => null }))
vi.mock('../src/main/macHelper', () => ({
  macHelperAvailable: () => true,
  frontmostApp: async () => null,
  helper: async (args: string[]) => {
    helperCalls.push(args)
    return helperReply
  }
}))

Object.defineProperty(process, 'platform', { value: 'darwin' })
const { paste, helperPasteOutcome } = await import('../src/main/textInserter')
const { debugFixturePath } = await import('../src/main/pipeline')

const target = { platform: 'darwin', name: 'PasteTarget', pid: 4242, bundleId: null }

describe('paste (Swift TextInserter contract)', () => {
  beforeEach(() => {
    clip.text = 'previous clipboard'
    helperCalls.length = 0
    helperReply = { code: 0, out: 'pasted front=PasteTarget' }
    axTrusted = true
  })

  it('writes the transcript to the clipboard and leaves it there (no restore)', async () => {
    const r = await paste('hello flowa', target)
    expect(r).toEqual({ kind: 'pasted', appName: 'PasteTarget' })
    expect(clip.text).toBe('hello flowa')
    await new Promise((res) => setTimeout(res, 50))
    expect(clip.text).toBe('hello flowa')
  })

  it('asks the helper to paste into the captured target pid', async () => {
    await paste('x', target)
    expect(helperCalls).toEqual([['paste', '4242']])
  })

  it('no target → clipboard only, helper not invoked', async () => {
    const r = await paste('only clip', null)
    expect(r.kind).toBe('clipboardOnly')
    expect(clip.text).toBe('only clip')
    expect(helperCalls).toHaveLength(0)
  })

  it('Accessibility off → clipboard keeps text, no ⌘V', async () => {
    axTrusted = false
    const r = await paste('t', target)
    expect(r.kind).toBe('accessibilityMissing')
    expect(clip.text).toBe('t')
    expect(helperCalls).toHaveLength(0)
  })

  it('target not frontmost → clipboard only with reason (never pastes into another app)', async () => {
    helperReply = { code: 5, out: 'not-frontmost target=PasteTarget front=Orca' }
    const r = await paste('t', target)
    expect(r).toEqual({ kind: 'clipboardOnly', reason: 'targetNotFrontmost' })
    expect(clip.text).toBe('t')
  })

  it('maps helper results', () => {
    expect(helperPasteOutcome(0, 'pasted front=X', 'X').kind).toBe('pasted')
    expect(helperPasteOutcome(4, 'accessibility-missing', 'X').kind).toBe('accessibilityMissing')
    expect(helperPasteOutcome(5, 'target-gone', 'X')).toEqual({ kind: 'clipboardOnly', reason: 'targetNotFrontmost' })
    expect(helperPasteOutcome(1, 'event-create-failed', 'X')).toEqual({ kind: 'clipboardOnly', reason: 'pasteFailed' })
    expect(helperPasteOutcome(0, '', 'X')).toEqual({ kind: 'clipboardOnly', reason: 'pasteFailed' })
  })
})

describe('debug fixture gate', () => {
  it('needs FLOWA_DEBUG=1 and an existing absolute path', () => {
    const f = path.join(os.tmpdir(), `flowa-fixture-${process.pid}.wav`)
    fs.writeFileSync(f, 'x')
    expect(debugFixturePath({ FLOWA_DEBUG_FIXTURE: f })).toBeNull()
    expect(debugFixturePath({ FLOWA_DEBUG: '1', FLOWA_DEBUG_FIXTURE: 'rel.wav' })).toBeNull()
    expect(debugFixturePath({ FLOWA_DEBUG: '1', FLOWA_DEBUG_FIXTURE: f + '.missing' })).toBeNull()
    expect(debugFixturePath({ FLOWA_DEBUG: '1', FLOWA_DEBUG_FIXTURE: f })).toBe(f)
    fs.rmSync(f)
  })
})
