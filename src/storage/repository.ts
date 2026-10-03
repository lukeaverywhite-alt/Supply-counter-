import type { AdmissionConfirmationProjection, BundleProjection, CadetProjection, CalendarEventProjection, CatalogItemProjection, ConflictRecord, PropertyCorrection, RolloverRecord, CountSessionProjection, InventoryProjection, KeyEpochProjection, TicketProjection, MemberProjection, RecoveryKeyProjection, OutboxRecord, RejectedEventRecord, StillNeededProjection, StoredEvent, SupplyTransaction } from '../distributed/types'
import type { BlockchainAuditJob, UtxoReservation } from '../blockchain/BlockchainJobTypes'
import { assertRepositoryInvariants } from '../integrity'
import type { EncryptedArgusEnvelope } from '../private-sync/types'

export const REPOSITORY_SCHEMA_VERSION = 14
export const INDEXED_DB_VERSION = 7
export const REPLICA_STORE_NAME = 'replica'
export const REPLICA_STATE_KEY = 'state'
export const CHAIN_HEADERS_STORE_NAME = 'chainHeaders'
export const CHAIN_EVENTS_STORE_NAME = 'chainEvents'
export const EPOCH_KEYS_STORE_NAME = 'epochKeys'

/** Idempotent: safe to call from any connection's onupgradeneeded, in any open order. */
export function ensureArgusObjectStores(db: IDBDatabase) {
  if (!db.objectStoreNames.contains(REPLICA_STORE_NAME)) db.createObjectStore(REPLICA_STORE_NAME)
  if (!db.objectStoreNames.contains(CHAIN_HEADERS_STORE_NAME)) db.createObjectStore(CHAIN_HEADERS_STORE_NAME)
  if (!db.objectStoreNames.contains(CHAIN_EVENTS_STORE_NAME)) db.createObjectStore(CHAIN_EVENTS_STORE_NAME)
  if (!db.objectStoreNames.contains(EPOCH_KEYS_STORE_NAME)) db.createObjectStore(EPOCH_KEYS_STORE_NAME)
}
export type RemoteSyncMetadata = { providerId: string; cursor?: string; lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; state: 'DISCONNECTED'|'CONNECTING'|'SYNCHRONIZING'|'SYNCHRONIZED'|'DEGRADED'|'FAILED' }
export type QuarantinedEnvelope = { eventId: string; reason: string; receivedAt: string }
export type PrivateSyncOutboxRecord = { providerId: string; eventId: string; envelope: EncryptedArgusEnvelope }
export type OperationalEnrollmentMigration = {
  version: 1
  organizationId: string
  completedAt: string
  /** Events imported from the old device-only namespace. Their original IDs remain available for provenance. */
  importedEventIds: string[]
}
/** The state every rebuild starts from: inventory/catalog rows that exist without event provenance (the genesis catalog, or test fixtures). */
export type GenesisState = { inventory: InventoryProjection[]; catalog: CatalogItemProjection[] }
export type RepositoryState = { schemaVersion: number; enrollmentMigration?: OperationalEnrollmentMigration; genesis?: GenesisState; clock: number; lastAppliedKey?: string; catalog: CatalogItemProjection[]; members: MemberProjection[]; admissionConfirmations: AdmissionConfirmationProjection[]; rejected: RejectedEventRecord[]; calendar: CalendarEventProjection[]; corrections: PropertyCorrection[]; rollovers: RolloverRecord[]; keyEpochs: KeyEpochProjection[]; tickets: TicketProjection[]; recoveryKey?: RecoveryKeyProjection; events: StoredEvent[]; outbox: OutboxRecord[]; privateSyncOutbox: PrivateSyncOutboxRecord[]; privateSyncDeliveries: PrivateSyncOutboxRecord[]; auditJobs: BlockchainAuditJob[]; utxos: UtxoReservation[]; inventory: InventoryProjection[]; countSessions: CountSessionProjection[]; cadets: CadetProjection[]; bundles: BundleProjection[]; stillNeeded: StillNeededProjection[]; transactions: SupplyTransaction[]; conflicts: ConflictRecord[]; remoteSync: RemoteSyncMetadata[]; quarantine: QuarantinedEnvelope[] }
export interface ArgusRepository {
  initialize(): Promise<void>
  snapshot(): Promise<RepositoryState>
  /** The callback MUST be synchronous. Awaiting inside it would let IndexedDB auto-close the transaction. */
  transaction(change: (draft: RepositoryState) => void): Promise<void>
}

