import type { ChainApi } from '../chain/types'
import { MAX_RECORDS_PER_TX } from '../chain/codec'
import type { DeviceWallet } from '../chain/wallet'
import type { CadetView, SignedArgusEvent } from '../distributed/types'
import { readChannelRecords, type ChannelRecordRead } from './channelReader'
import { importChannelKey, serializeChannelEnvelope, sealToChannel } from './envelope'
import { MAX_BATCH_BYTES } from './transport'
import type { CadetDevice } from './vault'

/** Where a cadet's channel is: its key and the address its records are paid to (ADR 013). */
export type CadetChannelRef = { key: string; address: string }
/** What a drain reports: how many cadets it set out to publish for, how many went out, how many did not (they stay queued, bar a refusal). */
export type CadetPublishProgress = { done: number; total: number; failed: number }
/** What a notice's sealed record holds (ADR 013, mw-kmgi38.5): the cadet's phone shows the text, who sent it and when. */
export type NoticeRecord = { noticeId: string; text: string; sentAt: string; from: string }
/** Where a notice goes (one channel per cadet it is for: every cadet with a channel for a notice to all) and what it says, as the unit log has it; none when the notice is gone. */
export type NoticeToPublish = { channels: CadetChannelRef[]; record: NoticeRecord }
/** One sealed record on its way to a channel, and how its transaction ended (an error when it did not go out). */
type Outgoing = { channel: CadetChannelRef; kind: 'view' | 'notice'; plaintext: unknown; correlation: string; name: string }
type Outcome = { item: Outgoing; txid?: string; error?: Error }
export type CadetPublisherDeps = {
  /** The cadet's channel as the unit log has it, or none (a cadet with no channel has nowhere to be published). */
  channelFor: (cadetId: string) => Promise<CadetChannelRef | undefined>
  viewFor: (cadetId: string) => Promise<CadetView>
  /** A notice staff sent, read from the unit log when it is published (so the queue holds IDs, never text). Without it no notice is published. */
  noticeFor?: (noticeId: string) => Promise<NoticeToPublish | undefined>
  /** Which cadets' records an event changes (none: an empty list). Only used by noteEvent. */
  cadetIdsFor?: (event: SignedArgusEvent) => Promise<string[]>
  wallet: Pick<DeviceWallet, 'prepareRecords' | 'flush' | 'pending' | 'ownTxHex'>
  /** Holds the queue, so a reload or an offline spell resumes where it stopped. */
  storage: Pick<Storage, 'getItem' | 'setItem'>
  storageKey: string
  /** Events for one cadet closer together than this fold into one publish. */
  debounceMs?: number
  /** A drain that left cadets queued runs again after this long. */
  retryMs?: number
}
/** A cadet's record that can never be published as it is (over the cap): refused, not retried. */
export class CadetRecordTooLargeError extends Error {
  constructor(readonly cadetName: string) { super(`The record for ${cadetName} is too large to publish (over 60 KB).`) }
}
export const CADET_PUBLISH_DEBOUNCE_MS = 2_000
export const CADET_PUBLISH_RETRY_MS = 30_000

/**
 * Keeps each cadet's channel up to date (ADR 013, mw-kmgi38.3): when this device commits a change that touches a cadet who has a
 * channel, the cadet's CadetView is sealed to that channel and paid there, from this device's wallet. Several changes within the
 * debounce make one record. A drain puts up to 25 records (MAX_RECORDS_PER_TX, and no more than 90 KB) in one transaction, each
 * cadet's address paid by an anchor output in it, so 250 records cost 10 transactions; one record alone is one transaction. A notice
 * to all cadets is one sealed record per cadet in that cadet's own channel (mw-kmgi38.15). The queues are kept in storage; a record
 * the network did not take stays queued and goes out again, and a transaction the wallet already built is finished, never built twice.
 */
