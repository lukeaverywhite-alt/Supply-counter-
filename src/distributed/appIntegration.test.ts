import { describe, expect, it } from 'vitest'
import { seedData } from '../data'
import { STORAGE_KEY } from '../domain'
import { MemoryRepository } from '../storage/repository'
import { DistributedAppController, LEGACY_MIGRATION_MARKER, migrateLegacyData } from './appIntegration'

const storage = (initial: Record<string, string> = {}) => { const values = new Map(Object.entries(initial)); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, values } }
describe('Stage 2.5 legacy migration', () => {
  it('migrates valid inventory and roster requirements once and is idempotent', async () => { const repository = new MemoryRepository(), local = storage({ [STORAGE_KEY]: JSON.stringify(seedData) }); expect(await migrateLegacyData(repository, local)).toBe(true); const migrated = await repository.snapshot(); expect(await migrateLegacyData(repository, local)).toBe(false); expect(migrated.inventory[0]).toMatchObject({ entityId: seedData.inventory[0].id, onHand: seedData.inventory[0].onHand }); expect(migrated.cadets).toHaveLength(seedData.cadets.length); expect(migrated.cadets.every(c => c.cadetId.startsWith('cadet:'))).toBe(true); expect(migrated.stillNeeded).toHaveLength(seedData.stillNeeded.length); expect(local.getItem(LEGACY_MIGRATION_MARKER)).toBe('1') })
  it('preserves malformed legacy source and does not mark migration complete', async () => { const repository = new MemoryRepository(), local = storage({ [STORAGE_KEY]: '{bad' }); await expect(migrateLegacyData(repository, local)).rejects.toThrow(/not erased/); expect(local.getItem(STORAGE_KEY)).toBe('{bad'); expect(local.getItem(LEGACY_MIGRATION_MARKER)).toBeNull(); expect((await repository.snapshot()).inventory).toHaveLength(0) })
  it('completes missing projections when an earlier release already migrated inventory', async () => { const repository = new MemoryRepository(); await repository.transaction(state => { state.inventory = [{ entityId: 'existing', name: 'Existing', category: 'Test', variant: 'One', niin: 'N/A', onHand: 1, issued: 0, countIncrement: 1, active: true, version: 0, appliedEventIds: [] }] }); expect(await migrateLegacyData(repository, storage())).toBe(true); const state = await repository.snapshot(); expect(state.inventory).toHaveLength(1); expect(state.cadets).toHaveLength(seedData.cadets.length); expect(state.stillNeeded).toHaveLength(seedData.stillNeeded.length); expect(state.stillNeeded.every(need => need.itemId === undefined)).toBe(true) })
})

describe('physical count history', () => {
  it('persists a trimmed operator note and a caller-provided unique session identifier', async () => {
    const repository = new MemoryRepository()
    const controller = new DistributedAppController(repository)
    const projection = await controller.initialize(storage())
    const item = projection.inventory[0]
    const updated = await controller.submitCount(item.entityId, item.onHand + 2, 'count_session_42', '  Shelf B recounted  ')
    const event = updated.events.find(record => record.event.eventType === 'INVENTORY_COUNT_SUBMITTED')?.event
    expect(event?.payload).toMatchObject({ sessionId: 'count_session_42', note: 'Shelf B recounted', discrepancy: 2 })
    expect(updated.audit.find(record => record.eventId === event?.eventId)?.data.note).toBe('Shelf B recounted')
  })

  it('rejects blank session identifiers and oversized notes without changing inventory', async () => {
    const repository = new MemoryRepository()
    const controller = new DistributedAppController(repository)
    const projection = await controller.initialize(storage())
    const item = projection.inventory[0]
    await expect(controller.submitCount(item.entityId, 1, '   ')).rejects.toThrow('Invalid physical count')
    await expect(controller.submitCount(item.entityId, 1, 'count_session_43', 'x'.repeat(501))).rejects.toThrow('Invalid physical count')
    expect((await controller.project()).inventory.find(candidate => candidate.entityId === item.entityId)?.onHand).toBe(item.onHand)
  })

  it('excludes fulfilled and cancelled requirements from operational Still Needed totals', async () => {
    const repository = new MemoryRepository()
    const controller = new DistributedAppController(repository)
    await controller.initialize(storage())
    await repository.transaction(state => {
      state.stillNeeded[0].status = 'FULFILLED'
      state.stillNeeded[0].quantityFulfilled = state.stillNeeded[0].quantityNeeded
      state.stillNeeded[1].status = 'CANCELLED'
    })
    const projection = await controller.project()
    expect(projection.stillNeeded.every(requirement => ['OPEN', 'PARTIALLY_FULFILLED'].includes(requirement.status))).toBe(true)
    expect(projection.stillNeeded).toHaveLength(seedData.stillNeeded.length - 2)
  })
})
