export const RELEASE_122_PUBLIC_KEY_B64: string
export function publicKeyBody(pem: string): string
export function renderGenericAppUpdateYml(feedUrl: string): string
export function patchInstalledMainBundle(
  source: string,
  options: { publicKeyPem?: string | null; keepPublicKey?: boolean; manualDownload?: boolean }
): string
export function squashfsOffset(file: string): number
export function patchInstalledResources(
  resourcesDir: string,
  options: { feedUrl: string; publicKeyPem?: string | null; keepPublicKey?: boolean; manualDownload?: boolean }
): Promise<{ yml: string; asarPath: string }>
