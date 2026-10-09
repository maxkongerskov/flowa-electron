// Ports FlowaTests/RecentRingTests.swift + recent.json format compatibility.
import { describe, expect, it } from 'vitest'
import { decodeRecent, encodeRecent, filterRecent, insertingRecent, iso8601, newDictation } from '@shared/recent'

describe('RecentRing', () => {
  it('inserts newest first', () => {
    const a = newDictation('first', null, new Date(1000))
    const b = newDictation('second', 'Notes', new Date(2000))
    const two = insertingRecent(b, insertingRecent(a, [], 100), 100)
    expect(two.map((d) => d.text)).toEqual(['second', 'first'])
  })
  it('caps at limit', () => {
    let items: ReturnType<typeof newDictation>[] = []
    for (let i = 0; i < 5; i++) items = insertingRecent(newDictation(String(i), null, new Date()), items, 3)
    expect(items.map((d) => d.text)).toEqual(['4', '3', '2'])
  })
})

describe('recent.json (Swift JSONEncoder .iso8601 + sortedKeys)', () => {
  it('reads a file written by the Swift app', () => {
    const swift = `[
  {
    "date" : "2026-10-02T20:41:07Z",
    "id" : "6F1C2B9E-1D2A-4C55-9B57-2B7F1E4B9A10",
    "targetAppName" : "Notes",
    "text" : "Hello Flowa"
  },
  {
    "date" : "2026-10-02T20:40:00Z",
    "id" : "0A1B2C3D-0000-4000-8000-000000000000",
    "text" : "No target"
  }
]`
    const items = decodeRecent(swift)
    expect(items).toHaveLength(2)
    expect(items[0]).toEqual({ id: '6F1C2B9E-1D2A-4C55-9B57-2B7F1E4B9A10', text: 'Hello Flowa', targetAppName: 'Notes', date: '2026-10-02T20:41:07Z' })
    expect(items[1].targetAppName).toBeNull()
  })
  it('writes sorted keys, second-precision UTC dates, omits null target, round-trips', () => {
    const d = newDictation('x', null, new Date('2026-10-09T09:01:02.345Z'), 'ABC')
    expect(d.date).toBe('2026-10-09T09:01:02Z')
    const json = encodeRecent([d])
    expect(Object.keys(JSON.parse(json)[0])).toEqual(['date', 'id', 'text'])
    expect(decodeRecent(json)).toEqual([d])
  })
  it('uuid is upper-case like Swift', () => {
    expect(newDictation('a', null, new Date()).id).toMatch(/^[0-9A-F-]{36}$/)
  })
  it('garbage → empty', () => expect(decodeRecent('nope')).toEqual([]))
  it('iso8601 strips millis', () => expect(iso8601(new Date(0))).toBe('1970-01-01T00:00:00Z'))
  it('filters case-insensitively', () => {
    const items = [newDictation('Hello World', null, new Date()), newDictation('bye', null, new Date())]
    expect(filterRecent(items, ' hello ').map((d) => d.text)).toEqual(['Hello World'])
    expect(filterRecent(items, '')).toHaveLength(2)
  })
})
