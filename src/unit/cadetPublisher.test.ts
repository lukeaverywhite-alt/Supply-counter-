import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import type { CadetView } from '../distributed/types'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { GENESIS_CATALOG } from '../stage3/domain'
import { CadetPublisher, readCadetRecord } from './cadetPublisher'
import { readChannelRecords } from './channelReader'
import { importChannelKey, openFromChannel } from './envelope'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice, type CadetDevice, type UnlockedDevice } from './vault'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const DEBOUNCE = 2_000

afterEach(() => { vi.useRealTimers() })

type Stores = { ledger: MemoryLedgerStore; walletStore: MemoryWalletStateStore; storage: ReturnType<typeof memoryStorage> }
const stores = (): Stores => ({ ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
const open = (device: UnlockedDevice, chain: FakeChain, own: Stores = stores()) => UnitRuntime.open(device, { api: chain, ...own })

async function newUnit(chain: FakeChain, satoshis = 400_000) {
  const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
  chain.fund(device.record.walletAddress, satoshis, { confirmed: true })
  const own = stores(), master = await open(device, chain, own)
  await master.controller.addCatalogSizes(PT_SHORTS, ['M'])
  const shorts = (await master.controller.project()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
  await master.controller.receiveStock(shorts, 100, 'Shipment')
  return { device, own, master, shorts }
}
let counter = 0
/** A cadet and, unless told otherwise, a channel. Returns the cadet's phone: what a cadet's device holds. */
async function addCadet(master: UnitRuntime, fullName: string, channel = true) {
  counter++
  const cadetId = (await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName, cadetCode: `C-T${String(counter).padStart(3, '0')}` })).cadets.find(cadet => cadet.fullName === fullName)!.cadetId
  if (channel) await master.controller.createCadetChannel(cadetId)
  return cadetId
}
const phoneOf = async (runtime: UnitRuntime, cadetId: string): Promise<{ cadet: CadetDevice }> => {
  const state = await runtime.controller.technicalState(), channel = state.cadetChannels.find(entry => entry.cadetId === cadetId)!
  return { cadet: { cadetId, displayName: 'Phone', unit: { unitId: 'u', unitName: 'Bethel NJROTC' }, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: 'n'.repeat(64), noticesAddress: 'x', joinedAt: '2026-10-03T00:00:00.000Z' } }
}
const recordsAt = async (runtime: UnitRuntime, chain: FakeChain, cadetId: string) => { const phone = await phoneOf(runtime, cadetId); return readChannelRecords(chain, phone.cadet.channelAddress, phone.cadet.channelKey) }
const issueOne = (runtime: UnitRuntime, cadetId: string, itemId: string, transactionId: string) => runtime.controller.issueTransaction({ transactionId, cadetId, lines: [{ lineId: 'l', itemId, quantity: 1 }] })

describe('publishing cadet records (ADR 013, mw-kmgi38.3)', { timeout: 240_000 }, () => {
  it('an issue is sealed to the cadet’s channel in one transaction after the debounce, and the cadet\'s phone reads it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Avery Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 100)
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(200); await master.cadetPublisher.idle()
    const records = await recordsAt(master, chain, cadetId)
    expect(records).toHaveLength(1)
    expect(records[0].kind).toBe('view')
    const view = await readCadetRecord(await phoneOf(master, cadetId), chain)
    expect(view).toMatchObject({ cadetId, cadetCode: expect.stringMatching(/^C-T/), fullName: 'Avery Private', have: [expect.objectContaining({ label: 'PT Shorts', size: 'M', quantity: 1 })], stillNeeded: [] })
    expect(master.cadetPublisher.queued()).toEqual([])
    // One transaction paid the channel address, and it carries that one record.
    expect(await chain.unconfirmedHistory(records[0].envelope.ch)).toEqual([records[0].txid])
  })

  it('a batch of records for different cadets is one transaction that pays each cadet’s address, and each cadet’s address lists it', async () => {
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const [x, y] = [await addCadet(master, 'Quinn Private'), await addCadet(master, 'Reese Private')]
    const result = await master.publishAllCadetRecords()
    expect(result).toEqual({ done: 2, total: 2, failed: 0 })
    const [first, second] = [await recordsAt(master, chain, x), await recordsAt(master, chain, y)]
    expect(first).toHaveLength(1); expect(second).toHaveLength(1)
    expect(first[0].txid).toBe(second[0].txid) // one transaction for both
    expect(first[0].envelope.ch).not.toBe(second[0].envelope.ch)
  })

  it('a return one second later folds into the same publish: still one transaction, and the item is gone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Blake Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await vi.advanceTimersByTimeAsync(1_000)
    const propertyId = (await master.controller.technicalState()).cadets.find(cadet => cadet.cadetId === cadetId)!.currentProperty[0].propertyId
    await master.controller.returnTransaction({ transactionId: 'return-1', cadetId, lines: [{ lineId: 'r', propertyId, quantity: 1 }] })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(600); await master.cadetPublisher.idle()
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(1)
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ have: [] })
  })

  it('a cadet update and a still-needed change are published too, and an event for a cadet with no channel queues nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Casey Private'), bare = await addCadet(master, 'Drew Private', false)
    await issueOne(master, bare, shorts, 'issue-bare')
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([cadetId]) // only Casey, from making the channel (mw-kmgi38.12); Drew has none
    await master.controller.updateCadet(cadetId, { sizes: { 'PT Shorts': 'M' } })
    await master.controller.addStillNeeded({ requirementId: 'need-1', cadetId, displayLabel: 'Combination Cover', quantityNeeded: 2, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-10-01T00:00:00.000Z', source: 'MANUAL' })
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    await master.controller.updateStillNeeded('need-1', { quantityNeeded: 3 })
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100); await master.cadetPublisher.idle()
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(1)
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ sizes: { 'PT Shorts': 'M' }, stillNeeded: [{ label: 'Combination Cover', quantity: 3 }] })
  })

  it('two devices publishing for the same cadet leave two records, and the reader keeps the higher version even when it came first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master: a, shorts } = await newUnit(chain)
    const cadetId = await addCadet(a, 'Emery Private')
    await a.syncNow(); chain.mine()
    const { runtime: b } = await joinByTicket(a, chain, 'Assistant B', 'SUPPLY_ASSISTANT', { satoshis: 30_000 })
    await b.syncNow()
    await issueOne(a, cadetId, shorts, 'issue-a')
    await a.syncNow(); chain.mine(); await b.syncNow()
    // B issues a second item on top of A's change and publishes at once; A's own (older) record goes out after, from its older view.
    await issueOne(b, cadetId, shorts, 'issue-b')
    await b.cadetPublisher.run()
    expect(await recordsAt(a, chain, cadetId)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100); await a.cadetPublisher.idle()
    expect(await recordsAt(a, chain, cadetId)).toHaveLength(2)
    const versions = (await recordsAt(a, chain, cadetId)).map(entry => (entry.plaintext as CadetView).version)
    expect(versions[0]).toBeGreaterThan(versions[1])
    const view = await readCadetRecord(await phoneOf(a, cadetId), chain)
    expect(view?.version).toBe(versions[0])
    expect(view?.have.reduce((total, line) => total + line.quantity, 0)).toBe(2)
  })

  it('a reader finds nothing before the first record, and nothing on a device that is no cadet’s', async () => {
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Finley Private')
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toBeUndefined()
    expect(await readCadetRecord({}, chain)).toBeUndefined()
  })

  it('publishAllCadetRecords fills every channel (30 cadets, 3 without one), 25 records to a transaction, one transaction at a time, and each phone reads only its own', async () => {
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain, 2_000_000)
    const cadets: string[] = [], bare: string[] = [], names = new Map<string, string>()
    for (let index = 0; index < 30; index++) { const withChannel = index % 10 !== 9, id = await addCadet(master, `Cadet Number${index}`, withChannel); names.set(id, `Cadet Number${index}`); (withChannel ? cadets : bare).push(id) }
    expect(cadets).toHaveLength(27); expect(bare).toHaveLength(3)
    await issueOne(master, cadets[0], shorts, 'issue-first')
    await master.cadetPublisher.run() // what the debounce would do, and the queue it leaves is empty
    const transactionsBefore = chain.transactions().length
    let inFlight = 0, most = 0
    const broadcast = chain.broadcast.bind(chain)
    chain.broadcast = async hex => { inFlight++; most = Math.max(most, inFlight); try { return await broadcast(hex) } finally { inFlight-- } }
    const progress: Array<{ done: number; total: number; failed: number }> = []
    const result = await master.publishAllCadetRecords(entry => { progress.push({ ...entry }) })
    expect(result).toEqual({ done: 27, total: 27, failed: 0 })
    expect(progress.at(-1)).toEqual({ done: 27, total: 27, failed: 0 }); expect(progress.map(entry => entry.done)).toEqual([0, 25, 27]) // after each transaction
    expect(chain.transactions().length - transactionsBefore).toBe(2) // 27 records: 25 + 2
    expect(most).toBe(1)
    for (const cadetId of cadets) expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ cadetId, fullName: names.get(cadetId) })
    // X's key cannot open Y's record.
    const [x, y] = [await phoneOf(master, cadets[1]), await phoneOf(master, cadets[2])]
    const [foreign] = await readChannelRecords(chain, y.cadet.channelAddress, y.cadet.channelKey)
    await expect(openFromChannel(foreign.envelope, await importChannelKey(x.cadet.channelKey))).rejects.toThrow(/authentication failed/)
    expect(await readChannelRecords(chain, y.cadet.channelAddress, x.cadet.channelKey)).toEqual([])
    for (const cadetId of bare) expect((await master.controller.technicalState()).cadetChannels.some(channel => channel.cadetId === cadetId)).toBe(false)
  })

  it('only a Master may publish every record', async () => {
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const { runtime: assistant } = await joinByTicket(master, chain, 'Assistant C', 'SUPPLY_ASSISTANT', { satoshis: 30_000 })
    await expect(assistant.publishAllCadetRecords()).rejects.toThrow(/Only a unit Master/)
  })

  it('a failed broadcast is retried on the next run, and the queue survives the runtime being reopened', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { device, own, master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Gray Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await master.syncNow() // the unit's own record goes out first; the failure is meant for the cadet's
    chain.failNextBroadcasts('rejected')
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100); await master.cadetPublisher.idle()
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(0)
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    expect(master.cadetPublisher.lastErrors()[cadetId]).toMatch(/\S/)
    master.stop()
    const reopened = await open(device, chain, own)
    expect(reopened.cadetPublisher.queued()).toEqual([cadetId])
    const result = await reopened.cadetPublisher.run()
    expect(result).toEqual({ done: 1, total: 1, failed: 0 })
    expect(await recordsAt(reopened, chain, cadetId)).toHaveLength(1)
    expect(reopened.cadetPublisher.queued()).toEqual([])
    expect(await readCadetRecord(await phoneOf(reopened, cadetId), chain)).toMatchObject({ have: [expect.objectContaining({ label: 'PT Shorts' })] })
  })

  it('an ambiguous broadcast is finished from the wallet on the next run, without a second record', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Harper Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await master.syncNow() // the unit's own record goes out first; the failure is meant for the cadet's
    chain.failNextBroadcasts('ambiguous')
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100); await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    expect(await master.cadetPublisher.run()).toEqual({ done: 1, total: 1, failed: 0 })
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(1)
  })

  it('a failed publish is tried again by itself after a while', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Indigo Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await master.syncNow() // the unit's own record goes out first; the failure is meant for the cadet's
    chain.failNextBroadcasts('rejected')
    await vi.advanceTimersByTimeAsync(DEBOUNCE + 100); await master.cadetPublisher.idle()
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60_000); await master.cadetPublisher.idle()
    expect(await recordsAt(master, chain, cadetId)).toHaveLength(1)
  })

  it('refuses a record over the size cap, naming the cadet, and does not keep retrying it', async () => {
    const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(40)), byte => byte.toString(16).padStart(2, '0')).join('')
    const view: CadetView = { cadetId: 'cadet-big', cadetCode: 'C-BIG1', fullName: 'Jordan Overflow', sizes: {}, have: Array.from({ length: 700 }, (_, index) => ({ itemId: `item-${index}`, label: hex(), size: 'M', quantity: 1, issuedAt: '2026-10-01T00:00:00.000Z' })), stillNeeded: [], version: 3, updatedAt: '2026-10-01T00:00:00.000Z' }
    const wallet = { prepareRecords: vi.fn(), flush: vi.fn(), pending: vi.fn(async () => []), ownTxHex: vi.fn() }
    const publisher = new CadetPublisher({ channelFor: async () => ({ key: 'a'.repeat(64), address: 'mkVnRyRgdLSKbS3bnsAuAVoVGyZJVgz1Dv' }), viewFor: async () => view, wallet: wallet as never, storage: memoryStorage(), storageKey: 'q' })
    await expect(publisher.publishNow('cadet-big')).rejects.toThrow(/Jordan Overflow.*too large|too large.*Jordan Overflow/)
    publisher.note('cadet-big')
    expect(await publisher.run()).toEqual({ done: 0, total: 1, failed: 1 })
    expect(publisher.queued()).toEqual([])
    expect(publisher.lastErrors()['cadet-big']).toMatch(/Jordan Overflow/)
    expect(wallet.prepareRecords).not.toHaveBeenCalled()
  })
})

