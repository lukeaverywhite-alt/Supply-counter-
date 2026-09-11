import { seedData } from './data'
import { appendDomainEvent, createDomainEvent } from './audit/events'
import type { AppData, AuditEvent, DomainEventType, InventoryItem } from './types'

export const STORAGE_KEY = 'argus.local.v2'

export function loadData(storage: Pick<Storage, 'getItem'> = localStorage): AppData {
  try {
    const value = storage.getItem(STORAGE_KEY)
    if (!value) return structuredClone(seedData)
    const parsed = JSON.parse(value) as AppData
    return parsed.version === 3 ? { ...parsed, stillNeeded: parsed.stillNeeded ?? [], audit: parsed.audit ?? [] } : structuredClone(seedData)
  } catch {
    return structuredClone(seedData)
  }
}

export function saveData(data: AppData, storage: Pick<Storage, 'setItem'> = localStorage) {
  storage.setItem(STORAGE_KEY, JSON.stringify(data))
}

export function statusFor(item: Pick<InventoryItem, 'onHand' | 'reorderAt'>): InventoryItem['status'] {
  if (item.onHand === 0) return 'Out of stock'
  return item.reorderAt !== undefined && item.onHand <= item.reorderAt ? 'Low' : 'Healthy'
}

export function normalizeSearch(value: string) {
  const abbreviations: Record<string, string> = { pt: 'physical training', nsu: 'navy service uniform', oxford: 'shoe' }
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(token => abbreviations[token] ?? token).join(' ')
}

export function matchesSearch(query: string, ...fields: string[]) {
  const needle = normalizeSearch(query)
  if (!needle) return true
  const compactNeedle = needle.replaceAll(' ', '')
  const words = needle.split(' ')
  return fields.some(field => {
    const normalized = normalizeSearch(field)
    const haystack = normalized.replaceAll(' ', '')
    return haystack.includes(compactNeedle) || words.every(word => normalized.includes(word))
  })
}

export function transact(data: AppData, itemId: string, quantity: number, kind: 'issue' | 'return', cadetId?: string): AppData {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive whole number.')
  const target = data.inventory.find(item => item.id === itemId)
  if (!target) throw new Error('Inventory item was not found.')
  if (kind === 'issue' && target.onHand < quantity) throw new Error(`Only ${target.onHand} available to issue.`)
  if (kind === 'return' && target.issued < quantity) throw new Error(`Only ${target.issued} issued unit${target.issued === 1 ? '' : 's'} can be returned.`)
  const cadet = cadetId ? data.cadets.find(entry => entry.id === cadetId) : undefined
  if (cadetId && !cadet) throw new Error('Cadet was not found.')
  if (kind === 'return' && cadet && cadet.items < quantity) throw new Error(`${cadet.name} has only ${cadet.items} issued item${cadet.items === 1 ? '' : 's'}.`)
  const delta = kind === 'issue' ? -quantity : quantity
  const issuedDelta = -delta
  const inventory = data.inventory.map(item => item.id !== itemId ? item : {
    ...item,
    onHand: item.onHand + delta,
    issued: Math.max(0, item.issued + issuedDelta),
    status: statusFor({ onHand: item.onHand + delta, reorderAt: item.reorderAt }),
  })
  const cadets = data.cadets.map(cadet => cadet.id !== cadetId ? cadet : ({
    ...cadet, items: Math.max(0, cadet.items + issuedDelta), status: kind === 'return' ? 'Clear' as const : cadet.status,
  }))
  return withAudit({ ...data, inventory, cadets }, kind === 'issue' ? 'ITEM_ISSUED' : 'ITEM_RETURNED', `${kind === 'issue' ? 'Issued' : 'Returned'} ${quantity} × ${target.name}`, itemId, { itemId, quantity })
}

export function applyBundle(data: AppData, bundleId: string, cadetId: string): AppData {
  const bundle = data.bundles.find(entry => entry.id === bundleId)
  if (!bundle) throw new Error('Bundle was not found.')
  for (const line of bundle.lines) {
    const item = data.inventory.find(entry => entry.id === line.itemId)
    if (!item || item.onHand < line.quantity) throw new Error(`${item?.name ?? 'An item'} does not have enough stock.`)
  }
  return bundle.lines.reduce((next, line) => transact(next, line.itemId, line.quantity, 'issue', cadetId), data)
}

export function submitCount(data: AppData): AppData {
  if (!Object.keys(data.session.counts).length) throw new Error('Count at least one item before submitting.')
  const inventory = data.inventory.map(item => data.session.counts[item.id] === undefined ? item : ({
    ...item, onHand: data.session.counts[item.id], status: statusFor({ onHand: data.session.counts[item.id], reorderAt: item.reorderAt }),
  }))
  const changed = Object.keys(data.session.counts).length
  const next = { ...data, inventory, session: { ...data.session, status: 'submitted' as const, submittedAt: new Date().toISOString() } }
  return withAudit(next, 'INVENTORY_COUNT_SUBMITTED', `Submitted ${data.session.name} with ${changed} counted variant${changed === 1 ? '' : 's'}`, data.session.id, { countedVariants: changed, sessionId: data.session.id })
}

export function rollover(data: AppData, confirmed: boolean): AppData {
  if (!confirmed) throw new Error('Rollover requires explicit confirmation.')
  if (data.session.status === 'draft' && Object.keys(data.session.counts).length) throw new Error('Submit or clear the active count before rollover.')
  const schoolYear = data.schoolYear + 1
  const next = { ...data, schoolYear, cadets: data.cadets.map(c => ({ ...c, active: c.level !== 'NS4', schoolYear, status: c.level === 'NS4' ? 'Return pending' as const : c.status })) }
  return withAudit(next, 'ANNUAL_ROLLOVER_COMPLETED', `Advanced roster to ${schoolYear}`, `school-year:${schoolYear}`, { schoolYear })
}

export function withAudit(data: AppData, type: DomainEventType, summary: string, entityId: string, eventData: AuditEvent['data'] = {}): AppData {
  const previousEventHash = data.audit.find(event => event.audit.eventHash)?.audit.eventHash
  return appendDomainEvent(data, createDomainEvent({ type, summary, entityId, data: eventData, previousEventHash }))
}
