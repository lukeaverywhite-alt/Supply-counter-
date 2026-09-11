import type { Signer } from './types'

// This signer proves interface wiring only. It has no secret and provides no production security.
export class MockSigner implements Signer {
  readonly identity = 'mock:argus-development-signer'

  async sign(data: string) { return `MOCK_SIGNATURE:${data}` }
  async verify(data: string, signature: string) { return signature === await this.sign(data) }
  async getPublicIdentity() { return this.identity }
}
