export function readVersionWhenReady(
  readVersion: () => string | Promise<string>,
  expected: string,
  timeoutMs: number,
  pauseMs?: number
): Promise<void>
