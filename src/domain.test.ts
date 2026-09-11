import { describe, expect, it } from 'vitest'
import { seedData } from './data'
import { applyBundle, loadData, matchesSearch, rollover, statusFor, submitCount, transact } from './domain'

const fresh = () => structuredClone(seedData)

describe('local inventory domain', () => {
  it('issues and returns without allowing negative stock', () => {
    const issued = transact(fresh(), 'shirt-pt-m', 2, 'issue', 'cadet-am')
    expect(issued.inventory[0]).toMatchObject({ onHand: 22, issued: 20 })
    expect(issued.cadets[0].items).toBe(8)
    expect(transact(issued, 'shirt-pt-m', 1, 'return', 'cadet-am').inventory[0].onHand).toBe(23)
    expect(() => transact(fresh(), 'shorts-pt-m', 9, 'issue')).toThrow(/Only 8/)
  })

  it('rejects impossible returns and unknown cadet records', () => {
    const data = fresh()
    data.inventory[0].issued = 0
    expect(() => transact(data, 'shirt-pt-m', 1, 'return', 'cadet-am')).toThrow(/Only 0 issued units/)
    expect(() => transact(fresh(), 'shirt-pt-m', 1, 'issue', 'missing-cadet')).toThrow(/Cadet was not found/)
  })

  it('validates an entire bundle before issuing its lines', () => {
    const next = applyBundle(fresh(), 'bundle-pt', 'cadet-am')
    expect(next.inventory.find(i => i.id === 'shirt-pt-m')?.onHand).toBe(23)
    expect(next.inventory.find(i => i.id === 'shorts-pt-m')?.onHand).toBe(7)
  })

  it('submits draft counts and appends a structured audit event', () => {
    const next = submitCount(fresh())
    expect(next.inventory[0].onHand).toBe(18)
    expect(next.session.status).toBe('submitted')
    expect(next.audit[0]).toMatchObject({ type: 'INVENTORY_COUNT_SUBMITTED', entityId: 'session-024', audit: { status: 'QUEUED_FOR_AUDIT', targetNetwork: 'MOCK' } })
    expect(next.audit[0].audit.submittedNetwork).toBeUndefined()
  })

  it('blocks rollover while a count is active and archives NS4 after submission', () => {
    expect(() => rollover(fresh(), true)).toThrow(/active count/i)
    const next = rollover(submitCount(fresh()), true)
    expect(next.schoolYear).toBe(2027)
    expect(next.cadets.find(c => c.level === 'NS4')?.active).toBe(false)
  })

  it('falls back safely when local data is corrupt', () => {
    expect(loadData({ getItem: () => '{bad json' }).version).toBe(3)
  })

  it('supports optional thresholds and distinct out-of-stock status', () => {
    expect(statusFor({ onHand: 0 })).toBe('Out of stock')
    expect(statusFor({ onHand: 4, reorderAt: 5 })).toBe('Low')
    expect(statusFor({ onHand: 4 })).toBe('Healthy')
  })

  it('normalizes identifiers, abbreviations, and name order for search', () => {
    expect(matchesSearch('8415 EX 2041', '8415-EX-2041')).toBe(true)
    expect(matchesSearch('PT shirt', 'Physical Training Shirt')).toBe(true)
    expect(matchesSearch('Morgan Alex', 'Morgan, Alex')).toBe(true)
  })
})
