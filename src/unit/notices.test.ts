import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { decodeArgusRecords } from '../chain/codec'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { readCadetChannel } from './cadetPublisher'
import { readChannelRecords } from './channelReader'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice } from './vault'

afterEach(() => { vi.useRealTimers() })

type Notice = { noticeId: string; text: string; sentAt: string; from: string }
async function setup() {
  const chain = new FakeChain()
  const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
  chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
  const storage = memoryStorage(), master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage })
  const withPhone = (await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Avery Private', cadetCode: 'C-T001' })).cadets[0].cadetId
  const other = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Blake Private', cadetCode: 'C-T002' })).cadets.find(cadet => cadet.cadetId !== withPhone)!.cadetId
  const bare = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Casey Private', cadetCode: 'C-T003' })).cadets.find(cadet => ![withPhone, other].includes(cadet.cadetId))!.cadetId
  await master.controller.createCadetChannel(withPhone); await master.controller.createCadetChannel(other); await master.controller.createNoticesKey()
  const state = await master.controller.technicalState()
  const channel = (cadetId: string) => state.cadetChannels.find(entry => entry.cadetId === cadetId)!
  /** The notices this key opens at this address: what a cadet's phone reads. */
  const noticesAt = async (address: string, key: string) => (await readChannelRecords(chain, address, key)).filter(record => record.kind === 'notice').map(record => record.plaintext as Notice)
  return { chain, master, storage, withPhone, other, bare, channel, notices: state.noticesChannel!, noticesAt }
}

