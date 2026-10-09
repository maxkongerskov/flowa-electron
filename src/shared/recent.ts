// Port of the Dictation model + RecentRing + recent.json persistence format
// from Flowa/Dictation/DictationPipeline.swift.
//
// On-disk format matches Swift's JSONEncoder(.iso8601, [.prettyPrinted, .sortedKeys]):
//   [{ "date": "2026-10-09T09:01:00Z", "id": "UUID", "targetAppName": "Notes", "text": "…" }]
// so a Swift recent.json can be read as-is.

export interface Dictation {
  id: string
  text: string
  targetAppName: string | null
  /** ISO-8601, second precision, UTC ("Z"), like Swift's .iso8601 strategy. */
  date: string
}

export const recentLimit = 100

export function iso8601(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function newDictation(text: string, targetAppName: string | null, date: Date, id?: string): Dictation {
  return { id: id ?? uuidUpper(), text, targetAppName, date: iso8601(date) }
}

/** Swift UUID().uuidString is upper-case. */
export function uuidUpper(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID().toUpperCase()
  const hex = [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`.toUpperCase()
}

/** Pure recent-list ring helper: newest first, capped at `limit`. */
export function insertingRecent(entry: Dictation, items: Dictation[], limit: number): Dictation[] {
  const next = [entry, ...items]
  return next.length > limit ? next.slice(0, limit) : next
}

/** Decode tolerant of bad entries (Swift's decoder drops the whole file on error; we keep the good ones). */
export function decodeRecent(json: string): Dictation[] {
  try {
    const raw = JSON.parse(json)
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r) => r && typeof r.text === 'string' && typeof r.date === 'string')
      .map((r) => ({
        id: typeof r.id === 'string' ? r.id : uuidUpper(),
        text: r.text,
        targetAppName: typeof r.targetAppName === 'string' ? r.targetAppName : null,
        date: r.date
      }))
  } catch {
    return []
  }
}

/** Encode with sorted keys + pretty print, omitting null targetAppName like Swift does. */
export function encodeRecent(items: Dictation[]): string {
  const sorted = items.map((d) => {
    const o: Record<string, string> = { date: d.date, id: d.id }
    if (d.targetAppName != null) o.targetAppName = d.targetAppName
    o.text = d.text
    return o
  })
  return JSON.stringify(sorted, null, 2)
}

export function filterRecent(items: Dictation[], query: string): Dictation[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter((d) => d.text.toLowerCase().includes(q))
}
