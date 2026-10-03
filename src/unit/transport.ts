import { Transaction } from '@bsv/sdk'
import { unitAnchorAddress } from '../blockchain/anchor'
import { MAX_RECORDS_PER_TX, decodeArgusRecords } from '../chain/codec'
import type { ChainApi, WalletBalance } from '../chain/types'
import { InsufficientFundsError, type DeviceWallet } from '../chain/wallet'
import { canonicalize } from '../distributed/canonical'
import { deserializeEnvelope, serializeEnvelope, type UnitEnvelope } from './envelope'
import type { LedgerStore, StoredEnvelope } from './ledgerStore'

export type TransportState = 'starting' | 'synced' | 'syncing' | 'offline' | 'error'
export type TransportStatus = {
  state: TransportState
  anchorAddress: string
  /** Local events not yet accepted by the network. */
  queued: number
  /** Local events broadcast but not yet seen back on the anchor history. */
  awaitingConfirmation: number
  lastScanAt?: string
  lastPublishAt?: string
  lastError?: string
  needsFunding?: { address: string; spendable: number; needed: number }
  balance?: WalletBalance
  tipHeight?: number
}
export type ChainTransportDependencies = {
  unitId: string
  api: ChainApi
  wallet: DeviceWallet
  store: LedgerStore
  /** New envelopes from other devices were stored; decrypt and fold them. */
  onRemoteEnvelopes: (records: StoredEnvelope[]) => Promise<void>
  /** Our own events reached the network (txid known). */
  onPublished?: (eventIds: string[], txid: string) => Promise<void>
  /** Records changed state on their way to the chain without a new broadcast (rolled back, re-queued, still pending, seen on chain, mined): show it. */
  onDelivery?: (eventIds: string[]) => Promise<void>
  onStatus?: (status: TransportStatus) => void
  /**
   * Authenticates an envelope with the unit key before it is stored. Event IDs are public, so an
   * outsider could publish garbage reusing a real event ID; only envelopes that authenticate (or
   * that use a key epoch this device does not hold yet) are kept.
   */
  checkEnvelope?: (envelope: UnitEnvelope) => Promise<'valid' | 'invalid' | 'unknown'>
  now?: () => Date
}

/** Records in one transaction are capped both by count and by total size so a transaction stays small and cheap to relay. */
const MAX_BATCH_BYTES = 90 * 1024
const MAX_HISTORY_PAGES_PER_SCAN = 20
/**
 * A transaction the network accepted must appear on the anchor history. One still missing after
 * this many successful scans, spread over at least LOST_AFTER_MS (indexers lag a fresh
 * broadcast), was lost: its records are queued and published again. A duplicate is harmless —
 * every device keeps the first copy of an event ID — but a lost record would never reach anyone.
 */
export const LOST_AFTER_SCANS = 3
export const LOST_AFTER_MS = 60_000

/**
 * Moves the unit's encrypted history between this device and BSV TESTNET — no server involved.
 *
 * Publish: queued envelopes are batched into one transaction (data outputs + a 1-satoshi output
 * to the unit anchor address + change) built by THIS device's wallet. The wallet persists the
 * signed transaction before broadcasting and rebroadcasts the same bytes after an ambiguous
 * failure, so each envelope reaches the chain exactly once.
 *
 * Discover: every unit transaction pays the anchor address, so walking the anchor's confirmed and
 * mempool history (WhatsOnChain) finds every device's records. New envelopes are stored
 * (still encrypted) and handed to the runtime to decrypt, verify and fold.
 */
export class ChainTransport {
  readonly anchorAddress: string
  private timer?: ReturnType<typeof setInterval>
  private running?: Promise<void>
  private rerun = false
  private current: TransportStatus
  /** Bumped when a tick starts and when it settles, so an early count from an older pass never overwrites a newer one. */
  private pass = 0
  /** Broadcast transactions not yet seen on the anchor history: consecutive scans that missed them, and when the first miss was. */
  private readonly missing = new Map<string, { scans: number; since: number }>()
  private readonly online = () => this.poke()
  /** Phones pause timers in the background: catch up the moment the app is on screen again. */
  private readonly visible = () => { if (globalThis.document?.visibilityState !== 'hidden') void this.poke() }

