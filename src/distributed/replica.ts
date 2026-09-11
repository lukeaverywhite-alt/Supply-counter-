import type { AuthorizationService } from '../auth/authorization'
import { canonicalize } from './canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { ArgusPermission, ConflictRecord, InventoryProjection, SignedArgusEvent, UnsignedArgusEvent } from './types'
import type { ArgusRepository, RepositoryState } from '../storage/repository'
import type { MockSyncProvider } from '../sync/mock'
import type { BundleVersionProjection, CadetProjection, StillNeededProjection } from './types'
import { FACTORY_BUNDLES, validateBundle, validateCadet, validateRequirement } from '../stage3/domain'

const permissionFor = (type: SignedArgusEvent['eventType']): ArgusPermission | undefined => ({ ITEM_ISSUED: 'inventory.issue', ITEM_RETURNED: 'inventory.return', INVENTORY_COUNT_SUBMITTED: 'inventory.count', CONFLICT_RESOLVED: 'conflicts.resolve', CADET_CREATED: 'cadets.manage', CADET_UPDATED: 'cadets.manage', BUNDLE_CREATED: 'bundles.manage', BUNDLE_UPDATED: 'bundles.manage', BUNDLE_DEACTIVATED: 'bundles.manage', STILL_NEEDED_ADDED: 'cadets.manage', STILL_NEEDED_UPDATED: 'cadets.manage', STILL_NEEDED_CANCELLED: 'cadets.manage', STILL_NEEDED_FULFILLED: 'cadets.manage' } as Partial<Record<SignedArgusEvent['eventType'], ArgusPermission>>)[type]
const unsigned = (event: SignedArgusEvent) => { const rest: Partial<SignedArgusEvent> = { ...event }; delete rest.signature; return canonicalize(rest) }