describe('a record goes out without waiting for a change to the cadet (mw-kmgi38.12)', { timeout: 240_000 }, () => {
  const settle = async () => { await vi.advanceTimersByTimeAsync(DEBOUNCE + 100) }
  const txidsAt = async (runtime: UnitRuntime, chain: FakeChain, cadetId: string) => (await recordsAt(runtime, chain, cadetId)).map(entry => entry.txid)
  const needOf = (cadetId: string, requirementId: string) => ({ requirementId, cadetId, displayLabel: 'Combination Cover', quantityNeeded: 2, quantityFulfilled: 0, status: 'OPEN' as const, firstNeededAt: '2026-10-01T00:00:00.000Z', source: 'MANUAL' as const })

  it('issuing a cadet’s ticket makes the channel and the phone reads the record as it stands, with no other change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Jules Private', false)
    await issueOne(master, cadetId, shorts, 'issue-1')
    await master.controller.addStillNeeded(needOf(cadetId, 'need-1'))
    expect(master.cadetPublisher.queued()).toEqual([])
    await master.issueCadetTicket(cadetId)
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    await settle(); await master.cadetPublisher.idle()
    expect(await txidsAt(master, chain, cadetId)).toHaveLength(1)
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ cadetId, fullName: 'Jules Private', have: [expect.objectContaining({ label: 'PT Shorts', size: 'M', quantity: 1 })], stillNeeded: [{ label: 'Combination Cover', quantity: 2 }] })
    expect(master.cadetPublisher.queued()).toEqual([])
  })

  it('making a channel queues the cadet by itself, and Replace phone sends the record to the new channel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Kai Private')
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    await settle(); await master.cadetPublisher.idle()
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ cadetId, fullName: 'Kai Private' })
    const before = await phoneOf(master, cadetId)
    await master.reissueCadetTicket(cadetId)
    await settle(); await master.cadetPublisher.idle()
    const after = await phoneOf(master, cadetId)
    expect(after.cadet.channelAddress).not.toBe(before.cadet.channelAddress)
    expect(await readCadetRecord(after, chain)).toMatchObject({ cadetId, fullName: 'Kai Private' })
    expect(await txidsAt(master, chain, cadetId)).toHaveLength(1)
  })

  it('an import queues the cadets it adds only once they have a channel, and one transaction goes to each', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const bystander = await addCadet(master, 'Lane Private')
    await settle(); await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([])
    await master.controller.importCadets([{ gender: 'Female', nsLevel: 'NS1', fullName: 'Morgan Import' }, { gender: 'Male', nsLevel: 'NS1', fullName: 'Noel Import' }])
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([]) // new cadets, no channel yet: nowhere to publish
    const [x, y] = ['Morgan Import', 'Noel Import'].map(name => (async () => (await master.controller.technicalState()).cadets.find(cadet => cadet.fullName === name)!.cadetId))
    const [xId, yId] = [await x(), await y()]
    await master.issueCadetTicket(xId); await master.issueCadetTicket(yId)
    await settle(); await master.cadetPublisher.idle()
    for (const [cadetId, name] of [[xId, 'Morgan Import'], [yId, 'Noel Import']]) {
      expect(await txidsAt(master, chain, cadetId)).toHaveLength(1)
      expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ cadetId, fullName: name })
    }
    expect(await txidsAt(master, chain, bystander)).toHaveLength(1)
  })

  it('an annual rollover queues every cadet it advanced who has a channel, and none without one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master } = await newUnit(chain)
    const x = await addCadet(master, 'Oak Private'), y = await addCadet(master, 'Pine Private'), bare = await addCadet(master, 'Reed Private', false)
    await settle(); await master.cadetPublisher.idle()
    const first = { x: await readCadetRecord(await phoneOf(master, x), chain), y: await readCadetRecord(await phoneOf(master, y), chain) }
    expect(master.cadetPublisher.queued()).toEqual([])
    await master.controller.completeAnnualRollover('2026-2027')
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued().sort()).toEqual([x, y].sort())
    await settle(); await master.cadetPublisher.idle()
    for (const [cadetId, was] of [[x, first.x], [y, first.y]] as const) {
      expect(await txidsAt(master, chain, cadetId)).toHaveLength(2)
      expect((await readCadetRecord(await phoneOf(master, cadetId), chain))!.version).toBeGreaterThan(was!.version)
    }
    expect((await master.controller.technicalState()).cadetChannels.some(channel => channel.cadetId === bare)).toBe(false)
  })

  it('a correction of an issued quantity, named by the transaction and not the cadet, republishes that cadet’s record', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    const cadetId = await addCadet(master, 'Sage Private')
    await issueOne(master, cadetId, shorts, 'issue-1')
    await settle(); await master.cadetPublisher.idle()
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ have: [expect.objectContaining({ quantity: 1 })] })
    const transaction = (await master.controller.technicalState()).transactions.find(candidate => candidate.transactionId === 'issue-1')!
    await master.controller.correctRecord({ kind: 'ISSUE_QUANTITY', targetEventId: transaction.eventId, lineId: 'l', from: 1, to: 3, reason: 'Counted again' })
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([cadetId])
    await settle(); await master.cadetPublisher.idle()
    expect(await readCadetRecord(await phoneOf(master, cadetId), chain)).toMatchObject({ have: [expect.objectContaining({ quantity: 3 })] })
  })

  it('an event that changes no cadet queues nobody', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), { master, shorts } = await newUnit(chain)
    await addCadet(master, 'Tate Private')
    await settle(); await master.cadetPublisher.idle()
    await master.controller.receiveStock(shorts, 5, 'More')
    await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queued()).toEqual([])
  })
})
