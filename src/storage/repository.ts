import type { BundleProjection, CadetProjection, ConflictRecord, InventoryProjection, OutboxRecord, StillNeededProjection, StoredEvent, SupplyTransaction } from '../distributed/types'
import type { BlockchainAuditJob, UtxoReservation } from '../blockchain/BlockchainJobTypes'
import { assertRepositoryInvariants } from '../integrity'

export const REPOSITORY_SCHEMA_VERSION = 7
export const INDEXED_DB_VERSION = 4
export const REPLICA_STORE_NAME = 'replica'
export const REPLICA_STATE_KEY = 'state'
export type RemoteSyncMetadata = { providerId: string; cursor?: string; lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; state: 'DISCONNECTED'|'CONNECTING'|'SYNCHRONIZING'|'SYNCHRONIZED'|'DEGRADED'|'FAILED' }
export type QuarantinedEnvelope = { eventId: string; reason: string; receivedAt: string }
export type RepositoryState = { schemaVersion: number; events: StoredEvent[]; outbox: OutboxRecord[]; auditJobs: BlockchainAuditJob[]; utxos: UtxoReservation[]; inventory: InventoryProjection[]; cadets: CadetProjection[]; bundles: BundleProjection[]; stillNeeded: StillNeededProjection[]; transactions: SupplyTransaction[]; conflicts: ConflictRecord[]; remoteSync: RemoteSyncMetadata[]; quarantine: QuarantinedEnvelope[] }
export interface ArgusRepository {
  initialize(): Promise<void>
  snapshot(): Promise<RepositoryState>
  /** The callback MUST be synchronous. Awaiting inside it would let IndexedDB auto-close the transaction. */
  transaction(change: (draft: RepositoryState) => void): Promise<void>
}

const empty = (): RepositoryState => ({ schemaVersion: REPOSITORY_SCHEMA_VERSION, events: [], outbox: [], auditJobs: [], utxos: [], inventory: [], cadets: [], bundles: [], stillNeeded: [], transactions: [], conflicts: [], remoteSync: [], quarantine: [] })
export function migrateRepositoryState(value: unknown): RepositoryState {
  if (!value || typeof value !== 'object') throw new Error('Unreadable A.R.G.U.S. repository; source was preserved.')
  const source = value as Partial<RepositoryState>
  if (source.schemaVersion !== undefined && source.schemaVersion > REPOSITORY_SCHEMA_VERSION) throw new Error('Unsupported future repository schema; source was preserved.')
  if (!Array.isArray(source.events) || !Array.isArray(source.outbox) || !Array.isArray(source.inventory) || !Array.isArray(source.conflicts)) throw new Error('Malformed A.R.G.U.S. repository; source was preserved.')
  return { schemaVersion: REPOSITORY_SCHEMA_VERSION, events: source.events.map(record => ({ ...record, auditStatus: record.auditStatus ?? 'PENDING' })), outbox: source.outbox, auditJobs: source.auditJobs ?? [], utxos: source.utxos ?? [], inventory: source.inventory.map(item => ({ ...item, category: item.category ?? 'Uncategorized', variant: item.variant ?? 'No variant', niin: item.niin ?? 'Not assigned', issued: item.issued ?? 0, countIncrement: item.countIncrement ?? 1, active: item.active ?? true })), cadets: (source.cadets ?? []).map(cadet => ({ ...cadet, currentProperty: cadet.currentProperty.map((raw, index) => { const property = raw as typeof raw & { size?: string; variant?: string; propertyId?: string; issueEventId?: string; issueTransactionId?: string }, legacyBase = `legacy:${cadet.cadetId}:${index}`; return { ...property, variant: property.variant ?? property.size ?? 'No variant', propertyId: property.propertyId ?? `${legacyBase}:property`, issueEventId: property.issueEventId ?? `${legacyBase}:event`, issueTransactionId: property.issueTransactionId ?? `${legacyBase}:transaction` } }) })), bundles: source.bundles ?? [], stillNeeded: source.stillNeeded ?? [], transactions: source.transactions ?? [], conflicts: source.conflicts, remoteSync: source.remoteSync ?? [], quarantine: source.quarantine ?? [] }
}
export class MemoryRepository implements ArgusRepository {
  private state = empty()
  private pending: Promise<void> = Promise.resolve()
  async initialize() {}
  async snapshot() { return structuredClone(this.state) }
  transaction(change: (draft: RepositoryState) => void) { return this.serialize(async () => { const draft = structuredClone(this.state); change(draft); this.state = draft }) }
  private serialize(work: () => Promise<void>) { const result = this.pending.then(work, work); this.pending = result.catch(() => undefined); return result }
}

