import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { isVerified } from '../distributed/delivery'
import type { StoredEvent } from '../distributed/types'
import { verificationOf } from '../features/activity/activityModel'
import { readiness } from '../stage3/readiness'
import { MemoryLedgerStore, type StoredEnvelope } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { LOST_AFTER_MS, LOST_AFTER_SCANS } from './transport'
import { syncLabel, syncOutcome } from './screens/labels'
import { joinByTicket } from '../test/joinByTicket'
import { createMasterDevice, type UnlockedDevice } from './vault'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
const open = (device: UnlockedDevice, chain: FakeChain, ledger: MemoryLedgerStore = new MemoryLedgerStore()) => UnitRuntime.open(device, { api: chain, ledger, walletStore: new MemoryWalletStateStore(), storage: storage() })
const master = () => createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, storage())
const receipt = async (runtime: UnitRuntime, eventId: string): Promise<StoredEvent> => (await runtime.controller.project()).events.find(record => record.event.eventId === eventId)!
const firstItem = async (runtime: UnitRuntime) => (await runtime.controller.project()).inventory[0].entityId
const onChain = (chain: FakeChain, txid?: string) => Boolean(txid && chain.transactions().some(tx => tx.txid === txid))

/** A ledger whose writes can be held or made to fail once, to reproduce interrupted hand-offs. */
class FlakyLedger extends MemoryLedgerStore {
  private gate?: Promise<void>
  private openGate?: () => void
  held = 0
  failNextRequeue = false
  readonly writes: Array<{ eventIds: string[]; change: Parameters<MemoryLedgerStore['updateEnvelopes']>[1]; failed?: boolean }> = []
  hold() { this.gate = new Promise(resolve => { this.openGate = resolve }) }
  release() { this.openGate?.(); this.gate = undefined }
  override async addEnvelope(value: StoredEnvelope) { if (this.gate) { this.held++; await this.gate } return super.addEnvelope(value) }
  override async updateEnvelopes(eventIds: string[], change: Parameters<MemoryLedgerStore['updateEnvelopes']>[1]) {
    if (this.failNextRequeue && change.status === 'QUEUED' && change.clearTxid) { this.failNextRequeue = false; this.writes.push({ eventIds, change, failed: true }); throw new Error('Disk write failed.') }
    this.writes.push({ eventIds, change })
    return super.updateEnvelopes(eventIds, change)
  }
}

async function unitWithOfficer(chain: FakeChain) {
  const masterDevice = await master()
  chain.fund(masterDevice.record.walletAddress, 200_000, { confirmed: true })
  const a = await open(masterDevice, chain)
  const { runtime: b } = await joinByTicket(a, chain, 'Officer B', 'SUPPLY_OFFICER')
  await a.syncNow(); chain.mine(); await b.syncNow()
  return { a, b, masterDevice }
}

afterEach(() => { vi.useRealTimers() })