const empty = (): RepositoryState => ({ schemaVersion: REPOSITORY_SCHEMA_VERSION, clock: 0, catalog: [], members: [], admissionConfirmations: [], rejected: [], calendar: [], corrections: [], rollovers: [], keyEpochs: [], tickets: [], events: [], outbox: [], privateSyncOutbox: [], privateSyncDeliveries: [], auditJobs: [], utxos: [], inventory: [], countSessions: [], cadets: [], bundles: [], stillNeeded: [], transactions: [], conflicts: [], remoteSync: [], quarantine: [] })
export function migrateRepositoryState(value: unknown): RepositoryState {
  if (!value || typeof value !== 'object') throw new Error('Unreadable A.R.G.U.S. repository; source was preserved.')
  const source = value as Partial<RepositoryState>
  if (source.schemaVersion !== undefined && source.schemaVersion > REPOSITORY_SCHEMA_VERSION) throw new Error('Unsupported future repository schema; source was preserved.')
  if (!Array.isArray(source.events) || !Array.isArray(source.outbox) || !Array.isArray(source.inventory) || !Array.isArray(source.conflicts)) throw new Error('Malformed A.R.G.U.S. repository; source was preserved.')
  return { schemaVersion: REPOSITORY_SCHEMA_VERSION, ...(source.enrollmentMigration ? { enrollmentMigration: source.enrollmentMigration } : {}), ...(source.genesis ? { genesis: source.genesis } : {}), clock: source.clock ?? Math.max(0, ...source.events.map(record => record.event.clock ?? 0)), ...(source.lastAppliedKey ? { lastAppliedKey: source.lastAppliedKey } : {}), catalog: source.catalog ?? [], members: (source.members ?? []).map(member => ({ ...member, status: member.status === 'REVOKED' ? 'REVOKED' as const : member.status === 'INVITED' ? 'INVITED' as const : 'ACTIVE' as const })), admissionConfirmations: source.admissionConfirmations ?? [], rejected: source.rejected ?? [], calendar: source.calendar ?? [], corrections: source.corrections ?? [], rollovers: source.rollovers ?? [], keyEpochs: source.keyEpochs ?? [], tickets: source.tickets ?? [], ...(source.recoveryKey ? { recoveryKey: source.recoveryKey } : {}), events: source.events.map(record => ({ ...record, auditStatus: record.auditStatus ?? 'PENDING' })), outbox: source.outbox, privateSyncOutbox: source.privateSyncOutbox ?? [], privateSyncDeliveries: source.privateSyncDeliveries ?? [], auditJobs: source.auditJobs ?? [], utxos: source.utxos ?? [], inventory: source.inventory.map(item => ({ ...item, category: item.category ?? 'Uncategorized', variant: item.variant ?? 'No variant', niin: item.niin ?? 'Not assigned', issued: item.issued ?? 0, countIncrement: item.countIncrement ?? 1, active: item.active ?? true })), countSessions: source.countSessions ?? [], cadets: (source.cadets ?? []).map(cadet => ({ ...cadet, currentProperty: cadet.currentProperty.map((raw, index) => { const property = raw as typeof raw & { size?: string; variant?: string; propertyId?: string; issueEventId?: string; issueTransactionId?: string }, legacyBase = `legacy:${cadet.cadetId}:${index}`; return { ...property, variant: property.variant ?? property.size ?? 'No variant', propertyId: property.propertyId ?? `${legacyBase}:property`, issueEventId: property.issueEventId ?? `${legacyBase}:event`, issueTransactionId: property.issueTransactionId ?? `${legacyBase}:transaction` } }) })), bundles: source.bundles ?? [], stillNeeded: source.stillNeeded ?? [], transactions: source.transactions ?? [], conflicts: source.conflicts, remoteSync: source.remoteSync ?? [], quarantine: source.quarantine ?? [] }
}
export class MemoryRepository implements ArgusRepository {
  private state = empty()
  private writes: Promise<void> = Promise.resolve()
  async initialize() {}
  async snapshot() { return structuredClone(this.state) }
  transaction(change: (draft: RepositoryState) => void) { const operation = this.writes.then(() => { const draft = structuredClone(this.state), result = (change as (value: RepositoryState) => unknown)(draft); if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new Error('Repository transaction callbacks must be synchronous.'); assertRepositoryInvariants(draft); this.state = draft }); this.writes = operation.catch(() => undefined); return operation }
}

export const INDEXED_DB_NAME = 'argus-stage2'
export class IndexedDbRepository implements ArgusRepository {
  private db?: IDBDatabase
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
      request.onupgradeneeded = () => {
        const db = request.result
        request.transaction?.addEventListener('abort', () => {
          upgradeAborted = true
        })
        ensureArgusObjectStores(db)
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
  async snapshot() { const value = await this.read(); return structuredClone(value ? migrateRepositoryState(value) : empty()) }
  async transaction(change: (draft: RepositoryState) => void) {
    if (!this.db) throw new Error('Repository is not initialized.')
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(REPLICA_STORE_NAME, 'readwrite'), store = tx.objectStore(REPLICA_STORE_NAME)
      let callbackError: unknown
      const request = store.get(REPLICA_STATE_KEY)
      request.onsuccess = () => {
        try {
          const draft = structuredClone(request.result ? migrateRepositoryState(request.result) : empty())
          const result = (change as (value: RepositoryState) => unknown)(draft)
          if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new Error('Repository transaction callbacks must be synchronous.')
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
  close() { this.db?.close(); this.db = undefined }
}
