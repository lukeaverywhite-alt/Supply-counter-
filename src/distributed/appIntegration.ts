import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { seedData } from '../data'
import { STORAGE_KEY, statusFor } from '../domain'
import { MockIdentityProvider } from '../identity/identity'
import { IndexedDbRepository, type ArgusRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import type { AppData, AuditEvent } from '../types'
import { ArgusReplica } from './replica'

export const LEGACY_MIGRATION_MARKER = 'argus.distributed.migration.v1'

export async function migrateLegacyData(repository: ArgusRepository, storage: Pick<Storage, 'getItem' | 'setItem'>, fallback: AppData = seedData) {
  await repository.initialize()
  const before = await repository.snapshot()
  if (before.inventory.length || storage.getItem(LEGACY_MIGRATION_MARKER)) return false
  const raw = storage.getItem(STORAGE_KEY)
  let source = fallback
  if (raw) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('Legacy A.R.G.U.S. data is unreadable; it was not erased or marked as migrated.') }
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 3 || !Array.isArray((parsed as AppData).inventory)) throw new Error('Legacy A.R.G.U.S. schema is unsupported; it was not erased or marked as migrated.')
    source = parsed as AppData
  }
  await repository.transaction(state => { if (!state.inventory.length) state.inventory = source.inventory.map(item => ({ entityId: item.id, name: item.name, onHand: item.onHand, issued: item.issued, version: 0, appliedEventIds: [] })); if (!state.cadets.length) { const ids = new Map(source.cadets.map(c => [c.id, `cadet_${crypto.randomUUID()}`])); state.cadets = source.cadets.map(c => ({ cadetId: ids.get(c.id)!, fullName: c.name, gender: 'Male', nsLevel: ['NS1','NS2','NS3','NS4'].includes(c.level) ? c.level as 'NS1'|'NS2'|'NS3'|'NS4' : 'NS1', status: c.active ? 'ACTIVE' : 'INACTIVE', sizes: {}, currentProperty: [], createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z', version: 1, appliedEventIds: [] })); state.stillNeeded = source.stillNeeded.filter(n => ids.has(n.cadetId)).map(n => ({ requirementId: `need_${crypto.randomUUID()}`, cadetId: ids.get(n.cadetId)!, itemId: n.itemId, displayLabel: source.inventory.find(i => i.id === n.itemId)?.name ?? 'Legacy inventory item', size: n.requiredSize, quantityNeeded: n.quantity, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: n.firstNeededAt, updatedAt: n.firstNeededAt, source: 'MANUAL', version: 1, appliedEventIds: [] })) } })
  storage.setItem(LEGACY_MIGRATION_MARKER, '1')
  return true
}

const auditFrom = (state: Awaited<ReturnType<ArgusRepository['snapshot']>>): AuditEvent[] => state.events.map(({ event, auditStatus }) => ({
  eventVersion: 1, eventId: event.eventId, timestamp: event.timestamp, actorId: event.actorPublicIdentity, type: event.eventType as AuditEvent['type'], summary: event.eventType === 'INVENTORY_COUNT_SUBMITTED' ? 'Submitted Fall inventory as a signed count event' : event.eventType === 'ITEM_ISSUED' ? 'Issued inventory as a signed event' : event.eventType === 'ITEM_RETURNED' ? 'Returned inventory as a signed event' : event.eventType.replaceAll('_', ' ').toLowerCase(), entityId: event.entityId,
  data: Object.fromEntries(Object.entries(event.payload).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))),
  audit: { status: auditStatus === 'FAILED' ? 'FAILED' : auditStatus === 'CONFIRMED' || auditStatus === 'PROOF_VERIFIED' ? 'CONFIRMED' : 'QUEUED_FOR_AUDIT', targetNetwork: 'TESTNET' },
}))

export class DistributedAppController {
  readonly identity = new MockIdentityProvider('supply-officer-development')
  readonly provider = new MockSyncProvider()
  readonly repository: ArgusRepository
  private replica?: ArgusReplica
  constructor(repository: ArgusRepository = new IndexedDbRepository('argus-operational-v2')) { this.repository = repository }
  async initialize(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
    await migrateLegacyData(this.repository, storage)
    const root = new MockIdentityProvider('root-development'), authorization = new AuthorizationService(await root.getPublicIdentity(), this.identity)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await this.identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2020-01-01T00:00:00.000Z' }))
    this.replica = new ArgusReplica(this.repository, this.identity, authorization, this.provider)
    await this.replica.initialize()
    return this.project()
  }
  setOnline(value: boolean) { if (this.replica) this.replica.online = value }
  async issue(itemId: string, quantity: number) { await this.ready().issue(itemId, quantity); return this.project() }
  async returnItem(itemId: string, quantity: number) { await this.ready().returnItem(itemId, quantity); return this.project() }
  async issueTransaction(input: Parameters<ArgusReplica['issueTransaction']>[0], options?: Parameters<ArgusReplica['issueTransaction']>[1]) { const event = await this.ready().issueTransaction(input, options); return { event, state: await this.technicalState() } }
  async returnTransaction(input: Parameters<ArgusReplica['returnTransaction']>[0], options?: Parameters<ArgusReplica['returnTransaction']>[1]) { const event = await this.ready().returnTransaction(input, options); return { event, state: await this.technicalState() } }
  async submitCount(itemId: string, quantity: number, sessionId: string) { await this.ready().submitCount(itemId, quantity, sessionId); return this.project() }
  async sync() { await this.ready().sync(); return this.project() }
  private ready() { if (!this.replica) throw new Error('Distributed application repository is not initialized.'); return this.replica }
  async project(base: AppData = seedData): Promise<AppData> { const state = await this.repository.snapshot(); return { ...structuredClone(base), inventory: base.inventory.map(item => { const projected = state.inventory.find(candidate => candidate.entityId === item.id); return projected ? { ...item, onHand: projected.onHand, issued: projected.issued ?? item.issued, status: statusFor({ onHand: projected.onHand, reorderAt: item.reorderAt }) } : item }), audit: auditFrom(state) } }
  async technicalState() { return this.repository.snapshot() }
}