  constructor(private readonly deps: ChainTransportDependencies) {
    this.anchorAddress = unitAnchorAddress(deps.unitId)
    this.current = { state: 'starting', anchorAddress: this.anchorAddress, queued: 0, awaitingConfirmation: 0 }
  }
  status() { return this.current }
  private now() { return (this.deps.now?.() ?? new Date()).toISOString() }
  private emit(change: Partial<TransportStatus>) { this.current = { ...this.current, ...change }; this.deps.onStatus?.(this.current) }

  start(intervalMs = 15_000) {
    if (this.timer) return
    this.timer = setInterval(() => this.poke(), intervalMs)
    globalThis.addEventListener?.('online', this.online)
    globalThis.document?.addEventListener('visibilitychange', this.visible)
    this.poke()
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; globalThis.removeEventListener?.('online', this.online); globalThis.document?.removeEventListener('visibilitychange', this.visible) }
  /** Runs one publish+scan cycle now (coalescing overlapping requests into one follow-up run). */
  poke(): Promise<void> {
    if (this.running) { this.rerun = true; return this.running }
    this.running = (async () => { try { do { this.rerun = false; await this.tick() } while (this.rerun) } finally { this.running = undefined } })()
    return this.running
  }

  /**
   * Waiting and awaiting-confirmation counts come from the local ledger, not the network, so they are
   * right even while the chain is unreachable (a failed tick must not leave the last good count showing).
   */
  private async deliveryCounts(): Promise<Pick<TransportStatus, 'queued' | 'awaitingConfirmation'> | undefined> {
    try {
      const records = await this.deps.store.envelopes()
      return { queued: records.filter(r => r.status === 'QUEUED' || r.status === 'PUBLISHING').length, awaitingConfirmation: records.filter(r => r.status === 'BROADCAST').length }
    } catch { return undefined }
  }

  /** One publish+scan cycle. Resolves with whether it reached the network; the status says why not. */
  async tick(): Promise<boolean> {
    const pass = ++this.pass
    this.emit({ state: this.current.state === 'starting' ? 'starting' : 'syncing' })
    // Show what is waiting right away (the network part can take a while), without delaying the publish itself.
    void this.deliveryCounts().then(counts => { if (counts && pass === this.pass) this.emit(counts) })
    try {
      await this.publishOnce()
      await this.scanOnce()
      this.pass++
      this.emit({ state: 'synced', lastError: undefined, ...(await this.deliveryCounts()), balance: await this.deps.wallet.balance() })
      return true
    } catch (error) {
      this.pass++
      const message = error instanceof Error ? error.message : 'The BSV testnet service could not be reached.'
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      this.emit({ state: offline ? 'offline' : 'error', lastError: message, ...(await this.deliveryCounts()) })
      return false
    }
  }

  /** Builds and broadcasts transactions for every queued envelope. */
  async publishOnce() {
    const { store, wallet } = this.deps
    const changed = new Set<string>()
    // Crash recovery: a transaction the wallet already built owns its envelopes even if we died before recording that.
    // Only envelopes still waiting are claimed; one already seen on chain (an ambiguous broadcast that did land) is never set back.
    const pendingTxs = await wallet.pending()
    if (pendingTxs.length) {
      const waiting = new Set((await store.envelopes()).filter(record => record.status === 'QUEUED' || record.status === 'PUBLISHING').map(record => record.eventId))
      for (const pending of pendingTxs) { const ids = pending.correlationIds.filter(id => waiting.has(id)); if (ids.length) await store.updateEnvelopes(ids, { status: 'PUBLISHING', txid: pending.txid }) }
    }
    await this.recoverOrphans(new Set(pendingTxs.map(pending => pending.txid)), changed)
    let queued = (await store.envelopes()).filter(record => record.origin === 'local' && record.status === 'QUEUED').sort((a, b) => a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : a.eventId < b.eventId ? -1 : 1)
    let needsFunding: TransportStatus['needsFunding']
    while (queued.length) {
      const batch: StoredEnvelope[] = []; let bytes = 0
      for (const record of queued) { const size = serializeEnvelope(record.envelope).length; if (batch.length && (batch.length >= MAX_RECORDS_PER_TX || bytes + size > MAX_BATCH_BYTES)) break; batch.push(record); bytes += size }
      try {
        const prepared = await wallet.prepareRecords(batch.map(record => ({ kind: 'E' as const, payload: serializeEnvelope(record.envelope) })), this.anchorAddress, batch.map(record => record.eventId))
        await store.updateEnvelopes(batch.map(record => record.eventId), { status: 'PUBLISHING', txid: prepared.txid, lastError: undefined })
      } catch (error) {
        if (error instanceof InsufficientFundsError) { needsFunding = { address: error.address, spendable: error.spendable, needed: error.needed }; break }
        throw error
      }
      queued = queued.slice(batch.length)
    }
    const flushed = await wallet.flush()
    const pendingByTxid = new Map((await wallet.pending()).map(entry => [entry.txid, entry.correlationIds]))
    for (const txid of flushed.broadcast) {
      const records = (await store.envelopes()).filter(record => record.txid === txid), eventIds = records.map(record => record.eventId)
      const notYetSeen = records.filter(record => record.status !== 'CONFIRMED').map(record => record.eventId)
      if (notYetSeen.length) await store.updateEnvelopes(notYetSeen, { status: 'BROADCAST', lastError: undefined })
      await this.deps.onPublished?.(eventIds, txid)
    }
    for (const rolledBack of flushed.rolledBack) { await store.updateEnvelopes(rolledBack.correlationIds, { status: 'QUEUED', clearTxid: true, lastError: rolledBack.reason }); for (const id of rolledBack.correlationIds) changed.add(id) }
    for (const txid of flushed.stillPending) { const ids = pendingByTxid.get(txid); if (ids) { await store.updateEnvelopes(ids, { status: 'PUBLISHING', txid }); for (const id of ids) changed.add(id) } }
    this.emit({ needsFunding, ...(flushed.broadcast.length ? { lastPublishAt: this.now() } : {}) })
    if (changed.size) await this.deps.onDelivery?.([...changed])
  }

