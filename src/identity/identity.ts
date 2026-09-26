import { sha256 } from '../distributed/canonical'

export interface ArgusIdentityProvider {
  getPublicIdentity(): Promise<string>
  sign(data: Uint8Array | string): Promise<string>
  verify(data: Uint8Array | string, signature: string, publicIdentity?: string): Promise<boolean>
}

const base64url = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
const fromBase64url = (value: string) => {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}
const bytes = (data: Uint8Array | string) => typeof data === 'string' ? new TextEncoder().encode(data) : data
const buffer = (data: Uint8Array | string): ArrayBuffer => bytes(data).slice().buffer as ArrayBuffer

/** Real, non-exportable signing key for enrolled runtime adapters. Persistence belongs in a secure enrollment boundary. */
export class WebCryptoIdentityProvider implements ArgusIdentityProvider {
  private publicIdentity?: string
  private constructor(private readonly keyPair: CryptoKeyPair) {}
  static async create() {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
    return new WebCryptoIdentityProvider(keyPair)
  }
  static fromKeyPair(keyPair: CryptoKeyPair) { return new WebCryptoIdentityProvider(keyPair) }
  async getPublicIdentity() {
    if (!this.publicIdentity) this.publicIdentity = `p256:${base64url(new Uint8Array(await crypto.subtle.exportKey('spki', this.keyPair.publicKey)))}`
    return this.publicIdentity
  }
  async sign(data: Uint8Array | string) { return `p256sig:${base64url(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keyPair.privateKey, buffer(data))))}` }
  async verify(data: Uint8Array | string, signature: string, publicIdentity?: string) {
    const identity = publicIdentity ?? await this.getPublicIdentity()
    if (!identity.startsWith('p256:') || !signature.startsWith('p256sig:')) return false
    try {
      const publicKey = await crypto.subtle.importKey('spki', fromBase64url(identity.slice(5)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, buffer(fromBase64url(signature.slice(8))), buffer(data))
    } catch { return false }
  }
}

export type WrappedApplicationCredential = {
  version: 1
  kdf: { name: 'PBKDF2-SHA-256'; iterations: number; salt: string }
  cipher: { name: 'AES-256-GCM'; nonce: string }
  publicIdentity: string
  encryptedPrivateJwk: string
  createdAt: string
}

const APPLICATION_KDF_ITERATIONS = 600_000

async function wrappingKey(password: string, salt: Uint8Array, usages: KeyUsage[]) {
  if (password.length < 12 || !/[a-z]/i.test(password) || !/\d/.test(password)) {
    throw new Error('Use at least 12 characters including a letter and number.')
  }
  const material = await crypto.subtle.importKey('raw', buffer(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: APPLICATION_KDF_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

/** Creates one password-wrapped signing credential for a user/device enrollment. */
export async function createWrappedApplicationCredential(password: string, createdAt = new Date().toISOString()): Promise<WrappedApplicationCredential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicIdentity = `p256:${base64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))}`
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const key = await wrappingKey(password, salt, ['encrypt'])
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: buffer(publicIdentity) }, key, buffer(JSON.stringify(privateJwk)))
  return {
    version: 1,
    kdf: { name: 'PBKDF2-SHA-256', iterations: APPLICATION_KDF_ITERATIONS, salt: base64url(salt) },
    cipher: { name: 'AES-256-GCM', nonce: base64url(nonce) },
    publicIdentity,
    encryptedPrivateJwk: base64url(new Uint8Array(ciphertext)),
    createdAt,
  }
}

/** Unlocks into a non-exportable key. Passwords and plaintext key bytes are never retained. */
export async function unlockWrappedApplicationCredential(record: WrappedApplicationCredential, password: string): Promise<ArgusIdentityProvider> {
  if (record.version !== 1 || record.kdf.name !== 'PBKDF2-SHA-256' || record.kdf.iterations !== APPLICATION_KDF_ITERATIONS || record.cipher.name !== 'AES-256-GCM') throw new Error('Unsupported application credential format.')
  try {
    const key = await wrappingKey(password, fromBase64url(record.kdf.salt), ['decrypt'])
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromBase64url(record.cipher.nonce)), additionalData: buffer(record.publicIdentity) }, key, buffer(fromBase64url(record.encryptedPrivateJwk)))
    const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(new TextDecoder().decode(clear)) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const publicKey = await crypto.subtle.importKey('spki', fromBase64url(record.publicIdentity.slice(5)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    return WebCryptoIdentityProvider.fromKeyPair({ privateKey, publicKey })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Use at least')) throw error
    throw new Error('The application credential password is incorrect or the credential is damaged.', { cause: error })
  }
}

// Protocol/test double only: identities and signatures contain no private key material.
export class MockIdentityProvider implements ArgusIdentityProvider {
  readonly publicIdentity: string
  constructor(label: string) { this.publicIdentity = `mock:${label}` }
  async getPublicIdentity() { return this.publicIdentity }
  async sign(data: Uint8Array | string) { return `MOCK_SIG:${this.publicIdentity}:${await sha256(data)}` }
  async verify(data: Uint8Array | string, signature: string, publicIdentity = this.publicIdentity) {
    return signature === `MOCK_SIG:${publicIdentity}:${await sha256(data)}`
  }
}
