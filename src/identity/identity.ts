import { sha256 } from '../distributed/canonical'

export interface ArgusIdentityProvider {
  getPublicIdentity(): Promise<string>
  sign(data: Uint8Array | string): Promise<string>
  verify(data: Uint8Array | string, signature: string, publicIdentity?: string): Promise<boolean>
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
