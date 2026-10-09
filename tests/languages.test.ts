// Ports FlowaTests/LanguageOptionTests.swift.
import { describe, expect, it } from 'vitest'
import { allLanguages, filterLanguages, languageDisplayName } from '@shared/languages'

describe('LanguageOption', () => {
  it('display names', () => {
    expect(languageDisplayName('en')).toBe('English')
    expect(languageDisplayName('da')).toBe('Danish')
    expect(languageDisplayName('auto')).toBe('Auto-detect')
  })
  it('falls back to code', () => expect(languageDisplayName('zz-unknown')).toBe('zz-unknown'))
  it('filters by name and code prefix', () => {
    expect(filterLanguages('dani').some((o) => o.code === 'da')).toBe(true)
    expect(filterLanguages('da').some((o) => o.code === 'da')).toBe(true)
  })
  it('empty query returns all; >90 entries; auto first then sorted', () => {
    expect(filterLanguages('').length).toBe(allLanguages.length)
    expect(allLanguages.length).toBeGreaterThan(90)
    expect(allLanguages.length).toBe(101)
    expect(allLanguages[0].code).toBe('auto')
    const names = allLanguages.slice(1).map((o) => o.displayName)
    expect([...names].sort()).toEqual(names)
  })
})
