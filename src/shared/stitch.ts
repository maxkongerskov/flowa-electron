// Live transcription: join per-segment text into one transcript.
import { cleanTranscript } from './model'

/** Last ~maxChars of text, starting on a word boundary (prompt for the next segment). */
export function promptTail(text: string, maxChars = 200): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= maxChars) return t
  const cut = t.slice(t.length - maxChars)
  const sp = cut.indexOf(' ')
  return sp >= 0 ? cut.slice(sp + 1) : cut
}

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Drop words at the start of `next` that repeat the end of `prev`.
 * With audio overlap (hard cut) any 1..maxWords match counts; without it, only
 * long runs (>= 4 words), which are whisper echoing the prompt.
 */
export function dedupeOverlap(prev: string, next: string, overlapped: boolean, maxWords = 10): string {
  const a = prev.split(/\s+/).filter(Boolean)
  const b = next.split(/\s+/).filter(Boolean)
  const minK = overlapped ? 1 : 4
  const limit = Math.min(maxWords, a.length, b.length)
  for (let k = limit; k >= minK; k--) {
    let ok = true
    for (let i = 0; i < k; i++) {
      const x = norm(a[a.length - k + i])
      if (!x || x !== norm(b[i])) {
        ok = false
        break
      }
    }
    if (ok) return b.slice(k).join(' ')
  }
  return b.join(' ')
}

export interface StitchPart {
  text: string
  overlapped: boolean
}

/** Join parts in order, de-duplicating overlaps, then clean once. */
export function stitch(parts: StitchPart[]): string {
  let acc = ''
  for (const p of parts) {
    // markers like [BLANK_AUDIO] must not hide an overlap; final clean below still runs once
    const raw = cleanTranscript(p.text)
    if (!raw) continue
    const add = acc ? dedupeOverlap(acc, raw, p.overlapped) : raw
    if (add) acc = acc ? `${acc} ${add}` : add
  }
  return cleanTranscript(acc)
}