describe('sending notices (ADR 013, mw-kmgi38.5)', { timeout: 240_000 }, () => {
  let world: Awaited<ReturnType<typeof setup>>
  beforeAll(async () => { world = await setup() })

  it('a notice to all leaves one record in each cadet’s own channel that opens under that cadet’s key only, and none at the notices address', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, notices, channel, withPhone, other, bare, noticesAt } = world
    const result = await master.sendNotice('all', 'Military ball: bring your SDBs')
    expect(result.published).toBe(true)
    const event = (await master.controller.technicalState()).events.find(record => record.event.eventType === 'NOTICE_SENT')!.event
    expect(event.payload).toMatchObject({ audience: 'all', text: 'Military ball: bring your SDBs' })
    const expected = [{ noticeId: result.noticeId, text: 'Military ball: bring your SDBs', sentAt: event.timestamp, from: 'Chief' }]
    for (const cadetId of [withPhone, other]) expect(await noticesAt(channel(cadetId).channelAddress, channel(cadetId).channelKey)).toEqual(expected)
    // The shared notices address is no longer written, and a cadet's key opens nobody else's record.
    expect(await noticesAt(notices.address, notices.key)).toEqual([])
    expect(await noticesAt(channel(withPhone).channelAddress, channel(other).channelKey)).toEqual([])
    expect(await noticesAt(channel(other).channelAddress, channel(withPhone).channelKey)).toEqual([])
    expect((await master.controller.technicalState()).cadetChannels.some(entry => entry.cadetId === bare)).toBe(false)
    expect(master.cadetPublisher.queuedNotices()).toEqual([])
  })

  it('a notice to one cadet leaves one record at that cadet’s address that opens under that cadet’s key only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, notices, channel, withPhone, other, noticesAt } = world
    const result = await master.sendNotice({ cadetId: withPhone }, 'Come to supply Thursday')
    expect(result.published).toBe(true)
    const mine = channel(withPhone)
    expect((await noticesAt(mine.channelAddress, mine.channelKey)).filter(notice => notice.text === 'Come to supply Thursday')).toHaveLength(1)
    expect((await noticesAt(channel(other).channelAddress, channel(other).channelKey)).map(notice => notice.text)).not.toContain('Come to supply Thursday')
    expect(await noticesAt(mine.channelAddress, channel(other).channelKey)).toEqual([])
    expect(await noticesAt(mine.channelAddress, notices.key)).toEqual([])
    expect(await noticesAt(notices.address, notices.key)).toEqual([])
    expect((await noticesAt(mine.channelAddress, mine.channelKey)).map(notice => notice.text).sort()).toEqual(['Come to supply Thursday', 'Military ball: bring your SDBs'])
    expect((await master.controller.project()).notices.map(notice => notice.text)).toEqual(['Come to supply Thursday', 'Military ball: bring your SDBs'])
  })

  it('a cadet with no channel gets This cadet has no phone yet, and nothing is recorded or sent', async () => {
    const { master, bare } = world, before = (await master.controller.technicalState()).events.length
    await expect(master.sendNotice({ cadetId: bare }, 'Hello')).rejects.toThrow('This cadet has no phone yet')
    expect((await master.controller.technicalState()).events).toHaveLength(before)
  })

  it('text over 500 characters is refused with a message and nothing is recorded', async () => {
    const { master } = world, before = (await master.controller.technicalState()).events.length
    await expect(master.sendNotice('all', 'x'.repeat(501))).rejects.toThrow('A notice can be at most 500 characters.')
    expect((await master.controller.technicalState()).events).toHaveLength(before)
  })

  it('a Supply Assistant’s send is refused before anything is written', async () => {
    const { master, chain } = world
    const { runtime: assistant } = await joinByTicket(master, chain, 'Sam Assistant', 'SUPPLY_ASSISTANT', { satoshis: 30_000 })
    await assistant.syncNow()
    const before = (await assistant.controller.technicalState()).events.length
    await expect(assistant.sendNotice('all', 'Hello')).rejects.toThrow(/notices\.send/)
    expect((await assistant.controller.technicalState()).events).toHaveLength(before)
  })

  it('offline: the notice is recorded, stays queued as an ID, never its text, in storage, and goes out when the network is back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { master, chain, withPhone, other, channel, noticesAt, storage } = world
    await master.syncNow() // the unit's own records go out first
    chain.failNextBroadcasts('rejected', 2) // the notice's own record in the unit log, then the sealed text
    const result = await master.sendNotice('all', 'Secret ball plans')
    expect(result.published).toBe(false)
    expect(master.cadetPublisher.queuedNotices()).toEqual([result.noticeId])
    expect([...storage.values.values()].filter(value => value.includes('Secret ball plans'))).toEqual([])
    expect((await noticesAt(channel(withPhone).channelAddress, channel(withPhone).channelKey)).map(notice => notice.text)).not.toContain('Secret ball plans')
    expect(master.cadetPublisher.noticeErrorsById()[result.noticeId]).toMatch(/\S/)
    await master.cadetPublisher.run(); await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queuedNotices()).toEqual([])
    // Each cadet's channel has it once, never twice.
    for (const cadetId of [withPhone, other]) expect((await noticesAt(channel(cadetId).channelAddress, channel(cadetId).channelKey)).filter(notice => notice.text === 'Secret ball plans')).toHaveLength(1)
  })
})

