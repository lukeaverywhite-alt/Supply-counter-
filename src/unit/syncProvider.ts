import { isTicketCredential, ticketCredential, type AuthorizationService } from '../auth/authorization'
import type { EventDelivery } from '../distributed/delivery'
import type { AuthorityCredential, AuthorityRevocation, SignedArgusEvent } from '../distributed/types'
import { parseTicketRedeemedFact } from '../private-sync/schema'
import type { EventSyncProvider } from '../sync/mock'
import { openEnvelope, sealEnvelope } from './envelope'
import type { LedgerStore, StoredEnvelope } from './ledgerStore'

/**
 * Master spec §22 statuses from the ledger's envelope status:
 *   QUEUED               → QUEUED        (waiting for a wallet transaction: offline, or no testnet coins)
 *   QUEUED + lastError   → FAILED        (the network refused the transaction and the wallet rolled it back; it is retried)
 *   PUBLISHING           → SYNCING       (a transaction is built and being broadcast)
 *   BROADCAST            → SYNCHRONIZED  (the network accepted it)
 *   CONFIRMED, height 0  → SYNCHRONIZED  (seen on the unit's anchor history, in the mempool)
 *   CONFIRMED, height >0 → SYNCHRONIZED and mined: VERIFIED in that block
 */
export function envelopeDelivery(record: Pick<StoredEnvelope, 'status' | 'txid' | 'height' | 'lastError'>): EventDelivery {
  const onChain = record.txid ? { transactionId: record.txid } : {}
  if ((record.status === 'QUEUED' || record.status === 'PUBLISHING') && record.lastError) return { syncStatus: 'FAILED', auditStatus: 'FAILED', lastError: record.lastError }
  if (record.status === 'QUEUED') return { syncStatus: 'QUEUED', auditStatus: 'PENDING' }
  if (record.status === 'PUBLISHING') return { syncStatus: 'SYNCING', auditStatus: 'PENDING' }
  if (record.status === 'CONFIRMED' && (record.height ?? 0) > 0) return { syncStatus: 'SYNCHRONIZED', auditStatus: 'CONFIRMED', ...onChain, blockHeight: record.height }
  return { syncStatus: 'SYNCHRONIZED', auditStatus: 'BROADCAST', ...onChain }
}

export type UnitSyncProviderDependencies = {
  unitId: string
  store: LedgerStore
  currentEpoch: () => string
  keyFor: (epochId: string) => Promise<CryptoKey | undefined>
  /** This device's own current credential (it changes when a Master changes this person's role); it travels inside every envelope this device writes. */
  credential: () => AuthorityCredential
  authorization: AuthorizationService
  /** Called after a local event is durably queued so the chain transport can publish promptly. */
  onQueued?: () => void
  /** Called with each event this device itself committed, once it is durably queued (a record this device made, never one read from the chain). */
  onLocalEvent?: (event: SignedArgusEvent) => void
  /** Checks an opened record is genuine (author-bound event ID, author's signature). Forged copies are set aside, never folded. */
  validate?: (event: SignedArgusEvent) => Promise<boolean>
}

/**
 * Bridges the replica (plaintext, in memory) and the ledger store (ciphertext, on disk).
 *
 * publish(): encrypt the signed event together with the author's credential and store the
 *            envelope durably as QUEUED. Idempotent per event ID; the stored bytes never change,
 *            so a retried publication is byte-identical on chain.
 * pull():    decrypt envelopes that arrived from the chain (or were on disk at startup) and have
 *            not yet been handed to the replica. Before an event is returned, the credential it
 *            carries is verified against the unit authority, so every device can check every
 *            member's role without any directory server.
 */
export class UnitEventSyncProvider implements EventSyncProvider {
  private readonly delivered = new Set<string>()
  private readonly backlog = new Set<string>()
  private readonly acceptedCredentials = new Set<string>()
  private readonly acceptedRevocations = new Set<string>()
  /** Credentials whose issuer (a delegated Master) is not known yet; retried after every pull until their issuer's credential arrives. */
  private readonly pendingCredentials = new Map<string, AuthorityCredential>()
  /** Revocations can arrive before the credential they revoke (history is not delivered in causal order); they are retried the same way. */
  private readonly pendingRevocations = new Map<string, AuthorityRevocation>()
  /** Envelopes that could not be opened yet (no key for their epoch, damaged): retried on each pull. */
  readonly unreadable = new Map<string, string>()
  /** Records set aside as forged or tampered (by event ID). */
  readonly forged = new Map<string, string>()

