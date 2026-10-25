export function versionMatches(actual: string, expected: string): boolean
export function readVersionWhenReady(
  readVersion: () => string | Promise<string>,
  expected: string,
  timeoutMs: number,
  pauseMs?: number
): Promise<void>
