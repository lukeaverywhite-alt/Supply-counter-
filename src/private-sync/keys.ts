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

type DevelopmentKeyRecord = { version: 1; organizationId: string; currentEpoch: string; epochs: Record<string, string>; grants: Record<string, string[]> }

/**
 * Development-only device enrollment store. Key material is kept in browser
 * storage, never in projections, URLs, build variables, relay data, or logs.
 * Stage 4A must replace this with hardware/wallet-backed wrapped keys.
 */
export class DevelopmentPersistentEpochKeyDistribution implements KeyDistributionService {
  private readonly storageKey: string
  constructor(private readonly organizationId: string, private readonly storage: Pick<Storage, 'getItem'|'setItem'>) { this.storageKey = `argus.development.epoch-keys.${organizationId}` }
  private read(): DevelopmentKeyRecord {
    const raw = this.storage.getItem(this.storageKey)
    if (!raw) throw new Error('This development client is not enrolled for an encryption epoch.')
    const value = JSON.parse(raw) as DevelopmentKeyRecord
    if (value.version !== 1 || value.organizationId !== this.organizationId || !value.currentEpoch || !value.epochs?.[value.currentEpoch]) throw new Error('Development encryption enrollment is invalid.')
    return value
  }
  private write(value: DevelopmentKeyRecord) { this.storage.setItem(this.storageKey, JSON.stringify(value)) }
  currentEpoch() { return this.read().currentEpoch }
  async rotateEpoch(identities: string[]) {
    let prior: DevelopmentKeyRecord | undefined
    try { prior = this.read() } catch { /* first explicit enrollment */ }
    const number = Number(prior?.currentEpoch.split('-')[1] ?? 0) + 1, epoch = `epoch-${String(number).padStart(3, '0')}`
    const raw = crypto.getRandomValues(new Uint8Array(32)), encoded = btoa(String.fromCharCode(...raw))
    const value: DevelopmentKeyRecord = prior ?? { version: 1, organizationId: this.organizationId, currentEpoch: epoch, epochs: {}, grants: {} }
    value.currentEpoch = epoch; value.epochs[epoch] = encoded
    for (const identity of identities) value.grants[identity] = [...new Set([...(value.grants[identity] ?? []), epoch])]
    this.write(value); return epoch
  }
  grantHistory(identity: string, epochs: string[]) { const value=this.read();if(epochs.some(epoch=>!value.epochs[epoch]))throw new Error('Unknown encryption epoch.');value.grants[identity]=[...new Set([...(value.grants[identity]??[]),...epochs])];this.write(value) }
  revoke(identity: string) { const value=this.read();delete value.grants[identity];this.write(value) }
  async keyFor(identity: string, epochId: string) { const value=this.read();if(!value.grants[identity]?.includes(epochId))throw new Error(`Identity is not authorized for ${this.organizationId} encryption epoch ${epochId}.`);const encoded=value.epochs[epochId];if(!encoded)throw new Error('Encryption epoch key is unavailable.');return crypto.subtle.importKey('raw',Uint8Array.from(atob(encoded),character=>character.charCodeAt(0)),{name:'AES-GCM'},false,['encrypt','decrypt']) }
  /** Explicit enrollment transfer; callers must transport it out-of-band. */
  exportEnrollment() { return this.storage.getItem(this.storageKey) ?? (()=>{throw new Error('No development enrollment exists.')})() }
  importEnrollment(serialized: string) { const value=JSON.parse(serialized) as DevelopmentKeyRecord;if(value.version!==1||value.organizationId!==this.organizationId)throw new Error('Development enrollment belongs to a different organization.');this.write(value);this.read() }
}