export class CadetPublisher {
  private queue: string[]
  /** Notices waiting to be sealed to their audience's channel, by notice ID (ADR 013, mw-kmgi38.5). */
  private noticeQueue: string[]
  private readonly noticeErrors: Record<string, string> = {}
  /** The channel addresses a queued notice has already gone out to, by notice ID, so a retry sends only what is left. */
  private noticeDelivered: Record<string, string[]>
  /** Bumped on every note, so a change that arrives while a record is being published keeps its cadet queued. */
  private readonly generation = new Map<string, number>()
  private readonly errors: Record<string, string> = {}
  private readonly noting = new Set<Promise<unknown>>()
  private timer?: ReturnType<typeof setTimeout>
  private tail: Promise<unknown> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: CadetPublisherDeps) { this.queue = this.load(this.deps.storageKey); this.noticeQueue = this.load(this.noticeStorageKey); this.noticeDelivered = this.loadDelivered() }
  private get noticeStorageKey() { return `${this.deps.storageKey}.notices` }
  private get deliveredStorageKey() { return `${this.noticeStorageKey}.delivered` }

  private get debounceMs() { return this.deps.debounceMs ?? CADET_PUBLISH_DEBOUNCE_MS }
  private load(key: string): string[] {
    try { const parsed: unknown = JSON.parse(this.deps.storage.getItem(key) ?? '[]'); return Array.isArray(parsed) ? [...new Set(parsed.filter((id): id is string => typeof id === 'string'))] : [] } catch { return [] }
  }
  private loadDelivered(): Record<string, string[]> {
    try {
      const parsed: unknown = JSON.parse(this.deps.storage.getItem(this.deliveredStorageKey) ?? '{}')
      return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).map(([id, addresses]) => [id, Array.isArray(addresses) ? addresses.filter((address): address is string => typeof address === 'string') : []])) : {}
    } catch { return {} }
  }
  private saveDelivered() { this.deps.storage.setItem(this.deliveredStorageKey, JSON.stringify(this.noticeDelivered)) }
  private save() { this.deps.storage.setItem(this.deps.storageKey, JSON.stringify(this.queue)) }
  private saveNotices() { this.deps.storage.setItem(this.noticeStorageKey, JSON.stringify(this.noticeQueue)) }
  private schedule(ms: number) {
    if (this.stopped) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = undefined; this.run().catch(() => undefined) }, ms)
  }
  private add(cadetId: string) {
    this.generation.set(cadetId, (this.generation.get(cadetId) ?? 0) + 1)
    if (!this.queue.includes(cadetId)) { this.queue.push(cadetId); this.save() }
  }

  /** The cadets waiting for a record, oldest first. */
  queued() { return [...this.queue] }
  /** The notices waiting to go out, oldest first (IDs only). */
  queuedNotices() { return [...this.noticeQueue] }
  /** Why a notice's last attempt did not go out, by notice ID (cleared by a success). */
  noticeErrorsById() { return { ...this.noticeErrors } }
  /** Queues a notice for a drain (run). Its text stays in the unit log, not in this queue. */
  enqueueNotice(noticeId: string) { if (!this.noticeQueue.includes(noticeId)) { this.noticeQueue.push(noticeId); this.saveNotices() } }
  /** Why each cadet's last attempt did not go out (cleared by a success). */
  lastErrors() { return { ...this.errors } }
  /** A change touched this cadet: queue them and (re)start the debounce. */
  note(cadetId: string) { this.stopped = false; this.add(cadetId); this.schedule(this.debounceMs) }
  /** A committed event of this device: queue every cadet it touches who has a channel. Never throws: a failure here must not fail the command. */
  noteEvent(event: SignedArgusEvent) {
    const work = (async () => {
      for (const cadetId of new Set(await this.deps.cadetIdsFor?.(event) ?? [])) if (await this.deps.channelFor(cadetId)) this.note(cadetId)
    })().catch(() => undefined).finally(() => { this.noting.delete(work) })
    this.noting.add(work)
  }
  /** Picks the queue up again (after a reload): starts the debounce when anything is waiting. */
  resume() { this.stopped = false; if (this.queue.length || this.noticeQueue.length) this.schedule(this.debounceMs) }
  /** Stops the timer; the queue stays in storage for the next time. */
  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = undefined }
  /** Resolves when every event noted so far has been queued and no drain is running. */
  async idle() { while (this.noting.size) await Promise.all([...this.noting]); await this.tail.catch(() => undefined) }

  /** Queues every one of these cadets for a drain without waiting for the debounce. */
  enqueue(cadetIds: string[]) { for (const id of cadetIds) this.add(id) }

  /**
   * Publishes for every queued cadet, one transaction at a time, and says how it went. Runs after any drain already going. A cadet
   * whose record the network did not take stays queued (and is tried again later); one whose record is over the cap is refused and dropped.
   */
  run(onProgress?: (progress: CadetPublishProgress) => void): Promise<CadetPublishProgress> {
    const next = this.tail.catch(() => undefined).then(() => this.drain(onProgress))
    this.tail = next
    return next
  }
  private async drain(onProgress?: (progress: CadetPublishProgress) => void): Promise<CadetPublishProgress> {
    clearTimeout(this.timer); this.timer = undefined
    const ids: string[] = []
    for (const id of [...this.queue]) { if (await this.deps.channelFor(id)) ids.push(id); else this.drop(id) }
    const progress: CadetPublishProgress = { done: 0, total: ids.length, failed: 0 }, started = new Map(ids.map(id => [id, this.generation.get(id)]))
    onProgress?.({ ...progress })
    const outgoing: Array<{ cadetId: string; item: Outgoing }> = []
    for (const cadetId of ids) {
      try { outgoing.push({ cadetId, item: await this.viewItem(cadetId) }) } catch (error) { this.failed(cadetId, error, progress); onProgress?.({ ...progress }) }
    }
    const cadetOf = new Map(outgoing.map(entry => [entry.item, entry.cadetId]))
    await this.publishMany(outgoing.map(entry => entry.item), outcomes => {
      for (const { item, error } of outcomes) {
        const cadetId = cadetOf.get(item)!
        if (error) { this.failed(cadetId, error, progress); continue }
        delete this.errors[cadetId]
        if (this.generation.get(cadetId) === started.get(cadetId)) this.drop(cadetId)
        progress.done++
      }
      onProgress?.({ ...progress })
    })
    await this.drainNotices()
    // Changes noted while this drain ran, or records the network did not take: again, after the debounce or a longer wait.
    if (this.queue.some(id => !started.has(id) || this.generation.get(id) !== started.get(id))) this.schedule(this.debounceMs)
    else if (this.queue.length || this.noticeQueue.length) this.schedule(this.deps.retryMs ?? CADET_PUBLISH_RETRY_MS)
    return progress
  }
  private failed(cadetId: string, error: unknown, progress: CadetPublishProgress) {
    progress.failed++
    this.errors[cadetId] = error instanceof Error ? error.message : 'The record could not be published.'
    if (error instanceof CadetRecordTooLargeError) this.drop(cadetId)
  }
  /**
   * One notice at a time, after the cadets' records, its records to every channel it is for in transactions of up to 25. A notice the
   * network did not take everywhere stays queued and goes out again to the channels it has not reached; one that cannot be sealed or
   * whose notice is gone is dropped.
   */
  private async drainNotices() {
    for (const noticeId of [...this.noticeQueue]) {
      try {
        const notice = await this.deps.noticeFor?.(noticeId)
        if (!notice) { this.dropNotice(noticeId); continue }
        const reached = new Set(this.noticeDelivered[noticeId] ?? []), left = notice.channels.filter(channel => !reached.has(channel.address))
        const items = left.map<Outgoing>(channel => ({ channel, kind: 'notice', plaintext: notice.record, correlation: `notice:${noticeId}:${channel.address}`, name: 'this notice' }))
        let failure: Error | undefined
        await this.publishMany(items, outcomes => {
          for (const { item, error } of outcomes) { if (error) failure ??= error; else reached.add(item.channel.address) }
          this.noticeDelivered[noticeId] = [...reached]; this.saveDelivered()
        })
        if (failure) throw failure
        delete this.noticeErrors[noticeId]; this.dropNotice(noticeId)
      } catch (error) {
        this.noticeErrors[noticeId] = error instanceof Error ? error.message : 'The notice could not be published.'
        if (error instanceof CadetRecordTooLargeError) this.dropNotice(noticeId)
      }
    }
  }
  private dropNotice(noticeId: string) {
    const before = this.noticeQueue.length; this.noticeQueue = this.noticeQueue.filter(id => id !== noticeId)
    if (this.noticeQueue.length !== before) this.saveNotices()
    if (noticeId in this.noticeDelivered) { delete this.noticeDelivered[noticeId]; this.saveDelivered() }
  }
  private drop(cadetId: string) { const before = this.queue.length; this.queue = this.queue.filter(id => id !== cadetId); if (this.queue.length !== before) this.save() }

  /**
   * Seals this cadet's current record to their channel and has it accepted by the network, in one transaction. Throws when the record is
   * too large (naming the cadet), the wallet cannot pay, or the network does not take it yet (a transaction the wallet built is kept and
   * finished by the next call, never duplicated).
   */
  async publishNow(cadetId: string): Promise<{ txid: string; version: number }> {
    const item = await this.viewItem(cadetId), [outcome] = await this.publishMany([item])
    if (outcome.error) throw outcome.error
    return { txid: outcome.txid!, version: (item.plaintext as CadetView).version }
  }
  /** The cadet's current record as a record to send; throws when the cadet has no channel. */
  private async viewItem(cadetId: string): Promise<Outgoing> {
    const channel = await this.deps.channelFor(cadetId)
    if (!channel) throw new Error('This cadet has no channel yet.')
    const view = await this.deps.viewFor(cadetId)
    return { channel, kind: 'view', plaintext: view, correlation: `cadet-record:${cadetId}:${view.version}`, name: view.fullName.trim() || view.cadetCode }
  }

  /**
   * Seals each record to its channel and has the network accept them, up to 25 records (and 90 KB) to a transaction of this device's
   * wallet, each channel's address paid by an anchor output of that transaction. Reports each batch to `onBatch` as it settles, and
   * returns every record's outcome: an error when the record is too large (naming the cadet), the wallet cannot pay, or the network
   * did not take its transaction yet. A transaction the wallet already built under a record's correlation (an answer that never came)
   * is finished, never built twice.
   */
  private async publishMany(items: Outgoing[], onBatch?: (outcomes: Outcome[]) => void): Promise<Outcome[]> {
    const { wallet } = this.deps, all: Outcome[] = [], sealed: Array<{ item: Outgoing; payload: Uint8Array }> = []
    const settle = (outcomes: Outcome[]) => { all.push(...outcomes); onBatch?.(outcomes) }
    for (const item of items) {
      try { sealed.push({ item, payload: serializeChannelEnvelope(await sealToChannel({ channelId: item.channel.address, key: await importChannelKey(item.channel.key), kind: item.kind, plaintext: item.plaintext })) }) } catch (error) {
        settle([{ item, error: error instanceof Error && error.message.includes('too large') ? new CadetRecordTooLargeError(item.name) : error instanceof Error ? error : new Error('The record could not be sealed.') }])
      }
    }
    // The wallet already built these very records (an answer that never came): finish those transactions; build the rest.
    const pending = await wallet.pending(), built = new Map<string, typeof sealed>(), toBuild: typeof sealed = []
    for (const entry of sealed) {
      const txid = pending.find(tx => tx.correlationIds.includes(entry.item.correlation))?.txid
      if (txid) built.set(txid, [...(built.get(txid) ?? []), entry]); else toBuild.push(entry)
    }
    const batches: Array<typeof sealed> = []
    for (let from = 0; from < toBuild.length;) {
      const batch: typeof sealed = []; let bytes = 0
      for (const entry of toBuild.slice(from)) { if (batch.length && (batch.length >= MAX_RECORDS_PER_TX || bytes + entry.payload.length > MAX_BATCH_BYTES)) break; batch.push(entry); bytes += entry.payload.length }
      batches.push(batch); from += batch.length
    }
    const refused = new Map<string, string>()
    const finish = async (txid: string, entries: typeof sealed) => {
      let error: Error | undefined
      try {
        for (const entry of (await wallet.flush()).rolledBack) refused.set(entry.txid, entry.reason)
        if (refused.has(txid)) error = new Error(`The network refused the record: ${refused.get(txid)}`)
        else if ((await wallet.pending()).some(tx => tx.txid === txid)) error = new Error('The network has not taken the record yet; it will be tried again.')
        else if (!(await wallet.ownTxHex(txid))) error = new Error('The record was not accepted by the network.')
      } catch (caught) { error = caught instanceof Error ? caught : new Error('The record could not be published.') }
      settle(entries.map(({ item }) => error ? { item, error } : { item, txid }))
    }
    for (const [txid, entries] of built) await finish(txid, entries)
    for (const batch of batches) {
      let txid: string
      try {
        const addresses = [...new Set(batch.map(({ item }) => item.channel.address))]
        txid = (await wallet.prepareRecords(batch.map(({ payload }) => ({ kind: 'C' as const, payload })), addresses[0], batch.map(({ item }) => item.correlation), addresses.slice(1))).txid
      } catch (error) { settle(batch.map(({ item }) => ({ item, error: error instanceof Error ? error : new Error('The record could not be published.') }))); continue }
      await finish(txid, batch)
    }
    return all
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
/** A CadetView as read back from a channel: shape-checked, since the channel is public and anyone holding the key could write to it. */
function parseCadetView(value: unknown): CadetView {
  if (!isRecord(value) || typeof value.cadetId !== 'string' || typeof value.cadetCode !== 'string' || typeof value.fullName !== 'string' || !isRecord(value.sizes) || !Array.isArray(value.have) || !Array.isArray(value.stillNeeded) || !Number.isSafeInteger(value.version) || typeof value.updatedAt !== 'string') throw new Error('Not a cadet record.')
  return value as unknown as CadetView
}

type OwnChannelDevice = { cadet?: Pick<CadetDevice, 'cadetId' | 'channelKey' | 'channelAddress'> }
/** What one read of a cadet's own channel finds: the newest record and the notices, newest first. */
export type CadetChannelRead = { view?: CadetView; notices: NoticeRecord[] }

/** The newest record in what a channel read returned: the highest version (of equal versions, the one the chain lists last). */
function newestView(records: ChannelRecordRead[], cadetId: string): CadetView | undefined {
  let best: CadetView | undefined
  for (const entry of records) {
    if (entry.kind !== 'view') continue
    let view: CadetView
    try { view = parseCadetView(entry.plaintext) } catch { continue }
    if (view.cadetId === cadetId && (!best || view.version >= best.version)) best = view
  }
  return best
}

/** A notice as read back from a channel: shape-checked, since anyone holding the key could write to it. */
function parseNotice(value: unknown): NoticeRecord {
  if (!isRecord(value) || typeof value.noticeId !== 'string' || typeof value.text !== 'string' || typeof value.sentAt !== 'string' || typeof value.from !== 'string') throw new Error('Not a notice.')
  return { noticeId: value.noticeId, text: value.text, sentAt: value.sentAt, from: value.from }
}

/** The notices in what a channel read returned, newest first, each notice ID once. */
function noticesIn(records: ChannelRecordRead[]): NoticeRecord[] {
  const found = new Map<string, NoticeRecord>()
  for (const entry of records) {
    if (entry.kind !== 'notice') continue
    try { const notice = parseNotice(entry.plaintext); if (!found.has(notice.noticeId)) found.set(notice.noticeId, notice) } catch { continue }
  }
  return [...found.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt) || a.noticeId.localeCompare(b.noticeId))
}

/**
 * The cadet's side (ADR 013, mw-kmgi38.15): ONE scan of this phone's own channel, the only address a cadet phone reads. Returns the
 * newest record and every notice in it (a notice to all cadets is sealed into each cadet's own channel, as a note to one cadet is).
 * Opens only what its own key opens. No record yet: no view.
 */
export async function readCadetChannel(device: OwnChannelDevice, api: ChainApi): Promise<CadetChannelRead> {
  const { cadet } = device
  if (!cadet) return { notices: [] }
  const records = await readChannelRecords(api, cadet.channelAddress, cadet.channelKey), view = newestView(records, cadet.cadetId)
  return { ...(view ? { view } : {}), notices: noticesIn(records) }
}

/** The newest record in this phone's own channel, the one with the highest version. No record yet: undefined. One scan of that one address. */
export async function readCadetRecord(device: OwnChannelDevice, api: ChainApi): Promise<CadetView | undefined> { return (await readCadetChannel(device, api)).view }

/** The notices in this phone's own channel, newest first, each notice ID once. One scan of that one address. */
export async function readCadetNotices(device: OwnChannelDevice, api: ChainApi): Promise<NoticeRecord[]> { return (await readCadetChannel(device, api)).notices }
