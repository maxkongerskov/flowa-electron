export function hashFile(file: string): Promise<{ sha512: string; size: number }>
export function channelForArtifact(name: string): string | null
export function sortFeedFiles(names: string[]): string[]
export function macZipName(version: string, arch: 'arm64' | 'x64'): string
export function wantsBlockMap(name: string): boolean
export function renderUpdateYaml(doc: {
  version: string
  files: { url: string; sha512: string; size: number; ed25519?: string }[]
  releaseDate: string
}): string
export function ensureBlockMap(filePath: string): Promise<void>
export function macArtifactGaps(names: string[], macArch?: 'arm64' | 'x64' | null): string[]
export function writeUpdateFeeds(
  dir: string,
  version: string,
  options?: { releaseDate?: string; blockMaps?: boolean; privateKeyPem?: string | null; macArch?: 'arm64' | 'x64' }
): Promise<string[]>
export function verifyUpdateFeeds(
  dir: string,
  version: string,
  options?: {
    requireSignatures?: boolean
    publicKeyPem?: string | null
    requireBlockMaps?: boolean
    macArch?: 'arm64' | 'x64'
  }
): Promise<string[]>
