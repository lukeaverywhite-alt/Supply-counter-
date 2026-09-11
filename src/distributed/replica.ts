import type { AuthorizationService } from '../auth/authorization'
import { canonicalize } from './canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { ArgusPermission, ConflictRecord, InventoryProjection, SignedArgusEvent, UnsignedArgusEvent } from './types'
import type { ArgusRepository, RepositoryState } from '../storage/repository'
import type { MockSyncProvider } from '../sync/mock'

const permissionFor = (type: SignedArgusEvent['eventType']): ArgusPermission | undefined => ({ ITEM_ISSUED: 'inventory.issue', ITEM_RETURNED: 'inventory.return', CONFLICT_RESOLVED: 'conflicts.resolve' } as Partial<Record<SignedArgusEvent['eventType'], ArgusPermission>>)[type]
const unsigned = (event: SignedArgusEvent) => { const rest: Partial<SignedArgusEvent> = { ...event }; delete rest.signature; return canonicalize(rest) }

export class ArgusReplica {
  online = true
  constructor(readonly repository: ArgusRepository, private identity: ArgusIdentityProvider, private authorization: AuthorizationService, private provider: MockSyncProvider) {}
  async initialize(items: Array<Omit<InventoryProjection, 'appliedEventIds'>> = []) {
    await this.repository.initialize()
    await this.repository.transaction(s => { if (!s.inventory.length) s.inventory = items.map(item => ({ ...item, appliedEventIds: [] })) })
  }
  private async signed(input: Omit<UnsignedArgusEvent, 'protocol' | 'eventVersion' | 'eventId' | 'actorPublicIdentity' | 'timestamp'> & { eventId?: string; timestamp?: string }) {
    const event = { protocol: 'ARGUS' as const, eventVersion: 1 as const, eventId: input.eventId ?? crypto.randomUUID(), eventType: input.eventType, entityId: input.entityId, actorPublicIdentity: await this.identity.getPublicIdentity(), timestamp: input.timestamp ?? new Date().toISOString(), ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }), payload: input.payload }
    return { ...event, signature: await this.identity.sign(canonicalize(event)) }
  }
  async issue(entityId: string, quantity: number, options: { eventId?: string; timestamp?: string } = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item) throw new Error('Inventory item was not found.'); if (quantity <= 0 || item.onHand < quantity) throw new Error('Insufficient inventory.')
    const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'inventory.issue', options.timestamp)
    const event = await this.signed({ eventType: 'ITEM_ISSUED', entityId, baseVersion: item.version, payload: { quantity }, ...options })
    await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async correct(originalEventId: string, entityId: string, field: string, value: unknown, reason: string) {
    const event = await this.signed({ eventType: 'RECORD_CORRECTED', entityId, payload: { originalEventId, field, value, reason } }); await this.persistLocal(event); return event
  }
  async resolve(conflictId: string, resolution: string) {
    const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'conflicts.resolve')
    const state = await this.repository.snapshot(); const conflict = state.conflicts.find(c => c.id === conflictId && c.status === 'OPEN'); if (!conflict) throw new Error('Open conflict was not found.')
    const event = await this.signed({ eventType: 'CONFLICT_RESOLVED', entityId: conflict.entityId, payload: { conflictId, resolution } }); await this.persistLocal(event); return event
  }
  private apply(state: RepositoryState, event: SignedArgusEvent) {
    if (state.events.some(e => e.event.eventId === event.eventId)) return
    const permission = permissionFor(event.eventType); if (permission) this.authorization.require(event.actorPublicIdentity, permission, event.timestamp)
    if (event.eventType === 'ITEM_ISSUED' || event.eventType === 'ITEM_RETURNED') {
      const item = state.inventory.find(i => i.entityId === event.entityId); if (!item) throw new Error('Inventory projection is missing.')
      if (item.appliedEventIds.includes(event.eventId)) return
      const quantity = event.payload.quantity; if (!Number.isInteger(quantity) || Number(quantity) <= 0) throw new Error('Corrupted event quantity.')
      const delta = event.eventType === 'ITEM_ISSUED' ? -Number(quantity) : Number(quantity)
      if (event.baseVersion !== item.version && delta < 0 && item.onHand + delta < 0) {
        const related = state.events.filter(e => e.event.entityId === event.entityId && e.event.baseVersion === event.baseVersion && e.event.eventType === 'ITEM_ISSUED').map(e => e.event.eventId)
        const conflict: ConflictRecord = { id: `conflict:${[...related, event.eventId].sort().join(':')}`, entityId: event.entityId, eventIds: [...related, event.eventId], status: 'OPEN', reason: `Concurrent events attempted to consume unavailable ${item.name}.` }
        if (!state.conflicts.some(c => c.id === conflict.id)) state.conflicts.push(conflict)
      } else { item.onHand += delta; item.version += 1; item.appliedEventIds.push(event.eventId) }
    }
    if (event.eventType === 'CONFLICT_RESOLVED') { const conflict = state.conflicts.find(c => c.id === event.payload.conflictId); if (conflict) { conflict.status = 'RESOLVED'; conflict.resolutionEventId = event.eventId } }
    state.events.push({ event, syncStatus: 'SYNCHRONIZED', receivedAt: new Date().toISOString() })
  }
  private async persistLocal(event: SignedArgusEvent) { await this.repository.transaction(state => { this.apply(state, event); const stored = state.events.find(e => e.event.eventId === event.eventId)!; stored.syncStatus = 'QUEUED'; state.outbox.push({ eventId: event.eventId, attempts: 0, status: 'QUEUED' }) }) }
  async receive(event: SignedArgusEvent) {
    if (!(await this.identity.verify(unsigned(event), event.signature, event.actorPublicIdentity))) throw new Error('Invalid event signature.')
    await this.repository.transaction(state => this.apply(state, event))
  }
  async sync() {
    if (!this.online) return
    const before = await this.repository.snapshot()
    for (const record of before.outbox) {
      const event = before.events.find(e => e.event.eventId === record.eventId)!.event
      try { await this.provider.publish(event); await this.repository.transaction(s => { s.outbox = s.outbox.filter(o => o.eventId !== event.eventId); const stored = s.events.find(e => e.event.eventId === event.eventId); if (stored) stored.syncStatus = 'SYNCHRONIZED' }) }
      catch (error) { await this.repository.transaction(s => { const out = s.outbox.find(o => o.eventId === event.eventId); if (out) { out.status = 'FAILED'; out.attempts++; out.lastError = error instanceof Error ? error.message : 'Sync failed' }; const stored = s.events.find(e => e.event.eventId === event.eventId); if (stored) stored.syncStatus = 'FAILED' }) }
    }
    for (const event of await this.provider.pull()) await this.receive(event)
  }
  async snapshot() { return this.repository.snapshot() }
}
