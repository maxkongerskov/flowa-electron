// Linux without a keyring stores the license key as plaintext mode 0600.
// `basic_text` is Electron's stand-in when libsecret/kwallet is missing.

export type KeyMaterial = 'encrypted' | 'plaintext-0600'

export function keyMaterial(args: { encryptionAvailable: boolean; backend?: string | null }): KeyMaterial {
  if (!args.encryptionAvailable) return 'plaintext-0600'
  if (args.backend === 'basic_text') return 'plaintext-0600'
  return 'encrypted'
}