export class ArgusReplica {
  online = true
  constructor(readonly repository: ArgusRepository, private identity: ArgusIdentityProvider, private authorization: AuthorizationService, private provider: MockSyncProvider, readonly organizationId = 'argus-demo-organization') {}
  async initialize(items: Array<Omit<InventoryProjection, 'appliedEventIds'>> = []) {
    await this.repository.initialize()
    await this.repository.transaction(s => { if (!s.inventory.length) s.inventory = items.map(item => ({ ...item, appliedEventIds: [] })); for (const version of FACTORY_BUNDLES) if (!s.bundles.some(b => b.bundleId === version.bundleId)) s.bundles.push({ bundleId: version.bundleId, currentVersion: 1, versions: [structuredClone(version)], appliedEventIds: [version.eventId] }) })
  }
  private async signed(input: Omit<UnsignedArgusEvent, 'protocol' | 'protocolVersion' | 'organizationId' | 'eventVersion' | 'eventId' | 'actorPublicIdentity' | 'timestamp'> & { eventId?: string; timestamp?: string }) {
    const event = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: this.organizationId, eventVersion: 1 as const, eventId: input.eventId ?? crypto.randomUUID(), eventType: input.eventType, entityId: input.entityId, actorPublicIdentity: await this.identity.getPublicIdentity(), timestamp: input.timestamp ?? new Date().toISOString(), ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }), payload: input.payload }
    return { ...event, signature: await this.identity.sign(canonicalize(event)) }
  }
  async issue(entityId: string, quantity: number, options: { eventId?: string; timestamp?: string } = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item) throw new Error('Inventory item was not found.'); if (quantity <= 0 || item.onHand < quantity) throw new Error('Insufficient inventory.')
    const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'inventory.issue', options.timestamp)
    const event = await this.signed({ eventType: 'ITEM_ISSUED', entityId, baseVersion: item.version, payload: { quantity }, ...options })
    await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async returnItem(entityId: string, quantity: number, options: { eventId?: string; timestamp?: string } = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item) throw new Error('Inventory item was not found.'); if (!Number.isInteger(quantity) || quantity <= 0 || (item.issued ?? 0) < quantity) throw new Error('Invalid return quantity.')
    const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'inventory.return', options.timestamp)
    const event = await this.signed({ eventType: 'ITEM_RETURNED', entityId, baseVersion: item.version, payload: { quantity }, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async submitCount(entityId: string, countedQuantity: number, sessionId: string, options: { eventId?: string; timestamp?: string } = {}) {
    const state = await this.repository.snapshot(); const item = state.inventory.find(i => i.entityId === entityId)
    if (!item || !Number.isInteger(countedQuantity) || countedQuantity < 0) throw new Error('Invalid physical count.')
    const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'inventory.count', options.timestamp)
    const event = await this.signed({ eventType: 'INVENTORY_COUNT_SUBMITTED', entityId, baseVersion: item.version, payload: { sessionId, expectedQuantity: item.onHand, countedQuantity, discrepancy: countedQuantity - item.onHand }, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async correct(originalEventId: string, entityId: string, field: string, value: unknown, reason: string) {
    const event = await this.signed({ eventType: 'RECORD_CORRECTED', entityId, payload: { originalEventId, field, value, reason } }); await this.persistLocal(event); return event
  }
  async createCadet(input: Pick<CadetProjection, 'fullName' | 'gender' | 'nsLevel' | 'status'> & { sizes?: Record<string, string> }, options: { eventId?: string; timestamp?: string } = {}) {
    const value = { ...input, sizes: input.sizes ?? {} }; validateCadet(value); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'cadets.manage', options.timestamp)
    const id = `cadet_${crypto.randomUUID()}`, event = await this.signed({ eventType: 'CADET_CREATED', entityId: id, payload: value, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async updateCadet(cadetId: string, changes: Partial<Pick<CadetProjection, 'fullName' | 'gender' | 'nsLevel' | 'status' | 'sizes'>>, options: { eventId?: string; timestamp?: string } = {}) {
    const cadet = (await this.repository.snapshot()).cadets.find(c => c.cadetId === cadetId); if (!cadet) throw new Error('Cadet was not found.'); const next = { ...cadet, ...changes }; validateCadet(next); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'cadets.manage', options.timestamp)
    const event = await this.signed({ eventType: 'CADET_UPDATED', entityId: cadetId, baseVersion: cadet.version, payload: changes, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async updateBundle(bundleId: string, input: Omit<BundleVersionProjection, 'bundleId' | 'version' | 'createdAt' | 'actorPublicIdentity' | 'priorVersion' | 'eventId'>, options: { eventId?: string; timestamp?: string } = {}) {
    const current = (await this.repository.snapshot()).bundles.find(b => b.bundleId === bundleId); if (!current) throw new Error('Bundle was not found.'); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'bundles.manage', options.timestamp); validateBundle({ ...input, version: current.currentVersion + 1 })
    const event = await this.signed({ eventType: 'BUNDLE_UPDATED', entityId: bundleId, baseVersion: current.currentVersion, payload: input, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async createBundle(bundleId: string, input: Omit<BundleVersionProjection, 'bundleId' | 'version' | 'createdAt' | 'actorPublicIdentity' | 'priorVersion' | 'eventId'>, options: { eventId?: string; timestamp?: string } = {}) { const state = await this.repository.snapshot(); if (!bundleId || state.bundles.some(b => b.bundleId === bundleId)) throw new Error('Bundle ID is invalid or already exists.'); validateBundle({ ...input, version: 1 }, state.inventory); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'bundles.manage', options.timestamp); const event = await this.signed({ eventType: 'BUNDLE_CREATED', entityId: bundleId, payload: input, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event }
  async addStillNeeded(input: Omit<StillNeededProjection, 'requirementId' | 'version' | 'appliedEventIds' | 'updatedAt'> & { requirementId?: string }, options: { eventId?: string; timestamp?: string } = {}) {
    validateRequirement(input); const state = await this.repository.snapshot(); if (!state.cadets.some(c => c.cadetId === input.cadetId)) throw new Error('Cadet was not found.'); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'cadets.manage', options.timestamp); const id = input.requirementId ?? `need_${crypto.randomUUID()}`
    const event = await this.signed({ eventType: 'STILL_NEEDED_ADDED', entityId: id, payload: input, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event
  }
  async updateStillNeeded(requirementId: string, changes: Partial<Pick<StillNeededProjection,'displayLabel'|'itemId'|'size'|'quantityNeeded'|'quantityFulfilled'|'status'>>, options: { eventId?: string; timestamp?: string } = {}) { const requirement = (await this.repository.snapshot()).stillNeeded.find(r => r.requirementId === requirementId); if (!requirement) throw new Error('Still Needed requirement was not found.'); const next = { ...requirement, ...changes }; validateRequirement(next); const actor = await this.identity.getPublicIdentity(); this.authorization.require(actor, 'cadets.manage', options.timestamp); const type = next.status === 'CANCELLED' ? 'STILL_NEEDED_CANCELLED' : next.status === 'FULFILLED' ? 'STILL_NEEDED_FULFILLED' : 'STILL_NEEDED_UPDATED'; const event = await this.signed({ eventType: type, entityId: requirementId, baseVersion: requirement.version, payload: changes, ...options }); await this.persistLocal(event); if (this.online) await this.sync(); return event }
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
      } else { item.onHand += delta; item.issued = Math.max(0, (item.issued ?? 0) - delta); item.version += 1; item.appliedEventIds.push(event.eventId) }
    }
    if (event.eventType === 'INVENTORY_COUNT_SUBMITTED') { const item = state.inventory.find(i => i.entityId === event.entityId); const counted = event.payload.countedQuantity; if (!item || !Number.isInteger(counted) || Number(counted) < 0) throw new Error('Corrupted count event.'); if (event.baseVersion !== item.version) throw new Error('Count base version conflict.'); item.onHand = Number(counted); item.version++; item.appliedEventIds.push(event.eventId) }
    if (event.eventType === 'CADET_CREATED') { const value = event.payload as unknown as Pick<CadetProjection, 'fullName'|'gender'|'nsLevel'|'status'|'sizes'>; validateCadet(value); if (state.cadets.some(c => c.cadetId === event.entityId)) throw new Error('Cadet ID already exists.'); state.cadets.push({ cadetId: event.entityId, ...value, currentProperty: [], createdAt: event.timestamp, updatedAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] }) }
    if (event.eventType === 'CADET_UPDATED') { const cadet = state.cadets.find(c => c.cadetId === event.entityId); if (!cadet) throw new Error('Cadet projection is missing.'); if (event.baseVersion !== cadet.version) this.addConflict(state, event, 'Concurrent cadet updates require reconciliation.'); else { const next = { ...cadet, ...event.payload }; validateCadet(next); Object.assign(cadet, event.payload, { updatedAt: event.timestamp, version: cadet.version + 1 }); cadet.appliedEventIds.push(event.eventId) } }
    if (event.eventType === 'BUNDLE_UPDATED') { const bundle = state.bundles.find(b => b.bundleId === event.entityId); if (!bundle) throw new Error('Bundle projection is missing.'); if (event.baseVersion !== bundle.currentVersion) this.addConflict(state, event, 'Concurrent bundle edits require reconciliation.'); else { const version = { ...(event.payload as unknown as Omit<BundleVersionProjection,'bundleId'|'version'|'createdAt'|'actorPublicIdentity'|'priorVersion'|'eventId'>), bundleId: bundle.bundleId, version: bundle.currentVersion + 1, createdAt: event.timestamp, actorPublicIdentity: event.actorPublicIdentity, priorVersion: bundle.currentVersion, eventId: event.eventId }; validateBundle(version); bundle.versions.push(version); bundle.currentVersion++; bundle.appliedEventIds.push(event.eventId) } }
    if (event.eventType === 'BUNDLE_CREATED') { const value = event.payload as unknown as Omit<BundleVersionProjection,'bundleId'|'version'|'createdAt'|'actorPublicIdentity'|'priorVersion'|'eventId'>; const version = { ...value, bundleId: event.entityId, version: 1, createdAt: event.timestamp, actorPublicIdentity: event.actorPublicIdentity, eventId: event.eventId }; validateBundle(version, state.inventory); if (state.bundles.some(b => b.bundleId === event.entityId)) throw new Error('Bundle ID already exists.'); state.bundles.push({ bundleId: event.entityId, currentVersion: 1, versions: [version], appliedEventIds: [event.eventId] }) }
    if (event.eventType === 'STILL_NEEDED_ADDED') { const value = event.payload as unknown as Omit<StillNeededProjection,'requirementId'|'version'|'appliedEventIds'|'updatedAt'>; validateRequirement(value); if (!state.cadets.some(c => c.cadetId === value.cadetId)) throw new Error('Cadet projection is missing.'); state.stillNeeded.push({ ...value, requirementId: event.entityId, updatedAt: event.timestamp, version: 1, appliedEventIds: [event.eventId] }) }
    if (['STILL_NEEDED_UPDATED','STILL_NEEDED_CANCELLED','STILL_NEEDED_FULFILLED'].includes(event.eventType)) { const requirement = state.stillNeeded.find(r => r.requirementId === event.entityId); if (!requirement) throw new Error('Still Needed projection is missing.'); if (event.baseVersion !== requirement.version) this.addConflict(state, event, 'Concurrent Still Needed updates require reconciliation.'); else { const next = { ...requirement, ...event.payload }; validateRequirement(next); Object.assign(requirement, event.payload, { updatedAt: event.timestamp, version: requirement.version + 1 }); requirement.appliedEventIds.push(event.eventId) } }
    if (event.eventType === 'CONFLICT_RESOLVED') { const conflict = state.conflicts.find(c => c.id === event.payload.conflictId); if (conflict) { conflict.status = 'RESOLVED'; conflict.resolutionEventId = event.eventId } }
    state.events.push({ event, syncStatus: 'SYNCHRONIZED', auditStatus: 'PENDING', receivedAt: new Date().toISOString() })
  }
  private addConflict(state: RepositoryState, event: SignedArgusEvent, reason: string) { const related = state.events.filter(e => e.event.entityId === event.entityId && e.event.baseVersion === event.baseVersion).map(e => e.event.eventId); const ids = [...related, event.eventId].sort(); const conflict = { id: `conflict:${ids.join(':')}`, entityId: event.entityId, eventIds: ids, status: 'OPEN' as const, reason }; if (!state.conflicts.some(c => c.id === conflict.id)) state.conflicts.push(conflict) }
  private async persistLocal(event: SignedArgusEvent) { await this.repository.transaction(state => { this.apply(state, event); const stored = state.events.find(e => e.event.eventId === event.eventId)!; stored.syncStatus = 'QUEUED'; state.outbox.push({ eventId: event.eventId, attempts: 0, status: 'QUEUED' }) }) }
  async receive(event: SignedArgusEvent) {
    if (event.protocol !== 'ARGUS' || event.protocolVersion !== 1 || event.eventVersion !== 1 || event.organizationId !== this.organizationId || !event.eventId || !event.actorPublicIdentity || !event.signature || !event.payload || typeof event.payload !== 'object') throw new Error('Malformed or unsupported distributed event.')
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