  constructor(private readonly deps: UnitSyncProviderDependencies) {}

  /** Loads every stored envelope ID so the first pull rebuilds the whole projection from disk. */
  async prime() { for (const record of await this.deps.store.envelopes()) if (!this.delivered.has(record.eventId)) this.backlog.add(record.eventId) }
  enqueueRemote(eventIds: string[]) { for (const id of eventIds) if (!this.delivered.has(id)) this.backlog.add(id) }

  async publish(event: SignedArgusEvent) {
    if (this.delivered.has(event.eventId) || await this.deps.store.envelope(event.eventId)) { this.delivered.add(event.eventId); this.backlog.delete(event.eventId); return }
    const envelope = await this.seal(event)
    await this.deps.store.addEnvelope({ eventId: event.eventId, envelope, origin: 'local', status: 'QUEUED', addedAt: new Date().toISOString() })
    this.delivered.add(event.eventId); this.backlog.delete(event.eventId)
    this.deps.onQueued?.()
    this.deps.onLocalEvent?.(event)
  }
  /** Seals without storing: a record that can never be published (too large) is refused before it changes local state. */
  async preflight(event: SignedArgusEvent) { await this.seal(event) }
  requeue(eventIds: string[]) { for (const id of eventIds) { this.delivered.delete(id); this.backlog.add(id) } }
  private async seal(event: SignedArgusEvent) {
    // A new key generation is announced under the previous key: remaining members can read it, and only they can unwrap their copy.
    const epochId = event.eventType === 'UNIT_KEY_ROTATED' && typeof event.payload.previousEpoch === 'string' ? event.payload.previousEpoch : this.deps.currentEpoch(), key = await this.deps.keyFor(epochId)
    if (!key) throw new Error(`This device has no unit key for ${epochId}.`)
    return sealEnvelope({ unitId: this.deps.unitId, epochId, key, plaintext: { event, credential: this.deps.credential() } })
  }

  async pull(): Promise<SignedArgusEvent[]> {
    const events: SignedArgusEvent[] = []
    for (const eventId of [...this.backlog]) {
      const record = await this.deps.store.envelope(eventId)
      if (!record) { this.backlog.delete(eventId); continue }
      try {
        const opened = await this.openGenuine(record)
        if (!opened) { this.forged.set(eventId, 'Forged or tampered record set aside.'); this.delivered.add(eventId); this.backlog.delete(eventId); this.unreadable.delete(eventId); continue }
        const { event, credential, spends } = opened
        if (event.eventType === 'TICKET_REDEEMED') await this.acceptRedemption(event, spends)
        if (credential) await this.acceptCredential(credential)
        await this.acceptAuthorityPayload(event)
        events.push(event)
        this.delivered.add(eventId); this.backlog.delete(eventId); this.unreadable.delete(eventId)
      } catch (error) { this.unreadable.set(eventId, error instanceof Error ? error.message : 'Unreadable record.') }
    }
    await this.retryPendingCredentials()
    return events
  }

  /**
   * Opens the stored copy, or one of the other copies seen under the same event ID, and returns the first that is genuine
   * (promoting it). Returns undefined when every copy is openable but forged; throws while a copy still cannot be opened
   * (no key yet), so it is retried later.
   */
  private async openGenuine(record: StoredEnvelope) {
    const candidates = [{ envelope: record.envelope, txid: record.txid, height: record.height, spends: record.spends }, ...(record.alternates ?? [])]
    let waiting: unknown
    for (const [index, candidate] of candidates.entries()) {
      let opened
      try { opened = await openEnvelope(candidate.envelope, this.deps.keyFor) } catch (error) { if (error instanceof Error && error.message.startsWith('NO_EPOCH_KEY')) waiting ??= error; continue }
      if (this.deps.validate && !(await this.deps.validate(opened.event))) continue
      if (index > 0) await this.deps.store.replaceEnvelope({ ...record, envelope: candidate.envelope, ...(candidate.txid ? { txid: candidate.txid } : {}), ...(candidate.height !== undefined ? { height: candidate.height } : {}), spends: candidate.spends ?? [], alternates: candidates.filter((_, other) => other !== index && other > 0).map(entry => ({ envelope: entry.envelope, txid: entry.txid ?? '', height: entry.height ?? 0, ...(entry.spends ? { spends: entry.spends } : {}) })) })
      return { ...opened, spends: candidate.spends ?? [] }
    }
    if (waiting) throw waiting
    return undefined
  }

