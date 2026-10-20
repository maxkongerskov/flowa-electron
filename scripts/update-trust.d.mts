export function sha256File(file: string): Promise<Buffer>
export function generateUpdateKeyPair(): { publicKey: string; privateKey: string }
export function publicKeyFromPrivate(privateKeyPem: string): string
export function signSha256(privateKeyPem: string, digest: Buffer): string
export function verifySha256(publicKeyPem: string, digest: Buffer, signatureB64: string): boolean