  /**
   * A PUBLISHING envelope whose transaction the wallet no longer holds as pending (rolled back
   * while recording that failed, or broadcast behind the transport's back) would never be
   * published again. Settle each one from what is actually known about its transaction.
   */
  private async recoverOrphans(pendingTxids: Set<string>, changed: Set<string>) {
    const { store, wallet } = this.deps
    const orphans = new Map<string, string[]>()
    for (const record of await store.envelopes()) if (record.origin === 'local' && record.status === 'PUBLISHING' && record.txid && !pendingTxids.has(record.txid)) orphans.set(record.txid, [...(orphans.get(record.txid) ?? []), record.eventId])
    for (const [txid, eventIds] of orphans) {
      const seen = await store.seen(txid)
      if (seen) await store.updateEnvelopes(eventIds, { status: 'CONFIRMED', height: seen.height, lastError: undefined })
      else if (await wallet.ownTxHex(txid)) { await store.updateEnvelopes(eventIds, { status: 'BROADCAST', lastError: undefined }); await this.deps.onPublished?.(eventIds, txid) }
      else await store.updateEnvelopes(eventIds, { status: 'QUEUED', clearTxid: true, lastError: 'The transaction carrying this record was withdrawn before it reached the network; publishing it again.' })
      for (const id of eventIds) changed.add(id)
    }
  }

  /** Our broadcasts must show up on the anchor history: confirms the ones the scan saw, republishes one missing for too long (see LOST_AFTER_SCANS). */
  private async checkBroadcasts(changed: Set<string>) {
    const { store } = this.deps
    const byTxid = new Map<string, string[]>()
    for (const record of await store.envelopes()) if (record.origin === 'local' && record.status === 'BROADCAST' && record.txid) byTxid.set(record.txid, [...(byTxid.get(record.txid) ?? []), record.eventId])
    for (const txid of [...this.missing.keys()]) if (!byTxid.has(txid)) this.missing.delete(txid)
    const now = (this.deps.now?.() ?? new Date()).getTime()
    for (const [txid, eventIds] of byTxid) {
      const seen = await store.seen(txid)
      if (seen) { await store.updateEnvelopes(eventIds, { status: 'CONFIRMED', height: seen.height }); this.missing.delete(txid); for (const id of eventIds) changed.add(id); continue }
      const miss = this.missing.get(txid) ?? { scans: 0, since: now }
      miss.scans++
      if (miss.scans < LOST_AFTER_SCANS || now - miss.since < LOST_AFTER_MS) { this.missing.set(txid, miss); continue }
      await store.updateEnvelopes(eventIds, { status: 'QUEUED', clearTxid: true, lastError: `The network accepted transaction ${txid.slice(0, 12)}… but it never appeared on chain; publishing again.` })
      this.missing.delete(txid); for (const id of eventIds) changed.add(id)
      this.rerun = true // publish the re-queued records in this same pass
    }
  }