export const INDEXED_DB_NAME = 'argus-stage2'
export class IndexedDbRepository implements ArgusRepository {
  private db?: IDBDatabase
  /** Serializes every complete read-modify-write cycle; errors cannot poison the queue. */
  private pending: Promise<void> = Promise.resolve()
  constructor(private readonly name = INDEXED_DB_NAME) {}
  async initialize() {
    if (this.db) return
    if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable; existing localStorage data was not deleted.')
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, INDEXED_DB_VERSION)
      let settled = false
      let upgradeAborted = false
      const fail = (message: string, cause?: unknown) => {
        if (settled) return
        settled = true
        reject(new Error(message, { cause }))
      }
      request.onupgradeneeded = event => {
        const db = request.result
        const oldVersion = event.oldVersion
        request.transaction?.addEventListener('abort', () => {
          upgradeAborted = true
        })

        // Version 1 introduced the replica store. Never recreate an existing
        // store: future physical schema migrations must also be version-gated.
        if (oldVersion < 1 && !db.objectStoreNames.contains(REPLICA_STORE_NAME)) db.createObjectStore(REPLICA_STORE_NAME)
        // Defensively repair databases created by an incomplete older release.
        if (!db.objectStoreNames.contains(REPLICA_STORE_NAME)) db.createObjectStore(REPLICA_STORE_NAME)
      }
      request.onblocked = () => fail('A.R.G.U.S. needs to update its local database, but another tab is still using the old version. Close other A.R.G.U.S. tabs and reload. Your existing data was preserved.')
      request.onerror = () => fail(
        upgradeAborted
          ? 'A.R.G.U.S. could not upgrade its local database. Your existing data was preserved. Close any other A.R.G.U.S. tabs and reload.'
          : 'A.R.G.U.S. could not open its local database. Your existing data was preserved.',
        request.error,
      )
      request.onsuccess = () => {
        const db = request.result
        db.onversionchange = () => db.close()
        if (settled) db.close()
        else { settled = true; resolve(db) }
      }
    })
    try {
      await this.transaction(() => undefined)
    } catch (error) {
      this.close()
      throw error
    }
  }
  private async read(): Promise<RepositoryState | undefined> {
    if (!this.db) throw new Error('Repository is not initialized.')
    return new Promise((resolve, reject) => {
      const request = this.db!.transaction(REPLICA_STORE_NAME).objectStore(REPLICA_STORE_NAME).get(REPLICA_STATE_KEY)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  async snapshot() { return structuredClone((await this.read()) ?? empty()) }
  async transaction(change: (draft: RepositoryState) => void) {
    if (!this.db) throw new Error('Repository is not initialized.')
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(REPLICA_STORE_NAME, 'readwrite'), store = tx.objectStore(REPLICA_STORE_NAME)
      let callbackError: unknown
      const request = store.get(REPLICA_STATE_KEY)
      request.onsuccess = () => {
        try {
          const draft = structuredClone(request.result ? migrateRepositoryState(request.result) : empty())
          change(draft)
          assertRepositoryInvariants(draft)
          store.put(draft, REPLICA_STATE_KEY)
        } catch (error) { callbackError = error; tx.abort() }
      }
      request.onerror = () => { callbackError = request.error }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(callbackError ?? tx.error)
      tx.onabort = () => reject(callbackError ?? tx.error ?? new Error('Repository transaction was aborted.'))
    })
  }
  async snapshot() { return structuredClone((await this.read()) ?? empty()) }
  transaction(change: (draft: RepositoryState) => void) { return this.serialize(async () => { const draft = structuredClone((await this.read()) ?? empty()); change(draft); await this.write(draft) }) }
  private serialize(work: () => Promise<void>) { const result = this.pending.then(work, work); this.pending = result.catch(() => undefined); return result }
  close() { this.db?.close(); this.db = undefined }
}
