import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it } from 'vitest'
import {
  INDEXED_DB_VERSION,
  IndexedDbRepository,
  REPLICA_STATE_KEY,
  REPLICA_STORE_NAME,
  REPOSITORY_SCHEMA_VERSION,
  migrateRepositoryState,
} from './repository'

const originalIndexedDb = globalThis.indexedDB

function useFreshIndexedDb() {
  const factory = new IDBFactory()
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: factory })
  return factory
}

function openDatabase(factory: IDBFactory, name: string, version: number, upgrade?: (db: IDBDatabase) => void) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version)
    request.onupgradeneeded = () => upgrade?.(request.result)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function putState(db: IDBDatabase, value: unknown) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(REPLICA_STORE_NAME, 'readwrite')
    tx.objectStore(REPLICA_STORE_NAME).put(value, REPLICA_STATE_KEY)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

function getState(db: IDBDatabase) {
  return new Promise<unknown>((resolve, reject) => {
    const request = db.transaction(REPLICA_STORE_NAME).objectStore(REPLICA_STORE_NAME).get(REPLICA_STATE_KEY)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

const legacyState = () => ({
  schemaVersion: 2,
  inventory: [{ entityId: 'navy-pt-shirt', name: 'Navy PT Shirt', onHand: 24, issued: 1, version: 5, appliedEventIds: ['event-1'] }],
  events: [{
    event: { protocol: 'ARGUS', protocolVersion: 1, organizationId: 'org', eventVersion: 1, eventId: 'event-1', eventType: 'ITEM_ISSUED', entityId: 'navy-pt-shirt', actorPublicIdentity: 'mock:user', timestamp: '2026-01-01T00:00:00Z', payload: { quantity: 1 }, signature: 'signature' },
    syncStatus: 'QUEUED', receivedAt: '2026-01-01T00:00:00Z',
  }],
  outbox: [{ eventId: 'event-1', attempts: 0, status: 'QUEUED' }],
  conflicts: [{ id: 'conflict-1', entityId: 'navy-pt-shirt', eventIds: ['event-1'], status: 'OPEN', reason: 'recognizable conflict' }],
})

afterEach(() => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb }))

describe('IndexedDbRepository migrations', () => {
  it('creates a fresh replica store and current logical state', async () => {
    useFreshIndexedDb()
    const repository = new IndexedDbRepository('fresh')
    await repository.initialize()
    expect(await repository.snapshot()).toEqual(expect.objectContaining({ schemaVersion: REPOSITORY_SCHEMA_VERSION, inventory: [], events: [] }))
    const db = await openDatabase(globalThis.indexedDB as IDBFactory, 'fresh', INDEXED_DB_VERSION)
    expect(db.objectStoreNames.contains(REPLICA_STORE_NAME)).toBe(true)
    expect(await getState(db)).toBeDefined()
    db.close(); repository.close()
  })

  it('upgrades an existing replica store without recreating it and preserves operational data', async () => {
    const factory = useFreshIndexedDb()
    const old = await openDatabase(factory, 'upgrade', INDEXED_DB_VERSION - 1, db => db.createObjectStore(REPLICA_STORE_NAME))
    await putState(old, legacyState()); old.close()

    const repository = new IndexedDbRepository('upgrade')
    await repository.initialize()
    const migrated = await repository.snapshot()
    expect(migrated.inventory).toEqual(legacyState().inventory)
    expect(migrated.events[0]).toMatchObject({ event: { eventId: 'event-1' }, auditStatus: 'PENDING' })
    expect(migrated.outbox).toEqual(legacyState().outbox)
    expect(migrated.conflicts).toEqual(legacyState().conflicts)
    expect(migrated).toMatchObject({ schemaVersion: REPOSITORY_SCHEMA_VERSION, cadets: [], bundles: [], stillNeeded: [] })

    repository.close()
    const reopened = new IndexedDbRepository('upgrade')
    await reopened.initialize()
    expect(await reopened.snapshot()).toEqual(migrated)
    reopened.close()
  })

  it('reports a blocked upgrade with actionable data-preserving guidance', async () => {
    const factory = useFreshIndexedDb()
    const old = await openDatabase(factory, 'blocked', INDEXED_DB_VERSION - 1, db => db.createObjectStore(REPLICA_STORE_NAME))
    await expect(new IndexedDbRepository('blocked').initialize()).rejects.toThrow(/another tab.*preserved/i)
    old.close()
  })

  it('closes an old connection when a future version change is requested', async () => {
    const factory = useFreshIndexedDb()
    const repository = new IndexedDbRepository('versionchange')
    await repository.initialize()
    const future = await openDatabase(factory, 'versionchange', INDEXED_DB_VERSION + 1)
    await expect(repository.snapshot()).rejects.toBeDefined()
    future.close(); repository.close()
  })

  it('rejects malformed state without replacing the stored source', async () => {
    const factory = useFreshIndexedDb()
    const db = await openDatabase(factory, 'malformed', INDEXED_DB_VERSION, current => current.createObjectStore(REPLICA_STORE_NAME))
    const malformed = { schemaVersion: 2, inventory: 'not-an-array', privateSource: 'preserve-me' }
    await putState(db, malformed); db.close()
    await expect(new IndexedDbRepository('malformed').initialize()).rejects.toThrow(/Malformed.*preserved/)
    const inspect = await openDatabase(factory, 'malformed', INDEXED_DB_VERSION)
    expect(await getState(inspect)).toEqual(malformed)
    inspect.close()
  })
})

describe('logical repository migration', () => {
  it('rejects unsupported future state and leaves migration input untouched', () => {
    const future = { ...legacyState(), schemaVersion: REPOSITORY_SCHEMA_VERSION + 1 }
    expect(() => migrateRepositoryState(future)).toThrow(/future.*preserved/i)
    expect(future).toEqual({ ...legacyState(), schemaVersion: REPOSITORY_SCHEMA_VERSION + 1 })
  })
})
