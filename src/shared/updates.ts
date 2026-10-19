// Pure update-check policy. electron-updater fetches the GitHub channel file
// (latest.yml / latest-mac.yml / latest-linux.yml); this module decides whether
// that result is worth showing and which installer link to offer.
// Unsigned builds never auto-replace themselves — the banner only opens a URL.

export const UPDATE_REPOSITORY = {
  owner: 'maxkongerskov',
  repo: 'flowa-electron'
} as const

export const UPDATE_CHECK_UNPACKAGED = 'Update checks run in the installed app.'
export const UPDATE_CHECK_FAILED = "Couldn't check for updates. Check your connection and try again."

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'skipped'; message: string }
  | { kind: 'error'; message: string }
  | {
      kind: 'available'
      version: string
      notes: string
      releaseUrl: string
      downloadUrl: string | null
      downloadName: string | null
    }

export interface UpdateFeedInfo {
  version: string
  notes?: unknown
  files?: readonly string[]
}

export type UpdateCheckOutcome =
  | { ok: true; info: UpdateFeedInfo | null; isUpdateAvailable: boolean }
  | { ok: false }

interface SemVer {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i
const INSTALLER = /\.(dmg|exe|AppImage|deb)$/i
const NOTES_LIMIT = 220

export function parseSemver(input: string): SemVer | null {
  const match = SEMVER.exec(input.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : []
  }
}

/** -1 when a < b, 0 when equal, 1 when a > b. Unparseable versions compare equal. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  if (left.major !== right.major) return left.major > right.major ? 1 : -1
  if (left.minor !== right.minor) return left.minor > right.minor ? 1 : -1
  if (left.patch !== right.patch) return left.patch > right.patch ? 1 : -1
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const count = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < count; i++) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNum = /^\d+$/.test(x)
    const yNum = /^\d+$/.test(y)
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0
}

export function stripVersion(version: string): string | null {
  const parsed = parseSemver(version)
  if (!parsed) return null
  const core = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.pre.length > 0 ? `${core}-${parsed.pre.join('.')}` : core
}

export function releasePageUrl(version: string): string {
  const clean = stripVersion(version) ?? version.trim().replace(/^v/i, '')
  return `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/tag/v${clean}`
}

export function assetDownloadUrl(version: string, fileName: string): string {
  const clean = stripVersion(version) ?? version.trim().replace(/^v/i, '')
  return `https://github.com/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/releases/download/v${clean}/${encodeURIComponent(fileName)}`
}

export function isFlowaReleaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const prefix = `/${UPDATE_REPOSITORY.owner}/${UPDATE_REPOSITORY.repo}/`
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith(prefix)
  } catch {
    return false
  }
}

/** Installer file name this repo publishes for the platform, or null when unknown. */
export function expectedInstallerName(platform: string, arch: string, version: string): string | null {
  const clean = stripVersion(version)
  if (!clean) return null
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `Flowa-${clean}-${arch}.dmg`
  if (platform === 'win32' && (arch === 'x64' || arch === 'arm64')) return `Flowa-Setup-${clean}-${arch}.exe`
  if (platform === 'linux' && arch === 'x64') return `Flowa-${clean}.AppImage`
  if (platform === 'linux' && arch === 'arm64') return `Flowa-${clean}-arm64.AppImage`
  return null
}

/**
 * v1.2.0's latest-mac.yml lists only the x64 dmg, while the arm64 dmg is still
 * on the release. Offer these names even when the channel file omitted them.
 * Archs that have never been published stay null unless the feed lists them.
 */
function stableAssetName(platform: string, arch: string): boolean {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return true
  if (platform === 'win32' && arch === 'x64') return true
  if (platform === 'linux' && arch === 'x64') return true
  return false
}

export function fileBaseName(urlOrName: string): string {
  try {
    const path = urlOrName.includes('://') ? new URL(urlOrName).pathname : urlOrName
    const base = path.split('/').pop() ?? ''
    return decodeURIComponent(base.split('?')[0] ?? '')
  } catch {
    return urlOrName.split('/').pop() ?? urlOrName
  }
}

function nameHasArch(name: string, arch: string): boolean {
  const lower = name.toLowerCase()
  const markers = arch === 'x64' ? ['-x64', '_amd64', '_x86_64'] : arch === 'arm64' ? ['-arm64', '_arm64', '_aarch64'] : [`-${arch}`, `_${arch}`]
  return markers.some((marker) => lower.includes(marker))
}

function installerMatches(name: string, platform: string, arch: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase()
  if (platform === 'darwin') return ext === 'dmg' && nameHasArch(name, arch)
  if (platform === 'win32') return ext === 'exe' && nameHasArch(name, arch)
  if (platform === 'linux' && ext === 'appimage') {
    if (arch === 'x64') return !nameHasArch(name, 'arm64')
    return nameHasArch(name, arch)
  }
  if (platform === 'linux' && ext === 'deb') {
    if (arch === 'x64') return nameHasArch(name, 'x64')
    if (arch === 'arm64') return nameHasArch(name, 'arm64')
  }
  return false
}

export function pickInstallerName(platform: string, arch: string, version: string, files: readonly string[]): string | null {
  const expected = expectedInstallerName(platform, arch, version)
  const listed = [...new Set(files.map(fileBaseName).filter((name) => INSTALLER.test(name)))]
  const matches = listed.filter((name) => installerMatches(name, platform, arch))
  if (expected && matches.includes(expected)) return expected
  if (matches.length > 0) {
    const appImage = matches.find((name) => name.toLowerCase().endsWith('.appimage'))
    return appImage ?? matches[0] ?? null
  }
  if (expected && stableAssetName(platform, arch)) return expected
  return null
}

export function formatReleaseNotes(notes: unknown, maxLength = NOTES_LIMIT): string {
  const raw = notesToText(notes)
  if (!raw) return ''
  const decoded = decodeEntities(raw.includes('&lt;') ? decodeEntities(raw) : raw)
  const text = decodeEntities(
    decoded
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= maxLength) return text
  const cut = text.slice(0, maxLength - 1)
  const space = cut.lastIndexOf(' ')
  const trimmed = (space > 80 ? cut.slice(0, space) : cut).trimEnd()
  return `${trimmed}…`
}

function notesToText(notes: unknown): string {
  if (typeof notes === 'string') return notes
  if (!Array.isArray(notes)) return ''
  return notes
    .map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'note' in entry) {
        const note = (entry as { note?: unknown }).note
        return typeof note === 'string' ? note : ''
      }
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, digits: string) => codePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
}

