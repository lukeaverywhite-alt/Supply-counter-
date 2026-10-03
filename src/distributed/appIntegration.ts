import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository, type ArgusRepository } from '../storage/repository'
import { MockSyncProvider, type EventSyncProvider } from '../sync/mock'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { AuditEvent } from '../types'
import { ArgusReplica } from './replica'
import type { NoticeAudience, NoticeProjection, AuthorityCredential, AuthorityRevocation, BundleProjection, CalendarEventProjection, PropertyCorrection, RolloverRecord, CadetProjection, CatalogItemProjection, ConflictRecord, CountSessionProjection, InventoryProjection, KeyEpochProjection, TicketProjection, MemberProjection, RecoveryKeyProjection, RejectedEventRecord, StillNeededProjection, StoredEvent, SupplyTransaction } from './types'
import { cadetReadiness, requirementAvailability } from '../stage3/domain'
import { inspectRepository, type IntegrityReport } from '../integrity'
import { conflictLosers, withConflictStatus } from './delivery'

const auditFrom = (state: Awaited<ReturnType<ArgusRepository['snapshot']>>): AuditEvent[] => state.events.map(({ event, auditStatus }) => ({
  eventVersion: 1, eventId: event.eventId, timestamp: event.timestamp, actorId: event.actorPublicIdentity, type: event.eventType as AuditEvent['type'], summary: event.eventType.replaceAll('_', ' ').toLowerCase(), entityId: event.entityId,
  // Only non-identifying scalar fields are surfaced in audit rows; names and notes stay in the encrypted event.
  data: Object.fromEntries(Object.entries(event.payload).filter((entry): entry is [string, string | number | boolean] => !['fullName', 'displayName', 'note', 'reason', 'resolution'].includes(entry[0]) && ['string', 'number', 'boolean'].includes(typeof entry[1]))),
  audit: { status: auditStatus === 'FAILED' ? 'FAILED' : auditStatus === 'CONFIRMED' || auditStatus === 'PROOF_VERIFIED' ? 'CONFIRMED' : 'QUEUED_FOR_AUDIT', targetNetwork: 'TESTNET' },
}))

export type ControllerDependencies = { identity: ArgusIdentityProvider; authorization: AuthorizationService; provider: EventSyncProvider; organizationId: string; genesisCatalog?: boolean; strictPublish?: boolean; authorBoundEventIds?: boolean }

/**
 * The single application-facing API. Every mutation is a signed, permission-checked domain event
 * folded by ArgusReplica. With dependencies from a unit runtime, events are encrypted and shared
 * on BSV TESTNET; without them (tests, mock-development) it is a single-device demo with a mock
 * identity — it never invents inventory, cadets or quantities.
 */
