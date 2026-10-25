// OS device-id parsers. The raw id is fingerprinted and never sent.

export function parseIOPlatformUUID(ioregOutput: string): string | null {
  const match = ioregOutput.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
  const id = match?.[1]?.trim()
  return id ? id : null
}

export function parseMachineGuid(regOutput: string): string | null {
  const match = regOutput.match(/MachineGuid\s+REG_\w+\s+(\S+)/i)
  const id = match?.[1]?.trim()
  return id ? id : null
}

export function parseMachineId(text: string): string | null {
  const line = text.trim().split(/\s+/)[0]?.trim() ?? ''
  if (line.length < 8) return null
  if (!/^[A-Za-z0-9-]+$/.test(line)) return null
  return line
}

export function readLinuxMachineId(readFile: (path: string) => string | null): string | null {
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    const text = readFile(path)
    if (!text) continue
    const id = parseMachineId(text)
    if (id) return id
  }
  return null
}

/**
 * Prefer the OS id. If it cannot be read, reuse a persisted random id so the
 * device stays stable. A missing OS id must not block dictation or activation.
 */
export function resolveRawDeviceId(
  platformId: string | null,
  readPersisted: () => string | null,
  writePersisted: (id: string) => void,
  randomUuid: () => string
): string {
  const fromOs = platformId?.trim()
  if (fromOs) return fromOs
  const existing = readPersisted()?.trim()
  if (existing) return existing
  const created = randomUuid()
  try {
    writePersisted(created)
  } catch {
    /* the in-memory id still works for this launch */
  }
  return created
}
