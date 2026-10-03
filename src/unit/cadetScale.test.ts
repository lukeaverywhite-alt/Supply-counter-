import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeArgusRecords } from '../chain/codec'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { readCadetChannel, readCadetNotices, readCadetRecord } from './cadetPublisher'
import { redeemCadetTicket } from './cadetTicket'
import { deserializeChannelEnvelope, importChannelKey, openFromChannel, type ChannelEnvelope } from './envelope'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice, type CadetDevice } from './vault'

afterEach(() => { vi.useRealTimers() })

/**
 * 250 cadets, the size of a large unit (docs/concurrency.md), each on a phone of its own. Measured on the desktop, issuing a cadet's
 * ticket costs about 0.26 s at this size and redeeming it about 0.2 s (a PBKDF2 passphrase vault), so 250 full redemptions would not fit
 * in the 120 s budget. So the first ON_CHAIN_PHONES cadets (cadet 17 among them) go the whole way: ticket, redemption on the chain, a
 * vault on a phone of their own. The other 200 only have their channel made, and their CadetDevice is built directly from it, exactly as
 * redeeming would have made it. Everything after that (publishing, the notices, every read, every cross-read) is for all 250.
 */
const CADETS = 250, ON_CHAIN_PHONES = 50, NOTE_TO = 17
const NOTICE_TO_ALL = 'Military ball: bring your SDBs', NOTE = 'Come to supply Thursday'