export class DistributedAppController {
  readonly identity: ArgusIdentityProvider
  readonly provider: EventSyncProvider
  readonly repository: ArgusRepository
  private replica?: ArgusReplica
  private readonly authorization?: AuthorizationService
  private readonly organizationId: string
  private readonly demo: boolean
  private readonly options: { genesisCatalog: boolean; strictPublish: boolean; authorBoundEventIds: boolean }
  readonly syncMode: 'local'|'remote'
  constructor(repository: ArgusRepository = new MemoryRepository(), dependencies?: ControllerDependencies) {
    this.repository = repository
    this.demo = !dependencies
    this.syncMode = dependencies ? 'remote' : 'local'
    this.identity = dependencies?.identity ?? new MockIdentityProvider('supply-officer-development')
    this.provider = dependencies?.provider ?? new MockSyncProvider()
    this.authorization = dependencies?.authorization
    this.organizationId = dependencies?.organizationId ?? 'argus-demo-organization'
    this.options = { genesisCatalog: dependencies?.genesisCatalog ?? true, strictPublish: dependencies?.strictPublish ?? false, authorBoundEventIds: dependencies?.authorBoundEventIds ?? false }
  }
  async initialize() {
    let authorization = this.authorization
    if (this.demo) {
      const root = new MockIdentityProvider('root-development')
      authorization = new AuthorizationService(await root.getPublicIdentity(), this.identity)
      await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await this.identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2020-01-01T00:00:00.000Z' }))
    }
    if (!authorization) throw new Error('Operational mode requires an enrolled identity and signed authority credentials.')
    this.replica = new ArgusReplica(this.repository, this.identity, authorization, this.provider, this.organizationId, this.options)
    await this.replica.initialize()
    if (!this.demo) await this.replica.sync().catch(() => undefined)
    return this.project()
  }
  get authorizationService() { return this.authorization }
  setOnline(value: boolean) { if (this.replica) this.replica.online = value }
  private async run(operation: (replica: ArgusReplica) => Promise<unknown>) { await operation(this.ready()); return this.project() }
  issue(itemId: string, quantity: number) { return this.run(r => r.issue(itemId, quantity)) }
  returnItem(itemId: string, quantity: number) { return this.run(r => r.returnItem(itemId, quantity)) }
  issueTransaction(input: Parameters<ArgusReplica['issueTransaction']>[0], options?: Parameters<ArgusReplica['issueTransaction']>[1]) { return this.run(r => r.issueTransaction(input, options)) }
  returnTransaction(input: Parameters<ArgusReplica['returnTransaction']>[0], options?: Parameters<ArgusReplica['returnTransaction']>[1]) { return this.run(r => r.returnTransaction(input, options)) }
  submitCount(itemId: string, quantity: number, sessionId: string, note = '') { return this.run(r => r.submitCount(itemId, quantity, sessionId, note)) }
  createCountSession(input: Parameters<ArgusReplica['createCountSession']>[0]) { return this.run(r => r.createCountSession(input)) }
  contributeCount(sessionId: string, target: string | { itemId: string }, quantity: number, note = '') { return this.run(r => r.contributeCount(sessionId, target, quantity, note)) }
  correctCount(sessionId: string, originalEventId: string, replacementQuantity: number, reason: string) { return this.run(r => r.correctCount(sessionId, originalEventId, replacementQuantity, reason)) }
  recount(sessionId: string, assignmentId: string, quantity: number, reason: string) { return this.run(r => r.recount(sessionId, assignmentId, quantity, reason)) }
  submitCountSession(sessionId: string) { return this.run(r => r.submitCountSession(sessionId)) }
  reopenCountSession(sessionId: string, reason: string) { return this.run(r => r.reopenCountSession(sessionId, reason)) }
  reconcileCountSession(sessionId: string) { return this.run(r => r.reconcileCountSession(sessionId)) }
  finalizeCountSession(sessionId: string) { return this.run(r => r.finalizeCountSession(sessionId)) }
  cancelCountSession(sessionId: string, reason: string) { return this.run(r => r.cancelCountSession(sessionId, reason)) }
  createInventoryItem(input: Omit<InventoryProjection, 'entityId'|'version'|'appliedEventIds'|'issued'>) { return this.run(r => r.createInventoryItem(input)) }
  updateInventoryItem(itemId: string, changes: Parameters<ArgusReplica['updateInventoryItem']>[1]) { return this.run(r => r.updateInventoryItem(itemId, changes)) }
  receiveStock(itemId: string, quantity: number, note = '') { return this.run(r => r.receiveStock(itemId, quantity, note)) }
  createCatalogItem(input: Parameters<ArgusReplica['createCatalogItem']>[0]) { return this.run(r => r.createCatalogItem(input)) }
  updateCatalogItem(catalogId: string, changes: Parameters<ArgusReplica['updateCatalogItem']>[1]) { return this.run(r => r.updateCatalogItem(catalogId, changes)) }
  addCatalogSizes(catalogId: string, labels: string[]) { return this.run(r => r.addCatalogSizes(catalogId, labels)) }
  createCadet(input: Parameters<ArgusReplica['createCadet']>[0]) { return this.run(r => r.createCadet(input)) }
  updateCadet(id: string, changes: Parameters<ArgusReplica['updateCadet']>[1]) { return this.run(r => r.updateCadet(id, changes)) }
  updateBundle(id: string, input: Parameters<ArgusReplica['updateBundle']>[1]) { return this.run(r => r.updateBundle(id, input)) }
  addStillNeeded(input: Parameters<ArgusReplica['addStillNeeded']>[0]) { return this.run(r => r.addStillNeeded(input)) }
  updateStillNeeded(id: string, changes: Parameters<ArgusReplica['updateStillNeeded']>[1]) { return this.run(r => r.updateStillNeeded(id, changes)) }
  fulfilStillNeeded(id: string, note = '') { return this.run(r => r.fulfilStillNeeded(id, note)) }
  cancelStillNeeded(id: string, reason: string) { return this.run(r => r.cancelStillNeeded(id, reason)) }
  resolveConflict(conflictId: string, resolution: string, outcome?: Parameters<ArgusReplica['resolve']>[2]) { return this.run(r => r.resolve(conflictId, resolution, outcome)) }
  correctRecord(input: Parameters<ArgusReplica['correctRecord']>[0], options?: Parameters<ArgusReplica['correctRecord']>[1]) { return this.run(r => r.correctRecord(input, options)) }
  createCalendarEvent(input: Parameters<ArgusReplica['createCalendarEvent']>[0]) { return this.run(r => r.createCalendarEvent(input)) }
  /** `base` is the event as it was on screen when editing began, so a concurrent edit of the same field surfaces as a conflict. */
  updateCalendarEvent(id: string, changes: Parameters<ArgusReplica['updateCalendarEvent']>[1], base?: CalendarEventProjection) { return this.run(r => r.updateCalendarEvent(id, changes, base ? { base } : {})) }
  addCalendarTask(id: string, task: Parameters<ArgusReplica['addCalendarTask']>[1]) { return this.run(r => r.addCalendarTask(id, task)) }
  completeTask(id: string, taskId: string, completed = true) { return this.run(r => r.completeTask(id, taskId, completed)) }
  updateCalendarTask(id: string, taskId: string, changes: Parameters<ArgusReplica['updateCalendarTask']>[2]) { return this.run(r => r.updateCalendarTask(id, taskId, changes)) }
  removeCalendarTask(id: string, taskId: string) { return this.run(r => r.removeCalendarTask(id, taskId)) }
  addCalendarAttendees(id: string, cadetIds: string[]) { return this.run(r => r.addCalendarAttendees(id, cadetIds)) }
  removeCalendarAttendees(id: string, cadetIds: string[]) { return this.run(r => r.removeCalendarAttendees(id, cadetIds)) }
  addCalendarBundles(id: string, bundleIds: string[]) { return this.run(r => r.addCalendarBundles(id, bundleIds)) }
  removeCalendarBundles(id: string, bundleIds: string[]) { return this.run(r => r.removeCalendarBundles(id, bundleIds)) }
  correctIssuedSize(input: Parameters<ArgusReplica['correctIssuedSize']>[0]) { return this.run(r => r.correctIssuedSize(input)) }
  completeAnnualRollover(schoolYear: string) { return this.run(r => r.completeAnnualRollover(schoolYear)) }
  importCadets(rows: Parameters<ArgusReplica['importCadets']>[0]) { return this.run(r => r.importCadets(rows)) }
  updateBundleDefinition(id: string, input: Parameters<ArgusReplica['updateBundle']>[1]) { return this.run(r => r.updateBundle(id, input)) }
  createBundle(id: string, input: Parameters<ArgusReplica['createBundle']>[1]) { return this.run(r => r.createBundle(id, input)) }
  async recordAdmission(input: { credential: AuthorityCredential; displayName: string; walletAddress?: string; ecdhPublicKey?: string }) { await this.authorization?.acceptCredential(input.credential); return this.run(r => r.recordAdmission(input)) }
  confirmAdmission(credentialId: string) { return this.run(r => r.confirmAdmission(credentialId)) }
  async recordRevocation(revocation: AuthorityRevocation) { await this.authorization?.acceptRevocation(revocation); return this.run(r => r.recordRevocation(revocation)) }
  async changeRole(input: { credential: AuthorityCredential; revocation: AuthorityRevocation }) { await this.authorization?.acceptCredential(input.credential); await this.authorization?.acceptRevocation(input.revocation); return this.run(r => r.changeRole(input)) }
  rotateUnitKey(input: Parameters<ArgusReplica['rotateUnitKey']>[0]) { return this.run(r => r.rotateUnitKey(input)) }
  registerRecoveryKey(input: Parameters<ArgusReplica['registerRecoveryKey']>[0]) { return this.run(r => r.registerRecoveryKey(input)) }
  recordTicketIssued(fact: Parameters<ArgusReplica['recordTicketIssued']>[0]) { return this.run(r => r.recordTicketIssued(fact)) }
  recordTicketCancelled(fact: Parameters<ArgusReplica['recordTicketCancelled']>[0]) { return this.run(r => r.recordTicketCancelled(fact)) }
  recordTicketRedeemed(fact: Parameters<ArgusReplica['recordTicketRedeemed']>[0]) { return this.run(r => r.recordTicketRedeemed(fact)) }
  createCadetChannel(cadetId: string) { return this.run(r => r.createCadetChannel(cadetId)) }
  rotateCadetChannel(cadetId: string, reason: string) { return this.run(r => r.rotateCadetChannel(cadetId, reason)) }
  createNoticesKey() { return this.run(r => r.createNoticesKey()) }
  sendNotice(audience: NoticeAudience, text: string) { return this.run(r => r.sendNotice(audience, text)) }
  recordCadetTicketIssued(fact: Parameters<ArgusReplica['recordCadetTicketIssued']>[0]) { return this.run(r => r.recordCadetTicketIssued(fact)) }
  /** The record a cadet's phone reads (ADR 013); built from this device's fold. */
  cadetViewFor(cadetId: string) { return this.ready().cadetViewFor(cadetId) }
  async markPublished(eventIds: string[], transactionId: string) { await this.ready().markPublished(eventIds, transactionId); return this.project() }
  /** Re-reads the delivery of these records (or every unverified one) from the sync provider: queued, publishing, on chain, mined, rolled back. */
  async refreshDelivery(eventIds?: string[]) { await this.ready().refreshDelivery(eventIds); return this.project() }
  async rebuild() { await this.ready().rebuildNow(); return this.project() }
  async sync() { await this.ready().sync(); return this.project() }
  /** Polling bridge for React: folds anything the chain transport has delivered since the last poll. */
  startAutoSync(onProjection: (projection: ArgusAppProjection) => void, intervalMs = 5_000) {
    let stopped = false, running = false
    const run = async () => { if (stopped || running) return; running = true; try { const projection = await this.sync(); if (!stopped) onProjection(projection) } catch { /* the durable outbox remains retryable */ } finally { running = false } }
    const timer = setInterval(() => { void run() }, intervalMs), online = () => { void run() }
    globalThis.addEventListener?.('online', online); void run()
    return () => { stopped = true; clearInterval(timer); globalThis.removeEventListener?.('online', online) }
  }
  private ready() { if (!this.replica) throw new Error('Distributed application repository is not initialized.'); return this.replica }
  async project(): Promise<ArgusAppProjection> {
    const state = await this.repository.snapshot(), actor = await this.identity.getPublicIdentity()
    const openNeeds = state.stillNeeded.filter(item => ['OPEN', 'PARTIALLY_FULFILLED'].includes(item.status))
    const outbox = state.events.filter(record => record.syncStatus === 'QUEUED' || record.syncStatus === 'SYNCING' || record.syncStatus === 'FAILED').length
    return {
      actor,
      inventory: state.inventory, catalog: state.catalog, countSessions: state.countSessions,
      cadets: state.cadets.map(cadet => { const needs = state.stillNeeded.filter(item => item.cadetId === cadet.cadetId); return { ...cadet, propertyCount: cadet.currentProperty.reduce((sum, item) => sum + item.quantity, 0), stillNeededCount: openNeeds.filter(item => item.cadetId === cadet.cadetId).length, readiness: cadetReadiness(needs) } }),
      bundles: state.bundles.map(bundle => ({ ...bundle, mapping: bundleMapping(bundle, state.inventory) })),
      stillNeeded: openNeeds.map(requirement => ({ ...requirement, availability: requirementAvailability(requirement, state.inventory) })),
      transactions: state.transactions, conflicts: state.conflicts, members: state.members, keyEpochs: state.keyEpochs, tickets: state.tickets, notices: noticesNewestFirst(state.notices), ...(state.recoveryKey ? { recoveryKey: state.recoveryKey } : {}), calendar: state.calendar, corrections: state.corrections, rollovers: state.rollovers, rejected: state.rejected, events: withConflictStatus(state.events, conflictLosers(state)), audit: auditFrom(state),
      sync: { mode: this.syncMode, outbox, openConflicts: state.conflicts.filter(conflict => conflict.status === 'OPEN').length },
      integrity: inspectRepository(state),
    }
  }
  async technicalState() { return this.repository.snapshot() }
}

