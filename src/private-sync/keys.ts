export interface KeyDistributionService {
  currentEpoch(): string
  keyFor(identity: string, epochId: string): Promise<CryptoKey>
  rotateEpoch(authorizedIdentities: string[]): Promise<string>
  grantHistory(identity: string, epochIds: string[]): void
  revoke(identity: string): void
}

// Development protocol proof. CryptoKey is non-extractable; production wrapping is delegated to a BRC-100 wallet adapter.
export class MockEpochKeyDistribution implements KeyDistributionService {
  private epoch = 0
  private keys = new Map<string, CryptoKey>()
  private grants = new Map<string, Set<string>>()
  constructor(private readonly organizationId: string) {}
  currentEpoch() { if (!this.epoch) throw new Error('No encryption epoch exists.'); return `epoch-${String(this.epoch).padStart(3, '0')}` }
  async rotateEpoch(identities: string[]) { this.epoch++; const id = this.currentEpoch(); this.keys.set(id, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])); for (const identity of identities) this.grantHistory(identity, [id]); return id }
  grantHistory(identity: string, epochs: string[]) { const current = this.grants.get(identity) ?? new Set<string>(); epochs.forEach(epoch => { if (!this.keys.has(epoch)) throw new Error('Unknown encryption epoch.'); current.add(epoch) }); this.grants.set(identity, current) }
  revoke(identity: string) { this.grants.delete(identity) }
  async keyFor(identity: string, epochId: string) { if (!this.grants.get(identity)?.has(epochId)) throw new Error(`Identity is not authorized for ${this.organizationId} encryption epoch ${epochId}.`); const key = this.keys.get(epochId); if (!key) throw new Error('Encryption epoch key is unavailable.'); return key }
}