describe('record sync status and verification over a (fake) BSV testnet chain', { timeout: 120_000 }, () => {
  it('a record that cannot be published stays QUEUED — also after a restart — and is never counted as verified', async () => {
    const chain = new FakeChain(), device = await master(), ledger = new MemoryLedgerStore()
    const unfunded = await open(device, chain, ledger)
    const received = await unfunded.controller.receiveStock(await firstItem(unfunded), 3)
    await unfunded.syncNow()
    expect(unfunded.status().needsFunding).toBeDefined()
    let projection = await unfunded.controller.project()
    expect(projection.events.map(record => record.syncStatus)).toEqual(['QUEUED', 'QUEUED'])
    expect(verificationOf(projection.events[0], projection.sync.mode).label).toBe('not yet on chain')
    expect(readiness(projection).audit).toBe(0)

    // Offline: the change is kept and waits.
    unfunded.controller.setOnline(false)
    projection = await unfunded.controller.receiveStock(await firstItem(unfunded), 1)
    expect(projection.events.filter(record => record.syncStatus === 'QUEUED')).toHaveLength(3)
    unfunded.controller.setOnline(true)
    await unfunded.syncNow()

    // Restart on the same device: everything still queued is QUEUED, not SYNCHRONIZED/VERIFIED.
    const restarted = await open(device, chain, ledger)
    projection = await restarted.controller.project()
    expect(projection.events).toHaveLength(3)
    expect(projection.events.every(record => record.syncStatus === 'QUEUED' && !record.transactionId && !isVerified(record))).toBe(true)
    expect(readiness(projection).audit).toBe(0)
    expect(projection.inventory[0].onHand).toBe((await unfunded.controller.project()).inventory[0].onHand)
    expect(received.events.some(record => record.syncStatus === 'SYNCHRONIZED')).toBe(false)
  })

  it('broadcast → SYNCHRONIZED (not yet verified); mined → VERIFIED in that block, on every device', async () => {
    const chain = new FakeChain(), { a, b } = await unitWithOfficer(chain)
    const receiptEvent = (await a.controller.receiveStock(await firstItem(a), 4)).events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    await a.syncNow()
    let record = await receipt(a, receiptEvent.eventId)
    expect(record).toMatchObject({ syncStatus: 'SYNCHRONIZED', auditStatus: 'BROADCAST' })
    expect(onChain(chain, record.transactionId)).toBe(true)
    expect(isVerified(record)).toBe(false)
    expect(verificationOf(record, 'remote').label).toBe('on chain · waiting for a block')
    const before = readiness(await a.controller.project()).audit
    expect(before).toBeLessThan(100)

    const height = chain.mine()
    await a.syncNow(); await b.syncNow()
    for (const runtime of [a, b]) {
      record = await receipt(runtime, receiptEvent.eventId)
      expect(record).toMatchObject({ syncStatus: 'SYNCHRONIZED', auditStatus: 'CONFIRMED', blockHeight: height })
      expect(verificationOf(record, 'remote')).toEqual({ verified: true, label: `VERIFIED in block ${height}` })
    }
    expect(readiness(await a.controller.project()).audit).toBe(100)
  })

  it('a transaction the network refused and the wallet rolled back shows FAILED, then publishes on retry', async () => {
    const chain = new FakeChain(), { a } = await unitWithOfficer(chain)
    chain.failNextBroadcasts('rejected', 50)
    const receiptEvent = (await a.controller.receiveStock(await firstItem(a), 2)).events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    await a.syncNow()
    let record = await receipt(a, receiptEvent.eventId)
    expect(record.syncStatus).toBe('FAILED')
    expect(record.lastError).toMatch(/injected rejected/)
    expect(record.transactionId).toBeUndefined()
    expect(verificationOf(record, 'remote').label).toBe('not yet on chain')

    chain.clearInjectedFailures()
    await a.syncNow()
    record = await receipt(a, receiptEvent.eventId)
    expect(record.syncStatus).toBe('SYNCHRONIZED')
    expect(record.lastError).toBeUndefined()
    expect(onChain(chain, record.transactionId)).toBe(true)
  })
})

describe('records are never lost between the app, the ledger and the chain', { timeout: 120_000 }, () => {
  it('republishes a record whose broadcast the network "accepted" but that never appeared on chain', async () => {
    const chain = new FakeChain(), { a, b, masterDevice } = await unitWithOfficer(chain)
    const item = await firstItem(a)
    chain.failNextBroadcasts('accepted', 1) // reported accepted, silently dropped
    const receiptEvent = (await a.controller.receiveStock(item, 5)).events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    await a.syncNow()
    const lost = await receipt(a, receiptEvent.eventId)
    expect(lost.syncStatus).toBe('SYNCHRONIZED') // the network said so...
    expect(onChain(chain, lost.transactionId)).toBe(false) // ...but it is not there

    // Missing from the anchor history scan after scan: after enough scans and time it is queued again.
    vi.useFakeTimers({ toFake: ['Date'] })
    for (let scan = 1; scan < LOST_AFTER_SCANS; scan++) await a.syncNow()
    expect((await receipt(a, receiptEvent.eventId)).transactionId).toBe(lost.transactionId) // not yet: indexers can lag
    vi.setSystemTime(Date.now() + LOST_AFTER_MS + 1_000)
    await a.syncNow()
    expect((await receipt(a, receiptEvent.eventId)).transactionId).not.toBe(lost.transactionId)
    vi.useRealTimers()

    // The lost transaction's change never existed; with coins the record reaches the chain for real.
    chain.fund(masterDevice.record.walletAddress, 50_000, { confirmed: true })
    await a.syncNow(); await a.syncNow()
    const republished = await receipt(a, receiptEvent.eventId)
    expect(republished.syncStatus).toBe('SYNCHRONIZED')
    expect(onChain(chain, republished.transactionId)).toBe(true)
    await b.syncNow()
    expect((await b.controller.project()).inventory.find(entry => entry.entityId === item)?.onHand).toBe((await a.controller.project()).inventory.find(entry => entry.entityId === item)?.onHand)
    expect((await b.controller.project()).events.some(record => record.event.eventId === receiptEvent.eventId)).toBe(true)
  })

  it('re-queues a record left PUBLISHING when recording a rollback failed, and publishes it', async () => {
    const chain = new FakeChain(), device = await master(), ledger = new FlakyLedger()
    chain.fund(device.record.walletAddress, 100_000, { confirmed: true })
    const a = await open(device, chain, ledger)
    await a.syncNow()
    chain.failNextBroadcasts('rejected', 1)
    ledger.failNextRequeue = true
    const receiptEvent = (await a.controller.receiveStock(await firstItem(a), 2)).events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    await a.syncNow(); await a.syncNow()
    const mine = ledger.writes.filter(write => write.eventIds.includes(receiptEvent.eventId))
    // The wallet rolled the refused transaction back, but recording that failed: the envelope was left PUBLISHING with no pending transaction...
    expect(mine.some(write => write.failed)).toBe(true)
    // ...and the next pass found it and queued it again instead of leaving it stuck.
    expect(mine.some(write => write.change.status === 'QUEUED' && /withdrawn/.test(write.change.lastError ?? ''))).toBe(true)
    const envelope = await ledger.envelope(receiptEvent.eventId)
    expect(envelope?.status).toBe('CONFIRMED')
    expect(onChain(chain, envelope?.txid)).toBe(true)
    expect(await a.wallet.pending()).toEqual([])
    expect((await receipt(a, receiptEvent.eventId)).syncStatus).toBe('SYNCHRONIZED')
  })

  it('a change made while a sync is already running still reaches the durable ledger (and survives a restart)', async () => {
    const chain = new FakeChain(), device = await master(), ledger = new FlakyLedger()
    const a = await open(device, chain, ledger)
    const item = await firstItem(a), start = (await a.controller.project()).inventory[0].onHand
    ledger.hold()
    const first = a.controller.receiveStock(item, 1)
    await vi.waitFor(() => expect(ledger.held).toBe(1))
    const second = a.controller.receiveStock(item, 2)
    await vi.waitFor(async () => expect((await a.controller.project()).inventory[0].onHand).toBe(start + 3))
    ledger.release()
    const ids = (await Promise.all([first, second])).map(projection => projection.events.filter(record => record.event.eventType === 'INVENTORY_RECEIVED').map(record => record.event.eventId))
    for (const eventId of new Set(ids.flat())) expect(await ledger.envelope(eventId)).toBeDefined()

    const restarted = await open(device, chain, ledger)
    expect((await restarted.controller.project()).inventory.find(entry => entry.entityId === item)?.onHand).toBe(start + 3)
  })
})