describe('250 cadets on one chain (mw-kmgi38.8)', { timeout: 120_000 }, () => {
  it('each phone reads exactly its own record, the notice to all and (cadet 17 only) its note, opens no other cadet’s record, and a key rotation still fits one record', async () => {
    const started = Date.now()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const chain = new FakeChain()
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 5_000_000, { confirmed: true })
    const master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })

    // One Master makes 250 cadets and a ticket for each (the ticket makes the cadet's channel); the tickets go out on the chain.
    for (let index = 0; index < CADETS; index++) await master.controller.createCadet({ gender: index % 2 ? 'Female' : 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: `Cadet Number${index}`, cadetCode: `C-${String(index).padStart(4, '0')}` })
    const cadetIds = (await master.controller.technicalState()).cadets.map(cadet => cadet.cadetId)
    expect(new Set(cadetIds).size).toBe(CADETS)
    const tickets = []
    for (const cadetId of cadetIds.slice(0, ON_CHAIN_PHONES)) tickets.push(await master.issueCadetTicket(cadetId))
    for (const cadetId of cadetIds.slice(ON_CHAIN_PHONES)) await master.controller.createCadetChannel(cadetId)
    await master.syncNow(); chain.mine()
    const state = await master.controller.technicalState(), channels = state.cadetChannels
    expect(channels).toHaveLength(CADETS)
    expect(new Set(channels.map(channel => channel.channelAddress)).size).toBe(CADETS)

    // The first phones redeem their tickets, each with a fresh storage and its own passphrase, nothing shared with any other phone.
    const phones: CadetDevice[] = []
    for (const ticket of tickets) {
      const redeemed = await redeemCadetTicket(ticket.code, { passphrase: `locker pass ${ticket.cadetId}`, deviceLabel: 'Phone' }, { api: chain, storage: memoryStorage() })
      expect(redeemed.status).toBe('ACTIVE')
      phones.push(redeemed.device.cadet!)
    }
    // The rest are built the way a redemption builds them: the cadet's own channel and the unit's notices key, nothing else.
    const unit = { unitId: device.record.unit!.unitId, unitName: device.record.unit!.unitName }, notices = state.noticesChannel!
    for (const cadetId of cadetIds.slice(ON_CHAIN_PHONES)) {
      const channel = channels.find(entry => entry.cadetId === cadetId)!
      phones.push({ cadetId, displayName: cadetId, unit, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: notices.key, noticesAddress: notices.address, joinedAt: new Date().toISOString() })
    }
    expect(phones).toHaveLength(CADETS)
    expect(phones.map(phone => phone.cadetId)).toEqual(cadetIds)
    for (const phone of phones.slice(0, ON_CHAIN_PHONES)) expect(phone).toMatchObject({ channelKey: channels.find(entry => entry.cadetId === phone.cadetId)!.channelKey, noticesKey: notices.key })

    // The staff device publishes every cadet's record (250 records, 10 transactions of 25), then one notice to all and one note to cadet 17.
    /** The channel records ('C') on the chain, sealed envelopes in the order they were written. */
    const channelEnvelopes = () => chain.transactions().flatMap(tx => decodeArgusRecords(tx.hex).filter(record => record.kind === 'C').map(record => deserializeChannelEnvelope(record.payload)))
    const joinedRecords = channelEnvelopes().filter(envelope => envelope.kind === 'joined').length
    expect(joinedRecords).toBe(ON_CHAIN_PHONES) // the redemptions that went through the chain, one CADET_JOINED each
    expect(channelEnvelopes().filter(envelope => envelope.kind === 'view')).toHaveLength(0)
    expect(await master.publishAllCadetRecords()).toEqual({ done: CADETS, total: CADETS, failed: 0 })
    const views = channelEnvelopes().filter(envelope => envelope.kind === 'view')
    expect(views).toHaveLength(CADETS)
    expect(new Set(views.map(envelope => envelope.ch)).size).toBe(CADETS) // one record in each cadet's own channel
    const toAll = await master.sendNotice('all', NOTICE_TO_ALL), toOne = await master.sendNotice({ cadetId: cadetIds[NOTE_TO] }, NOTE)
    expect(toAll.published).toBe(true); expect(toOne.published).toBe(true)
    expect(channelEnvelopes().filter(envelope => envelope.kind === 'notice')).toHaveLength(CADETS + 1) // 250 copies of the notice to all, one note
    await master.syncNow(); master.stop(); chain.mine()

    // Every phone reads its own channel: its own record, the notice to all, and the note only if it is cadet 17's.
    const newestView = new Map<string, ChannelEnvelope>()
    for (const envelope of views) newestView.set(envelope.ch, envelope)
    let readers = 0, withNote = 0, crossAttempts = 0, worstPoll = 0
    for (const [index, cadet] of phones.entries()) {
      const before = chain.requestSnapshot(), read = await readCadetChannel({ cadet }, chain), spent = chain.requestsSince(before)
      // One poll is one scan of this one address (two requests) and one fetch for each transaction there: the record, the notice to all, the redemption (on-chain phones) and the note (cadet 17).
      const transactionsHere = 2 + (index < ON_CHAIN_PHONES ? 1 : 0) + (index === NOTE_TO ? 1 : 0)
      expect(spent, `phone ${index}`).toMatchObject({ confirmedHistory: 1, unconfirmedHistory: 1, txHex: transactionsHere, broadcast: 0 })
      worstPoll = Math.max(worstPoll, spent.total)
      expect(read.view, `phone ${index}`).toMatchObject({ cadetId: cadet.cadetId })
      expect(read.view?.cadetId).toBe(cadetIds[index])
      const texts = read.notices.map(notice => notice.text).sort()
      expect(texts, `phone ${index}`).toEqual(index === NOTE_TO ? [NOTE, NOTICE_TO_ALL].sort() : [NOTICE_TO_ALL])
      expect(read.notices.find(notice => notice.text === NOTICE_TO_ALL)).toMatchObject({ noticeId: toAll.noticeId, from: 'Chief' })
      readers++; if (texts.includes(NOTE)) withNote++

      // This phone's key opens its own newest record, and every other cadet's newest record, even given that cadet's own address, does not open.
      const key = await importChannelKey(cadet.channelKey)
      await expect(openFromChannel(newestView.get(cadet.channelAddress)!, key, cadet.channelAddress)).resolves.toMatchObject({ kind: 'view' })
      for (const other of channels) {
        if (other.channelAddress === cadet.channelAddress) continue
        await expect(openFromChannel(newestView.get(other.channelAddress)!, key, other.channelAddress)).rejects.toThrow()
        crossAttempts++
      }
    }
    expect(readers).toBe(CADETS); expect(withNote).toBe(1)
    expect(worstPoll).toBe(6) // measured: 2 for the scan and 4 fetches, for cadet 17 alone (redemption, record, notice to all, note); every other phone costs 4 or 5
    expect(crossAttempts).toBe(CADETS * (CADETS - 1))
    // The narrower readers return the same as the one scan (checked on the phone that has the note, and on a phone without it).
    expect((await readCadetRecord({ cadet: phones[NOTE_TO] }, chain))?.cadetId).toBe(cadetIds[NOTE_TO])
    expect((await readCadetNotices({ cadet: phones[NOTE_TO] }, chain)).map(notice => notice.text).sort()).toEqual([NOTE, NOTICE_TO_ALL].sort())
    expect((await readCadetNotices({ cadet: phones[0] }, chain)).map(notice => notice.text)).toEqual([NOTICE_TO_ALL])

    // A unit key rotation with 250 cadets present: cadets are outside it, so it is one record with one grant for each staff device.
    const { runtime: officer } = await joinByTicket(master, chain, 'Officer B', 'SUPPLY_OFFICER')
    await master.syncNow(); await officer.syncNow(); chain.mine()
    const staff = (await master.controller.project()).members.filter(member => member.status === 'ACTIVE').length
    expect(staff).toBe(2)
    const unitRecords = () => chain.transactions().flatMap(tx => decodeArgusRecords(tx.hex).filter(record => record.kind === 'E')).length
    const rotationsBefore = (await master.controller.technicalState()).events.filter(record => record.event.eventType === 'UNIT_KEY_ROTATED').length
    await master.syncNow(); chain.mine()
    const recordsBefore = unitRecords()
    const rotation = await master.rotateUnitKey('MANUAL')
    expect(rotation).toMatchObject({ recipients: staff, missing: [] })
    const rotations = (await master.controller.technicalState()).events.filter(record => record.event.eventType === 'UNIT_KEY_ROTATED')
    expect(rotations).toHaveLength(rotationsBefore + 1)
    const grants = rotations[rotations.length - 1].event.payload.grants as unknown[]
    expect(grants).toHaveLength(staff) // the cadets get no grant: 250 cadets, still the staff count
    await master.syncNow(); chain.mine()
    expect(unitRecords() - recordsBefore).toBe(1) // one record on the chain for the rotation
    master.stop(); officer.stop()

    expect(Date.now() - started, 'the whole run').toBeLessThan(120_000)
  })
})
