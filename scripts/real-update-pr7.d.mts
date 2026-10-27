export const FROM_TAG: string
export const TO: string
export const LONG_DICTATION_SECONDS: number

export function versionMatches(actual: string, expected: string): boolean
export function readVersionWhenReady(
  readVersion: () => string | Promise<string>,
  expected: string,
  timeoutMs: number,
  pauseMs?: number
): Promise<void>

export function readPcm16(wav: Buffer): Buffer
export function loopPcmToWav(pcm: Buffer, seconds: number, sampleRate?: number): Buffer

export interface DictationLog {
  version: string | null
  plan: string | null
  backend: string | null
  gpu: string | null
  decodeSeconds: number | null
  payload: string | null
  decodeError: string | null
  failed: boolean
  hasText: boolean
}

export function parseDictationLog(text: string): DictationLog
export function judgeLongDictation(published: DictationLog, built: DictationLog): string[]