  /** Walks the anchor address history and stores any unit envelopes this device has not seen. */
  async scanOnce() {
    const { api, store, wallet, unitId } = this.deps
    const cursor = await store.cursor()
    const confirmed: Array<{ txid: string; height: number }> = []
    let token: string | undefined, pages = 0
    do {
      const page = await api.confirmedHistory(this.anchorAddress, { ...(cursor.confirmedHeight ? { fromHeight: cursor.confirmedHeight } : {}), ...(token ? { token } : {}) })
      confirmed.push(...page.items); token = page.nextToken; pages++
    } while (token && pages < MAX_HISTORY_PAGES_PER_SCAN)
    const mempool = (await api.unconfirmedHistory(this.anchorAddress)).filter(txid => !confirmed.some(item => item.txid === txid)).map(txid => ({ txid, height: 0 }))
    const discovered: StoredEnvelope[] = []
    const changed = new Set<string>()
    for (const item of [...confirmed, ...mempool]) {
      const seen = await store.seen(item.txid)
      if (seen && (seen.height === item.height || (seen.height > 0 && item.height === 0))) continue
      if (seen) { // first seen in the mempool, now mined: just record the height
        await store.updateEnvelopes(seen.eventIds, { status: 'CONFIRMED', height: item.height })
        await store.markSeen({ ...seen, height: item.height, scannedAt: this.now() })
        for (const id of seen.eventIds) changed.add(id)
        continue
      }
      const hex = await wallet.ownTxHex(item.txid) ?? await api.txHex(item.txid)
      const eventIds: string[] = []
      let records: ReturnType<typeof decodeArgusRecords> = [], spent: string[] | undefined
      try { records = decodeArgusRecords(hex) } catch { /* not a parseable transaction: remember it so it is not refetched */ }
      // The outputs this transaction spends travel with its envelopes: a ticket's redemption counts only from the spend of its funding.
      const spends = () => spent ??= (() => { try { return Transaction.fromHex(hex).inputs.map(input => `${input.sourceTXID}:${input.sourceOutputIndex}`) } catch { return [] } })()
      for (const record of records) {
        if (record.kind !== 'E') continue
        let envelope
        try { envelope = deserializeEnvelope(record.payload) } catch { continue } // anyone can pay the anchor; foreign or malformed data is ignored
        if (envelope.unit !== unitId) continue
        if (this.deps.checkEnvelope && await this.deps.checkEnvelope(envelope) === 'invalid') continue
        eventIds.push(envelope.eventId)
        const existing = await store.envelope(envelope.eventId)
        if (existing) {
          if (canonicalize(existing.envelope) === canonicalize(envelope)) { await store.updateEnvelopes([envelope.eventId], { status: 'CONFIRMED', txid: item.txid, height: item.height, lastError: undefined, spends: [...new Set([...(existing.spends ?? []), ...spends()])] }); changed.add(envelope.eventId) }
          // Same event ID, different bytes: a replay or forgery attempt. Checkable copies were already verified above; one this
          // device cannot open yet is kept beside the stored copy, and whichever proves genuine wins once the key arrives.
          else if (existing.origin === 'chain') await store.addAlternate(envelope.eventId, { envelope, txid: item.txid, height: item.height, spends: spends() })
          continue
        }
        const stored: StoredEnvelope = { eventId: envelope.eventId, envelope, origin: 'chain', status: 'CONFIRMED', txid: item.txid, height: item.height, spends: spends(), addedAt: this.now() }
        if (await store.addEnvelope(stored)) discovered.push(stored)
      }
      await store.markSeen({ txid: item.txid, height: item.height, eventIds, scannedAt: this.now() })
    }
    const highest = confirmed.reduce((max, item) => Math.max(max, item.height), cursor.confirmedHeight)
    await store.setCursor({ confirmedHeight: highest, lastScanAt: this.now() })
    await this.checkBroadcasts(changed)
    this.emit({ lastScanAt: this.now(), tipHeight: highest || this.current.tipHeight })
    if (changed.size) await this.deps.onDelivery?.([...changed])
    if (discovered.length) await this.deps.onRemoteEnvelopes(discovered)
  }
}
