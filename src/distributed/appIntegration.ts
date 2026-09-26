import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { seedData } from '../data'
import { STORAGE_KEY } from '../domain'
import { MockIdentityProvider } from '../identity/identity'
import { IndexedDbRepository, type ArgusRepository } from '../storage/repository'
import { MockSyncProvider, type EventSyncProvider } from '../sync/mock'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { AppData, AuditEvent } from '../types'
import { ArgusReplica } from './replica'
import type { BundleProjection, CadetProjection, ConflictRecord, CountSessionProjection, InventoryProjection, StillNeededProjection, StoredEvent, SupplyTransaction } from './types'
import { cadetReadiness, requirementAvailability } from '../stage3/domain'
import { inspectRepository, type IntegrityReport } from '../integrity'

export const LEGACY_MIGRATION_MARKER = 'argus.distributed.migration.stage3a5.v2'

export async function migrateLegacyData(repository: ArgusRepository, storage: Pick<Storage, 'getItem' | 'setItem'>, fallback: AppData = seedData) {
  await repository.initialize()
  if (storage.getItem(LEGACY_MIGRATION_MARKER)) return false
  const raw = storage.getItem(STORAGE_KEY)
  let source = fallback
  if (raw) {
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { throw new Error('Legacy A.R.G.U.S. data is unreadable; it was not erased or marked as migrated.') }
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 3 || !Array.isArray((parsed as AppData).inventory)) throw new Error('Legacy A.R.G.U.S. schema is unsupported; it was not erased or marked as migrated.')
    source = parsed as AppData
  }
  await repository.transaction(state => { if (!state.inventory.length) state.inventory = source.inventory.map(item => ({ entityId: item.id, name: item.name, category: item.category, variant: item.size || 'No variant', niin: item.niin, onHand: item.onHand, issued: item.issued, reorderAt: item.reorderAt, countIncrement: item.countBy, active: true, version: 0, appliedEventIds: [] })); if (!state.cadets.length) { const ids = new Map(source.cadets.map(c => [c.id, `cadet:${c.id}`])); state.cadets = source.cadets.map(c => ({ cadetId: ids.get(c.id)!, fullName: c.name, gender: 'Male', profileNeedsReview: true, nsLevel: ['NS1','NS2','NS3','NS4'].includes(c.level) ? c.level as 'NS1'|'NS2'|'NS3'|'NS4' : 'NS1', status: c.active ? 'ACTIVE' : 'INACTIVE', sizes: {}, currentProperty: [], createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z', version: 1, appliedEventIds: [] })); state.stillNeeded = source.stillNeeded.filter(n => ids.has(n.cadetId)).map(n => ({ requirementId: `need:${n.id}`, cadetId: ids.get(n.cadetId)!, itemId: state.inventory.some(i => i.entityId === n.itemId) ? n.itemId : undefined, displayLabel: source.inventory.find(i => i.id === n.itemId)?.name ?? 'Legacy inventory item', size: n.requiredSize, quantityNeeded: n.quantity, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: n.firstNeededAt, updatedAt: n.firstNeededAt, source: 'MANUAL', version: 1, appliedEventIds: [] })) } })
  storage.setItem(LEGACY_MIGRATION_MARKER, '1')
  return true
}

const auditFrom = (state: Awaited<ReturnType<ArgusRepository['snapshot']>>): AuditEvent[] => state.events.map(({ event, auditStatus }) => ({
  eventVersion: 1, eventId: event.eventId, timestamp: event.timestamp, actorId: event.actorPublicIdentity, type: event.eventType as AuditEvent['type'], summary: event.eventType === 'INVENTORY_COUNT_SUBMITTED' ? 'Submitted Fall inventory as a signed count event' : event.eventType === 'ITEM_ISSUED' ? 'Issued inventory as a signed event' : event.eventType === 'ITEM_RETURNED' ? 'Returned inventory as a signed event' : event.eventType.replaceAll('_', ' ').toLowerCase(), entityId: event.entityId,
  data: Object.fromEntries(Object.entries(event.payload).filter((entry): entry is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof entry[1]))),
  audit: { status: auditStatus === 'FAILED' ? 'FAILED' : auditStatus === 'CONFIRMED' || auditStatus === 'PROOF_VERIFIED' ? 'CONFIRMED' : 'QUEUED_FOR_AUDIT', targetNetwork: 'TESTNET' },
}))

export class DistributedAppController {
  readonly identity: ArgusIdentityProvider
  readonly provider: EventSyncProvider
  readonly repository: ArgusRepository
  private replica?: ArgusReplica
  private readonly authorization?: AuthorizationService
  private readonly organizationId: string
  private readonly demo: boolean
  readonly syncMode: 'local'|'remote'
  constructor(repository: ArgusRepository = new IndexedDbRepository('argus-operational-v2'), dependencies?: { identity: ArgusIdentityProvider; authorization: AuthorizationService; provider: EventSyncProvider; organizationId: string }) {
    this.repository = repository
    this.demo = !dependencies
    this.syncMode = dependencies ? 'remote' : 'local'
    this.identity = dependencies?.identity ?? new MockIdentityProvider('supply-officer-development')
    this.provider = dependencies?.provider ?? new MockSyncProvider()
    this.authorization = dependencies?.authorization
    this.organizationId = dependencies?.organizationId ?? 'argus-demo-organization'
  }
  async initialize(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
    await migrateLegacyData(this.repository, storage)
    let authorization = this.authorization
    if (this.demo) {
      const root = new MockIdentityProvider('root-development')
      authorization = new AuthorizationService(await root.getPublicIdentity(), this.identity)
      await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await this.identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2020-01-01T00:00:00.000Z' }))
    }
    if (!authorization) throw new Error('Operational mode requires an enrolled identity and signed authority credentials.')
    this.replica = new ArgusReplica(this.repository, this.identity, authorization, this.provider, this.organizationId)
    await this.replica.initialize()
    return this.project()
  }
  setOnline(value: boolean) { if (this.replica) this.replica.online = value }
  async issue(itemId: string, quantity: number) { await this.ready().issue(itemId, quantity); return this.project() }
  async returnItem(itemId: string, quantity: number) { await this.ready().returnItem(itemId, quantity); return this.project() }
  async issueTransaction(input: Parameters<ArgusReplica['issueTransaction']>[0], options?: Parameters<ArgusReplica['issueTransaction']>[1]) { await this.ready().issueTransaction(input, options); return this.project() }
  async returnTransaction(input: Parameters<ArgusReplica['returnTransaction']>[0], options?: Parameters<ArgusReplica['returnTransaction']>[1]) { await this.ready().returnTransaction(input, options); return this.project() }
  async submitCount(itemId: string, quantity: number, sessionId: string, note = '') { await this.ready().submitCount(itemId, quantity, sessionId, note); return this.project() }
  async createCountSession(input: Parameters<ArgusReplica['createCountSession']>[0]) { await this.ready().createCountSession(input); return this.project() }
  async contributeCount(sessionId: string, assignmentId: string, quantity: number, note = '') { await this.ready().contributeCount(sessionId, assignmentId, quantity, note); return this.project() }
  async correctCount(sessionId: string, originalEventId: string, replacementQuantity: number, reason: string) { await this.ready().correctCount(sessionId, originalEventId, replacementQuantity, reason); return this.project() }
  async recount(sessionId: string, assignmentId: string, quantity: number, reason: string) { await this.ready().recount(sessionId, assignmentId, quantity, reason); return this.project() }
  async submitCountSession(sessionId: string) { await this.ready().submitCountSession(sessionId); return this.project() }
  async reconcileCountSession(sessionId: string) { await this.ready().reconcileCountSession(sessionId); return this.project() }
  async createInventoryItem(input: Omit<InventoryProjection, 'entityId'|'version'|'appliedEventIds'|'issued'>) { await this.ready().createInventoryItem(input); return this.project() }
  async updateInventoryItem(itemId: string, changes: Partial<Pick<InventoryProjection, 'name'|'category'|'variant'|'niin'|'reorderAt'|'countIncrement'|'active'>>) { await this.ready().updateInventoryItem(itemId, changes); return this.project() }
  async createCadet(input: Pick<CadetProjection, 'fullName'|'gender'|'nsLevel'|'status'> & { sizes?: Record<string,string> }) { await this.ready().createCadet(input); return this.project() }
  async updateCadet(id: string, changes: Partial<Pick<CadetProjection, 'fullName'|'gender'|'nsLevel'|'status'|'sizes'>>) { await this.ready().updateCadet(id, changes); return this.project() }
  async updateBundle(id: string, input: Parameters<ArgusReplica['updateBundle']>[1]) { await this.ready().updateBundle(id, input); return this.project() }
  async addStillNeeded(input: Parameters<ArgusReplica['addStillNeeded']>[0]) { await this.ready().addStillNeeded(input); return this.project() }
  async updateStillNeeded(id: string, changes: Parameters<ArgusReplica['updateStillNeeded']>[1]) { await this.ready().updateStillNeeded(id, changes); return this.project() }
  async sync() { await this.ready().sync(); return this.project() }
  /** Polling/reconnect bridge for React and other normal-runtime clients. */
  startAutoSync(onProjection: (projection: ArgusAppProjection) => void, intervalMs = 5_000) {
    let stopped = false, running = false
    const run = async () => { if (stopped || running) return; running = true; try { const projection = await this.sync(); if (!stopped) onProjection(projection) } catch { /* the durable outbox remains retryable */ } finally { running = false } }
    const timer = setInterval(() => { void run() }, intervalMs), online = () => { void run() }
    globalThis.addEventListener?.('online', online); void run()
    return () => { stopped = true; clearInterval(timer); globalThis.removeEventListener?.('online', online) }
  }
  private ready() { if (!this.replica) throw new Error('Distributed application repository is not initialized.'); return this.replica }
  async project(): Promise<ArgusAppProjection> { const state = await this.repository.snapshot(); const openNeeds=state.stillNeeded.filter(item=>['OPEN','PARTIALLY_FULFILLED'].includes(item.status)); return { inventory: state.inventory, countSessions: state.countSessions, cadets: state.cadets.map(cadet => ({ ...cadet, propertyCount: cadet.currentProperty.reduce((sum, item) => sum + item.quantity, 0), stillNeededCount: openNeeds.filter(item => item.cadetId === cadet.cadetId).length, readiness: cadetReadiness(openNeeds.filter(item => item.cadetId === cadet.cadetId)) })), bundles: state.bundles.map(bundle => ({ ...bundle, mapping: bundleMapping(bundle, state.inventory) })), stillNeeded: openNeeds.map(requirement => ({ ...requirement, availability: requirementAvailability(requirement, state.inventory) })), transactions: state.transactions, conflicts: state.conflicts, events: state.events, audit: auditFrom(state), sync: { mode: this.syncMode, outbox: state.outbox.length, openConflicts: state.conflicts.filter(conflict => conflict.status === 'OPEN').length }, integrity: inspectRepository(state) } }
  async technicalState() { return this.repository.snapshot() }
}

export type BundleMapping = { status: 'FULLY_MAPPED'|'PARTIALLY_MAPPED'|'UNMAPPED'; mapped: number; total: number }
export const bundleMapping = (bundle: BundleProjection, inventory: InventoryProjection[]): BundleMapping => { const current = bundle.versions.find(version => version.version === bundle.currentVersion); const mapped = current?.lines.filter(line => line.itemId && inventory.some(item => item.entityId === line.itemId)).length ?? 0; const total = current?.lines.length ?? 0; return { status: mapped === total && total > 0 ? 'FULLY_MAPPED' : mapped ? 'PARTIALLY_MAPPED' : 'UNMAPPED', mapped, total } }
export type ArgusAppProjection = { inventory: InventoryProjection[]; countSessions: CountSessionProjection[]; cadets: Array<CadetProjection & { propertyCount: number; stillNeededCount: number; readiness: ReturnType<typeof cadetReadiness> }>; bundles: Array<BundleProjection & { mapping: BundleMapping }>; stillNeeded: Array<StillNeededProjection & { availability: ReturnType<typeof requirementAvailability> }>; transactions: SupplyTransaction[]; conflicts: ConflictRecord[]; events: StoredEvent[]; audit: AuditEvent[]; sync: { mode: 'local'|'remote'; outbox: number; openConflicts: number }; integrity: IntegrityReport }
