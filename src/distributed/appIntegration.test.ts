import { describe, expect, it } from 'vitest'
import { seedData } from '../data'
import { STORAGE_KEY } from '../domain'
import { MemoryRepository } from '../storage/repository'
import { LEGACY_MIGRATION_MARKER, migrateLegacyData } from './appIntegration'

const storage = (initial: Record<string, string> = {}) => { const values = new Map(Object.entries(initial)); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, values } }
describe('Stage 2.5 legacy migration', () => {
  it('migrates valid inventory and roster requirements once and is idempotent', async () => { const repository = new MemoryRepository(), local = storage({ [STORAGE_KEY]: JSON.stringify(seedData) }); expect(await migrateLegacyData(repository, local)).toBe(true); const migrated = await repository.snapshot(); expect(await migrateLegacyData(repository, local)).toBe(false); expect(migrated.inventory[0]).toMatchObject({ entityId: seedData.inventory[0].id, onHand: seedData.inventory[0].onHand }); expect(migrated.cadets).toHaveLength(seedData.cadets.length); expect(migrated.cadets.every(c => c.cadetId.startsWith('cadet_'))).toBe(true); expect(migrated.stillNeeded).toHaveLength(seedData.stillNeeded.length); expect(local.getItem(LEGACY_MIGRATION_MARKER)).toBe('1') })
  it('preserves malformed legacy source and does not mark migration complete', async () => { const repository = new MemoryRepository(), local = storage({ [STORAGE_KEY]: '{bad' }); await expect(migrateLegacyData(repository, local)).rejects.toThrow(/not erased/); expect(local.getItem(STORAGE_KEY)).toBe('{bad'); expect(local.getItem(LEGACY_MIGRATION_MARKER)).toBeNull(); expect((await repository.snapshot()).inventory).toHaveLength(0) })
})
