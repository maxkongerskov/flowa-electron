export function cliInvocation(
  name: string,
  args: string[],
  nodePath?: string,
  modulesDir?: string
): { command: string; args: string[] }
export function macFeedOptions(
  arch: 'arm64' | 'x64',
  privateKeyPem: string
): {
  privateKeyPem: string
  blockMaps: false
  releaseDate: string
  macArch: 'arm64' | 'x64'
}
export function assertTamperRehearsal(
  positive: string,
  negative: string,
  label?: string,
  from?: string,
  to?: string
): void
export function assertMacRehearsal(positive: string, negative: string, from?: string, to?: string): void
export function legacyAfterBoot(text: string, version: string): 'unlimited' | 'free' | 'error' | 'missing'
export function assertLegacyRehearsal(updatedStatus: string, freshStatus: string, from?: string, to?: string): void
export function rewriteChecksumKeepSignature(ymlPath: string, filePath: string): Promise<void>
export function removeTreeRetrying(
  target: string,
  options?: {
    attempts?: number
    delayMs?: number
    wait?: (ms: number) => Promise<void>
    exists?: (dir: string) => boolean
    remove?: (dir: string) => void
  }
): Promise<boolean>
export function cleanupE2ERehearsal(statusText?: string): Promise<void>
export function windowsInstallerArgs(): string[]
export function windowsInstalledExe(localAppData: string, productName?: string): string
