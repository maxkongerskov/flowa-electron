export const BAR_CRASH_MESSAGE =
  'The dictation bar crashed and the recording was cancelled. Press the shortcut to try again.'

/** What a pending Flow Bar request resolves to when the renderer dies. */
export function crashReply(channel: string): unknown {
  if (channel === 'capture:start') return { ok: false, message: BAR_CRASH_MESSAGE }
  return null
}
