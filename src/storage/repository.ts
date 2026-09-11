import type { BundleProjection, CadetProjection, ConflictRecord, InventoryProjection, OutboxRecord, StillNeededProjection, StoredEvent } from '../distributed/types'

export const REPOSITORY_SCHEMA_VERSION = 3
export const INDEXED_DB_VERSION = 3
export const REPLICA_STORE_NAME = 'replica'
export const REPLICA_STATE_KEY = 'state'
export type RepositoryState = { schemaVersion: number; events: StoredEvent[]; outbox: OutboxRecord[]; inventory: InventoryProjection[]; cadets: CadetProjection[]; bundles: BundleProjection[]; stillNeeded: StillNeededProjection[]; conflicts: ConflictRecord[] }
export interface ArgusRepository {
  initialize(): Promise<void>
  snapshot(): Promise<RepositoryState>
  transaction(change: (draft: RepositoryState) => void): Promise<void>
}

const empty = (): RepositoryState => ({ schemaVersion: REPOSITORY_SCHEMA_VERSION, events: [], outbox: [], inventory: [], cadets: [], bundles: [], stillNeeded: [], conflicts: [] })
export function migrateRepositoryState(value: unknown): RepositoryState {
  if (!value || typeof value !== 'object') throw new Error('Unreadable A.R.G.U.S. repository; source was preserved.')
  const source = value as Partial<RepositoryState>
  if (source.schemaVersion !== undefined && source.schemaVersion > REPOSITORY_SCHEMA_VERSION) throw new Error('Unsupported future repository schema; source was preserved.')
  if (!Array.isArray(source.events) || !Array.isArray(source.outbox) || !Array.isArray(source.inventory) || !Array.isArray(source.conflicts)) throw new Error('Malformed A.R.G.U.S. repository; source was preserved.')
  return { schemaVersion: REPOSITORY_SCHEMA_VERSION, events: source.events.map(record => ({ ...record, auditStatus: record.auditStatus ?? 'PENDING' })), outbox: source.outbox, inventory: source.inventory, cadets: source.cadets ?? [], bundles: source.bundles ?? [], stillNeeded: source.stillNeeded ?? [], conflicts: source.conflicts }
}
export class MemoryRepository implements ArgusRepository {
  private state = empty()
  async initialize() {}
  async snapshot() { return structuredClone(this.state) }
  async transaction(change: (draft: RepositoryState) => void) { const draft = structuredClone(this.state); change(draft); this.state = draft }
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
      const current = await this.read()
      if (!current) await this.write(empty())
      else await this.write(migrateRepositoryState(current))
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
  private async write(value: RepositoryState) {
    if (!this.db) throw new Error('Repository is not initialized.')
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction(REPLICA_STORE_NAME, 'readwrite')
      tx.objectStore(REPLICA_STORE_NAME).put(value, REPLICA_STATE_KEY)
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
  }
  async snapshot() { return structuredClone((await this.read()) ?? empty()) }
  async transaction(change: (draft: RepositoryState) => void) { const draft = await this.snapshot(); change(draft); await this.write(draft) }
  close() { this.db?.close(); this.db = undefined }
}