describe('a notice to all 250 cadets (mw-kmgi38.15)', { timeout: 600_000 }, () => {
  it('lands as 250 records in 10 transactions, one in each cadet’s own channel, and each cadet’s phone reads it with one scan of its own address', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), CADETS = 250
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 5_000_000, { confirmed: true })
    const master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    for (let index = 0; index < CADETS; index++) await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: `Cadet Number${index}`, cadetCode: `C-${String(index).padStart(4, '0')}` })
    for (const cadet of (await master.controller.technicalState()).cadets) await master.controller.createCadetChannel(cadet.cadetId)
    const state = await master.controller.technicalState()
    expect(state.cadetChannels).toHaveLength(CADETS)

    // First every cadet's record goes out (the channels' own queue): 250 records, 10 transactions.
    /** The transactions that carry channel records ('C'), and how many records they carry in all. */
    const channelTransactions = () => chain.transactions().map(tx => decodeArgusRecords(tx.hex).filter(record => record.kind === 'C').length).filter(count => count > 0)
    expect(channelTransactions()).toEqual([])
    expect(await master.publishAllCadetRecords()).toEqual({ done: CADETS, total: CADETS, failed: 0 })
    expect(channelTransactions()).toHaveLength(10); expect(channelTransactions().reduce((total, count) => total + count, 0)).toBe(CADETS)

    // Then the notice: 250 records, 10 transactions, and what it cost in satoshis.
    const beforeNotice = channelTransactions().length, balanceBefore = (await master.wallet.balance()).spendable
    const sent = await master.sendNotice('all', 'Military ball: bring your SDBs')
    expect(sent.published).toBe(true)
    expect(channelTransactions().slice(beforeNotice)).toEqual([25, 25, 25, 25, 25, 25, 25, 25, 25, 25]) // 250 records, 10 transactions
    const cost = balanceBefore - (await master.wallet.balance()).spendable
    expect(cost).toBeGreaterThanOrEqual(CADETS) // 250 anchor satoshis, one to each cadet's address, plus the network fee (measured: 354 satoshis in all)
    expect(cost).toBeLessThan(500)

    await master.syncNow(); master.stop() // the master's own background sync is done, so only the phones' reads are counted
    // Every cadet's phone reads it from its own channel; one poll is one scan of that one address.
    let worst = 0
    for (const channel of state.cadetChannels) {
      const before = chain.requestSnapshot()
      const read = await readCadetChannel({ cadet: { cadetId: channel.cadetId, channelKey: channel.channelKey, channelAddress: channel.channelAddress } }, chain)
      const spent = chain.requestsSince(before)
      expect(spent).toMatchObject({ confirmedHistory: 1, unconfirmedHistory: 1, txHex: 2 }) // the address's two transactions: the record and the notice
      worst = Math.max(worst, spent.total)
      expect(read.notices).toEqual([expect.objectContaining({ noticeId: sent.noticeId, text: 'Military ball: bring your SDBs', from: 'Chief' })])
      expect(read.view).toMatchObject({ cadetId: channel.cadetId })
    }
    expect(worst).toBe(4) // measured: 2 for the scan (confirmed history, mempool list) and 1 fetch for each of the address's 2 transactions
  })
})

describe('a notice to all that does not go out everywhere at once (mw-kmgi38.15)', { timeout: 240_000 }, () => {
  it('goes out again only to the cadets it has not reached: each channel holds it once, and the retry is one transaction', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain(), CADETS = 30
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 1_000_000, { confirmed: true })
    const storage = memoryStorage(), master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage })
    for (let index = 0; index < CADETS; index++) await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: `Cadet Number${index}`, cadetCode: `C-${String(index).padStart(4, '0')}` })
    for (const cadet of (await master.controller.technicalState()).cadets) await master.controller.createCadetChannel(cadet.cadetId)
    await master.publishAllCadetRecords(); await master.syncNow()
    const channels = (await master.controller.technicalState()).cadetChannels
    const noticeCount = async () => Promise.all(channels.map(async channel => (await readChannelRecords(chain, channel.channelAddress, channel.channelKey)).filter(record => record.kind === 'notice').length))
    // The network refuses the second of the two transactions (25 records, then 5).
    const broadcast = chain.broadcast.bind(chain)
    let calls = 0
    chain.broadcast = async hex => decodeArgusRecords(hex).some(record => record.kind === 'C') && ++calls === 2 ? { status: 'rejected', message: 'FakeChain: refused for the test.' } : broadcast(hex)
    const sent = await master.sendNotice('all', 'Late notice')
    expect(sent.published).toBe(false)
    expect(master.cadetPublisher.queuedNotices()).toEqual([sent.noticeId])
    expect((await noticeCount()).reduce((total, count) => total + count, 0)).toBe(25)
    chain.broadcast = broadcast
    const before = chain.transactions().length
    await master.cadetPublisher.run(); await master.cadetPublisher.idle()
    expect(master.cadetPublisher.queuedNotices()).toEqual([])
    expect(await noticeCount()).toEqual(channels.map(() => 1))
    expect(chain.transactions().length - before).toBe(1) // the five that were left, in one transaction
    // The delivery record is gone with the notice.
    expect([...storage.values.entries()].filter(([key]) => key.endsWith('.delivered')).map(([, value]) => value)).toEqual(['{}'])
  })
})