/** Newest first; a tie is broken by notice ID, so every device lists them alike. */
const noticesNewestFirst = (notices: NoticeProjection[]) => [...notices].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.noticeId.localeCompare(a.noticeId))
export type BundleMapping = { status: 'FULLY_MAPPED'|'PARTIALLY_MAPPED'|'UNMAPPED'; mapped: number; total: number }
/** A bundle line is ready to issue when its exact SKU exists, or its catalog item has at least one active size. */
export const bundleMapping = (bundle: BundleProjection, inventory: InventoryProjection[]): BundleMapping => { const current = bundle.versions.find(version => version.version === bundle.currentVersion); const mapped = current?.lines.filter(line => (line.itemId && inventory.some(item => item.entityId === line.itemId)) || (line.catalogId && inventory.some(item => item.catalogId === line.catalogId && item.active))).length ?? 0; const total = current?.lines.length ?? 0; return { status: mapped === total && total > 0 ? 'FULLY_MAPPED' : mapped ? 'PARTIALLY_MAPPED' : 'UNMAPPED', mapped, total } }
export type ArgusAppProjection = { actor: string; inventory: InventoryProjection[]; catalog: CatalogItemProjection[]; countSessions: CountSessionProjection[]; cadets: Array<CadetProjection & { propertyCount: number; stillNeededCount: number; readiness: ReturnType<typeof cadetReadiness> }>; bundles: Array<BundleProjection & { mapping: BundleMapping }>; stillNeeded: Array<StillNeededProjection & { availability: ReturnType<typeof requirementAvailability> }>; transactions: SupplyTransaction[]; conflicts: ConflictRecord[]; members: MemberProjection[]; keyEpochs: KeyEpochProjection[]; /** Admission tickets as the unit's history shows them (use listTickets for status with days left). */ tickets: TicketProjection[]; recoveryKey?: RecoveryKeyProjection; /** Notices staff sent, newest first (ADR 013). */ notices: NoticeProjection[]; calendar: CalendarEventProjection[]; corrections: PropertyCorrection[]; rollovers: RolloverRecord[]; rejected: RejectedEventRecord[]; events: StoredEvent[]; audit: AuditEvent[]; sync: { mode: 'local'|'remote'; outbox: number; openConflicts: number }; integrity: IntegrityReport }