  /** Accepts a credential now if its issuer is known, otherwise keeps it until the issuer's own credential arrives. */
  async offerCredential(credential: AuthorityCredential) { await this.acceptCredential(credential); await this.retryPendingCredentials() }
  private async retryPendingCredentials() {
    for (let progress = true; progress && (this.pendingCredentials.size || this.pendingRevocations.size);) {
      progress = false
      for (const credential of [...this.pendingCredentials.values()]) { if (await this.tryAccept(credential)) { this.pendingCredentials.delete(credential.credentialId); progress = true } }
      for (const revocation of [...this.pendingRevocations.values()]) { if (await this.tryRevoke(revocation)) { this.pendingRevocations.delete(revocation.revocationId); progress = true } }
    }
  }
  private async tryRevoke(revocation: AuthorityRevocation) {
    try { await this.deps.authorization.acceptRevocation(revocation); this.acceptedRevocations.add(revocation.revocationId); return true } catch { return false }
  }

  /** The transaction each event arrived in (or was published in), so every device links every change to the chain. */
  async transactionIds(eventIds: string[]) {
    const found: Record<string, string> = {}
    for (const eventId of eventIds) { const txid = (await this.deps.store.envelope(eventId))?.txid; if (txid) found[eventId] = txid }
    return found
  }

  /** Each record's delivery, read from its envelope in the durable ledger (so it survives a restart unchanged). */
  async deliveryStatus(eventIds: string[]) {
    const wanted = new Set(eventIds), found: Record<string, EventDelivery> = {}
    for (const record of await this.deps.store.envelopes()) if (wanted.has(record.eventId)) found[record.eventId] = envelopeDelivery(record)
    return found
  }

  private async acceptCredential(credential: AuthorityCredential) {
    // A ticket credential is never taken on its word, wherever it travels: only a redemption carried by its ticket's spend proves it.
    if (isTicketCredential(credential) || this.acceptedCredentials.has(credential.credentialId)) return
    // An invalid or foreign credential is simply not accepted; the replica then rejects that author's events as unauthorized
    // (and re-folds them once a later credential makes them valid). Unknown issuers are retried; the list is bounded.
    if (!(await this.tryAccept(credential)) && this.pendingCredentials.size < 1_000) this.pendingCredentials.set(credential.credentialId, credential)
  }
  private async tryAccept(credential: AuthorityCredential) {
    try { await this.deps.authorization.acceptCredential(credential); this.acceptedCredentials.add(credential.credentialId); return true } catch { return false }
  }
  /**
   * Single use (ADR 012): a TICKET_REDEEMED record proves its ticket credential only when it arrived in the transaction that spends the
   * ticket's funding output, which the network allows once. Any other copy (a code holder writing a fact of their own) proves nothing;
   * it still goes to the fold, which refuses it in the open because its credential was never verified.
   */
  private async acceptRedemption(event: SignedArgusEvent, spends: string[]) {
    let credential
    try { credential = ticketCredential(parseTicketRedeemedFact(event.payload)) } catch { return }
    const { funding } = credential.ticket.invitation
    if (!spends.includes(`${funding.txid}:${funding.vout}`)) return
    if (!(await this.tryAccept(credential)) && this.pendingCredentials.size < 1_000) this.pendingCredentials.set(credential.credentialId, credential)
  }
  private async acceptAuthorityPayload(event: SignedArgusEvent) {
    if (event.eventType === 'AUTHORITY_GRANTED' && event.payload.credential) await this.acceptCredential(event.payload.credential as AuthorityCredential)
    if (event.eventType === 'ROLE_CHANGED' && event.payload.credential) await this.acceptCredential(event.payload.credential as AuthorityCredential)
    if ((event.eventType === 'AUTHORITY_REVOKED' || event.eventType === 'ROLE_CHANGED') && event.payload.revocation) {
      const revocation = event.payload.revocation as AuthorityRevocation
      if (this.acceptedRevocations.has(revocation.revocationId)) return
      // Unknown credential (not delivered yet) or bad signature: retried after each pull; a forged one simply never applies.
      if (!(await this.tryRevoke(revocation)) && this.pendingRevocations.size < 1_000) this.pendingRevocations.set(revocation.revocationId, revocation)
    }
  }
}
