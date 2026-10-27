import { describe, expect, it } from 'vitest'
import { dedupeOverlap, promptTail, stitch } from '@shared/stitch'

describe('live stitching', () => {
  it('drops the words repeated by the 1 s audio overlap', () => {
    expect(dedupeOverlap('we went to the store and', 'And bought milk', true)).toBe('bought milk')
    expect(dedupeOverlap('see you on Monday.', 'Monday, then we talk', true)).toBe('then we talk')
  })
  it('keeps text when nothing repeats', () => {
    expect(dedupeOverlap('hello there', 'general Kenobi', true)).toBe('general Kenobi')
  })
  it('without overlap only removes long echoes (prompt repeated by whisper)', () => {
    expect(dedupeOverlap('I said it is fine', 'fine by me', false)).toBe('fine by me')
    expect(dedupeOverlap('one two three four five', 'two three four five six', false)).toBe('six')
  })
  it('stitches in order, cleans once', () => {
    const text = stitch([
      { text: ' Hello  world. [BLANK_AUDIO] ', overlapped: false },
      { text: '', overlapped: false },
      { text: 'world. This is Flowa', overlapped: true }
    ])
    expect(text).toBe('Hello world. This is Flowa')
  })
  it('prompt tail starts on a word and is bounded', () => {
    const t = promptTail('a'.repeat(50) + ' alpha beta gamma', 12)
    expect(t).toBe('beta gamma')
    expect(promptTail('short')).toBe('short')
  })
})