function codePoint(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return ''
  return String.fromCodePoint(value)
}

export function buildUpdateOffer(args: {
  currentVersion: string
  latestVersion: string
  notes: unknown
  files: readonly string[]
  platform: string
  arch: string
}): Extract<UpdateState, { kind: 'available' }> | null {
  if (!isNewerVersion(args.latestVersion, args.currentVersion)) return null
  const version = stripVersion(args.latestVersion)
  if (!version) return null
  const downloadName = pickInstallerName(args.platform, args.arch, version, args.files)
  const downloadUrl = downloadName ? assetDownloadUrl(version, downloadName) : null
  return {
    kind: 'available',
    version,
    notes: formatReleaseNotes(args.notes),
    releaseUrl: releasePageUrl(version),
    downloadUrl: downloadUrl && isFlowaReleaseUrl(downloadUrl) ? downloadUrl : null,
    downloadName
  }
}

/**
 * What the UI should show after a check.
 * Launch failures stay quiet. A manual check explains itself.
 * An offer already on screen survives a later network failure, and clears
 * once a successful check says this install is current.
 */
export function interpretUpdateCheck(args: {
  packaged: boolean
  manual: boolean
  currentVersion: string
  platform: string
  arch: string
  previous: UpdateState
  outcome: UpdateCheckOutcome
}): UpdateState {
  if (!args.packaged) {
    if (!args.manual) return args.previous.kind === 'checking' ? { kind: 'idle' } : args.previous
    return { kind: 'skipped', message: UPDATE_CHECK_UNPACKAGED }
  }
  // Network error, or the updater refused to run (unpackaged Linux package, missing channel file).
  if (!args.outcome.ok || args.outcome.info == null) {
    if (args.previous.kind === 'available') return args.previous
    if (args.manual) return { kind: 'error', message: UPDATE_CHECK_FAILED }
    return { kind: 'idle' }
  }
  const offer = args.outcome.isUpdateAvailable
    ? buildUpdateOffer({
        currentVersion: args.currentVersion,
        latestVersion: args.outcome.info.version,
        notes: args.outcome.info.notes,
        files: args.outcome.info.files ?? [],
        platform: args.platform,
        arch: args.arch
      })
    : null
  if (offer) return offer
  // The feed answered. Equal, older, or withheld (staged rollout / OS minimum).
  return args.manual ? { kind: 'current' } : { kind: 'idle' }
}
