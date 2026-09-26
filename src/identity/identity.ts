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
