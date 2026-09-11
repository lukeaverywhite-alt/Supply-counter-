import type { ConflictRecord, InventoryProjection, OutboxRecord, StoredEvent } from '../distributed/types'

export const REPOSITORY_SCHEMA_VERSION = 2
export type RepositoryState = { schemaVersion: number; events: StoredEvent[]; outbox: OutboxRecord[]; inventory: InventoryProjection[]; conflicts: ConflictRecord[] }
export interface ArgusRepository {
  initialize(): Promise<void>
  snapshot(): Promise<RepositoryState>
  transaction(change: (draft: RepositoryState) => void): Promise<void>
}

const empty = (): RepositoryState => ({ schemaVersion: REPOSITORY_SCHEMA_VERSION, events: [], outbox: [], inventory: [], conflicts: [] })
export function migrateRepositoryState(value: unknown): RepositoryState {
  if (!value || typeof value !== 'object') throw new Error('Unreadable A.R.G.U.S. repository; source was preserved.')
  const source = value as Partial<RepositoryState>
  if (source.schemaVersion !== undefined && source.schemaVersion > REPOSITORY_SCHEMA_VERSION) throw new Error('Unsupported future repository schema; source was preserved.')
  if (!Array.isArray(source.events) || !Array.isArray(source.outbox) || !Array.isArray(source.inventory) || !Array.isArray(source.conflicts)) throw new Error('Malformed A.R.G.U.S. repository; source was preserved.')
  return { schemaVersion: REPOSITORY_SCHEMA_VERSION, events: source.events.map(record => ({ ...record, auditStatus: record.auditStatus ?? 'PENDING' })), outbox: source.outbox, inventory: source.inventory, conflicts: source.conflicts }
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
    if (!globalThis.indexedDB) throw new Error('IndexedDB is unavailable; existing localStorage data was not deleted.')
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 2)
      request.onupgradeneeded = () => request.result.createObjectStore('replica')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    const current = await this.read()
    if (!current) await this.write(empty())
    else await this.write(migrateRepositoryState(current))
  }
  private async read(): Promise<RepositoryState | undefined> {
    if (!this.db) throw new Error('Repository is not initialized.')
    return new Promise((resolve, reject) => {
      const request = this.db!.transaction('replica').objectStore('replica').get('state')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  private async write(value: RepositoryState) {
    if (!this.db) throw new Error('Repository is not initialized.')
    await new Promise<void>((resolve, reject) => {
      const tx = this.db!.transaction('replica', 'readwrite')
      tx.objectStore('replica').put(value, 'state')
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
  }
  async snapshot() { return structuredClone((await this.read()) ?? empty()) }
  async transaction(change: (draft: RepositoryState) => void) { const draft = await this.snapshot(); change(draft); await this.write(draft) }
}