/** WhatsOnChain unreachable (as in the browser when it is offline or rate-limits without a CORS header). */
class UnreachableChain extends FakeChain {
  down = false
  private check() { if (this.down) throw new Error('Could not reach WhatsOnChain after 3 tries (offline, timed out, or rate-limited; its 429 reply carries no CORS header).') }
  override async unspent(...args: Parameters<FakeChain['unspent']>) { this.check(); return super.unspent(...args) }
  override async txHex(...args: Parameters<FakeChain['txHex']>) { this.check(); return super.txHex(...args) }
  override async confirmedHistory(...args: Parameters<FakeChain['confirmedHistory']>) { this.check(); return super.confirmedHistory(...args) }
  override async unconfirmedHistory(...args: Parameters<FakeChain['unconfirmedHistory']>) { this.check(); return super.unconfirmedHistory(...args) }
  override async broadcast(...args: Parameters<FakeChain['broadcast']>) { this.check(); return super.broadcast(...args) }
  override async tipHeight() { this.check(); return super.tipHeight() }
}

describe('while BSV testnet is unreachable (M3, M4)', { timeout: 120_000 }, () => {
  it('counts the changes waiting to publish from the local ledger, and Sync now reports the failure', async () => {
    const chain = new UnreachableChain(), device = await master()
    chain.fund(device.record.walletAddress, 100_000, { confirmed: true })
    const a = await open(device, chain)
    await a.syncNow(); await a.syncNow()
    expect(a.status()).toMatchObject({ state: 'synced', queued: 0 })
    expect(syncOutcome(a.status())).toEqual({ ok: true, message: 'Synchronized with BSV testnet.' })

    chain.down = true
    const item = await firstItem(a)
    await a.controller.receiveStock(item, 2)
    await a.controller.receiveStock(item, 3)
    await a.syncNow()
    const status = a.status()
    // The failed pass still recounted what is waiting (it used to keep showing the last good count, 0).
    expect(status).toMatchObject({ state: 'error', queued: 2 })
    expect(syncLabel(status)).toBe('SYNC ISSUE · 2 QUEUED')
    expect((await a.controller.project()).sync.outbox).toBe(2)
    const outcome = syncOutcome(status)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toBe('Could not sync with BSV testnet. The BSV testnet service could not be reached (no connection, or it is busy). 2 changes are saved on this device and will publish automatically.')
    expect(outcome.message).not.toMatch(/CORS|429|WhatsOnChain/)
    // The technical detail is kept for the diagnostics line.
    expect(status.lastError).toMatch(/CORS/)

    chain.down = false
    await a.syncNow(); await a.syncNow()
    expect(a.status()).toMatchObject({ state: 'synced', queued: 0 })
  })
})
