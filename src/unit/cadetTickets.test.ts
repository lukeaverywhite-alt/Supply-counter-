import { Transaction } from '@bsv/sdk'
import { IDBFactory } from 'fake-indexeddb'
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeArgusRecords } from '../chain/codec'
import { FakeChain } from '../chain/fakeChain'
import { canonicalize } from '../distributed/canonical'
import { decodeTicketCode } from '../identity/ticketCode'
import { deriveTicketKeys } from '../identity/ticketKeys'
import { parseCadetTicketPackage } from '../private-sync/schema'
import { openTicketRecord } from '../private-sync/ticketRecord'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { readCadetTicket, redeemCadetTicket, resumeCadetRedemption } from './cadetTicket'
import { readChannelRecords } from './channelReader'
import { importChannelKey, openFromChannel, sealToChannel } from './envelope'
import { MemoryLedgerStore } from './ledgerStore'
import { CADET_TICKET_SATOSHIS, UnitRuntime, cadetPhoneLine } from './runtime'
import { TICKET_REFUSALS, readTicket } from './ticketRedemption'
import { CADET_VAULT_STORAGE_KEY, DEVICE_VAULT_STORAGE_KEY, createMasterDevice, forgetDevice, loadCadetVault, rawUnitKeys, unlockCadetDevice, type UnlockedDevice } from './vault'
import { MemoryWalletStateStore } from '../chain/walletStore'

const open = (device: UnlockedDevice, chain: FakeChain) => UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
const PASSPHRASE = 'my locker 2468'

/** Every `T` record at the ticket's address, opened with the code: what a phone holding the code can read. */
async function packageJson(code: string, chain: FakeChain) {
  const keys = await deriveTicketKeys(decodeTicketCode(code))
  const txids = [...(await chain.confirmedHistory(keys.address)).items.map(item => item.txid), ...await chain.unconfirmedHistory(keys.address)]
  const payload = txids.flatMap(txid => decodeArgusRecords(chain.get(txid)!.hex).filter(record => record.kind === 'T'))[0].payload
  return await openTicketRecord(keys.wrappingKey, keys.address, payload)
}
/** A brand-new phone: nothing stored on it yet. */
const phone = () => memoryStorage()
async function issue(runtime: UnitRuntime, chain: FakeChain, cadetId: string, reissue = false) {
  const ticket = reissue ? await runtime.reissueCadetTicket(cadetId) : await runtime.issueCadetTicket(cadetId)
  await runtime.syncNow(); chain.mine()
  return ticket
}
const NO_UNIT_SECRETS = ['epochKeys', 'ticketEcdhPrivateKey', 'currentEpoch', 'issuerCredentials', 'authorityIdentity', 'walletWif', 'credential']

describe('a ticket per cadet (ADR 013, mw-kmgi38.2)', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let masterDevice: UnlockedDevice, master: UnitRuntime, assistant: UnitRuntime, cadetId: string, other: string
  beforeAll(async () => {
    masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(masterDevice.record.walletAddress, 400_000, { confirmed: true })
    master = await open(masterDevice, chain)
    const projection = await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Avery Private', cadetCode: 'C-4F7K' })
    cadetId = projection.cadets[0].cadetId
    other = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Blake Private', cadetCode: 'C-9J2Q' })).cadets.find(cadet => cadet.cadetId !== cadetId)!.cadetId
    await master.syncNow(); chain.mine()
    ;({ runtime: assistant } = await joinByTicket(master, chain, 'Sam Assistant', 'SUPPLY_ASSISTANT', { satoshis: 30_000 }))
    await assistant.syncNow(); await master.syncNow(); chain.mine()
  })

  it('a Master’s cadet ticket redeems on a second phone into cadet mode, holding the channel and notices keys and nothing of the unit', async () => {
    // Before any phone: the cadet has no channel, and the Phone line says so.
    expect(cadetPhoneLine(await master.readCadetChannel(cadetId))).toBe('No phone yet')
    const ticket = await issue(master, chain, cadetId)
    expect(ticket).toMatchObject({ cadetId, ticketId: expect.stringMatching(/^t-[0-9a-f]{20}$/), code: expect.stringMatching(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/), funding: { vout: 0, satoshis: CADET_TICKET_SATOSHIS } })

    // The ticket made the cadet's channel and the unit's notices key, and the unit log records the ticket.
    const state = await master.controller.technicalState()
    const channel = state.cadetChannels.find(entry => entry.cadetId === cadetId)!, notices = state.noticesChannel!
    expect(channel).toBeDefined(); expect(notices).toBeDefined()
    expect(state.cadetTickets).toEqual([expect.objectContaining({ ticketId: ticket.ticketId, cadetId, ticketAddress: ticket.ticketAddress, channelAddress: channel.channelAddress, funding: ticket.funding, issuedBy: masterDevice.record.signingIdentity })])
    expect(state.events.some(record => record.event.eventType === 'CADET_TICKET_ISSUED' && record.event.entityId === ticket.ticketId)).toBe(true)
    // ...and the issued ticket is not a staff ticket: no rotation will ever wrap a unit key to it.
    expect(state.tickets.some(entry => entry.ticketId === ticket.ticketId)).toBe(false)

    // What the code opens: a CADET package with the four channel values and nothing of the unit's keys.
    const json = await packageJson(ticket.code, chain), text = JSON.stringify(json)
    const cadetPackage = parseCadetTicketPackage(json)
    expect(cadetPackage).toMatchObject({ kind: 'CADET', invitation: { role: 'CADET', cadetId, displayName: 'Avery Private', ticketId: ticket.ticketId, expiresAt: ticket.expiresAt }, unit: { unitId: masterDevice.record.unit!.unitId, unitName: 'Bethel NJROTC' }, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: notices.key, noticesAddress: notices.address })
    for (const field of NO_UNIT_SECRETS) expect(text).not.toContain(`"${field}"`)
    for (const { key } of await rawUnitKeys(masterDevice)) expect(text).not.toContain(key)

    // The gate reads it with no keys and no wallet.
    expect(await readCadetTicket(ticket.code, { api: chain })).toMatchObject({ ticketId: ticket.ticketId, cadetId, displayName: 'Avery Private', unitName: 'Bethel NJROTC' })
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBeUndefined()

    // The phone redeems: it spends the funding output, and enters cadet mode.
    const store = phone()
    const redeemed = await redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE, deviceLabel: 'Avery’s phone' }, { api: chain, storage: store })
    expect(redeemed.status).toBe('ACTIVE')
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBe(redeemed.txid)
    expect(redeemed.device.cadet).toMatchObject({ cadetId, displayName: 'Avery Private', unit: { unitId: masterDevice.record.unit!.unitId, unitName: 'Bethel NJROTC' }, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: notices.key, noticesAddress: notices.address })
    // The starter satoshis, less the fee and two marker satoshis, go back to the issuer: the phone keeps no coins and no wallet.
    const outputs = Transaction.fromHex(chain.get(redeemed.txid)!.hex).outputs
    expect(outputs.reduce((sum, output) => sum + (output.satoshis ?? 0), 0)).toBeGreaterThan(CADET_TICKET_SATOSHIS - 10)

    // What the phone stored, read back with the passphrase: exactly the CadetDevice, with no epoch key, wallet or credential.
    const vault = loadCadetVault(store)!, unlocked = await unlockCadetDevice(vault, PASSPHRASE), stored = JSON.stringify(unlocked.cadet)
    expect(Object.keys(unlocked.cadet!).sort()).toEqual(['cadetId', 'channelAddress', 'channelKey', 'displayName', 'joinedAt', 'noticesAddress', 'noticesKey', 'unit'])
    expect(unlocked.cadet).toEqual(redeemed.device.cadet)
    for (const field of NO_UNIT_SECRETS) expect(stored).not.toContain(`"${field}"`)
    expect(Object.keys(vault.secrets).sort()).toEqual(['cadet', 'check'])
    // Nothing on the phone is readable without the passphrase: not the name, the cadet ID or a key; and there is no staff device record.
    const raw = [...store.values.values()].join('\n')
    for (const secret of ['Avery', cadetId, channel.channelKey, notices.key, 'epochKeys', 'ticketEcdhPrivateKey']) expect(raw).not.toContain(secret)
    expect(store.getItem(DEVICE_VAULT_STORAGE_KEY)).toBeNull()
    await expect(unlockCadetDevice(vault, 'wrong passphrase 1')).rejects.toThrow(/passphrase is not correct/)

    // Staff read the cadet's channel on demand and see the phone joined.
    const reading = await master.readCadetChannel(cadetId)
    expect(reading.joined).toEqual({ kind: 'CADET_JOINED', joinedAt: redeemed.device.cadet!.joinedAt, deviceLabel: 'Avery’s phone' })
    expect(cadetPhoneLine(reading)).toBe(`Phone: joined ${redeemed.device.cadet!.joinedAt.slice(0, 10)}`)
    expect(reading.records).toHaveLength(1)

    // Erasing the phone removes the cadet record too.
    await forgetDevice(store, new IDBFactory())
    expect(store.getItem(CADET_VAULT_STORAGE_KEY)).toBeNull()
  })

  it('readCadetChannel returns nothing before the phone redeems, and the CADET_JOINED record after', async () => {
    const ticket = await issue(master, chain, other)
    expect(await master.readCadetChannel(other)).toMatchObject({ records: [] })
    expect((await master.readCadetChannel(other)).joined).toBeUndefined()
    expect(cadetPhoneLine(await master.readCadetChannel(other))).toBe('No phone yet')
    const redeemed = await redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE }, { api: chain, storage: phone() })
    expect(redeemed.status).toBe('ACTIVE')
    const reading = await master.readCadetChannel(other)
    expect(reading.records.map(record => record.kind)).toEqual(['joined'])
    expect(reading.joined).toMatchObject({ kind: 'CADET_JOINED', joinedAt: redeemed.device.cadet!.joinedAt, deviceLabel: 'Phone' })
    // Another staff device reads the same, from the chain alone.
    await assistant.syncNow()
    expect((await assistant.readCadetChannel(other)).joined).toEqual(reading.joined)
  })

  it('a code redeems once: a second phone is told it was already used, and stores nothing', async () => {
    const ticket = await issue(master, chain, cadetId, true)
    const first = await redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE }, { api: chain, storage: phone() })
    expect(first.status).toBe('ACTIVE'); chain.mine()
    const second = phone()
    await expect(redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE }, { api: chain, storage: second })).rejects.toThrow(TICKET_REFUSALS.USED)
    expect(loadCadetVault(second)).toBeUndefined()
    // Racing: a second phone that read the ticket before the first spent it is refused by the network itself.
    const racing = await issue(master, chain, cadetId, true)
    const opened = await readCadetTicket(racing.code, { api: chain })
    expect((await redeemCadetTicket(racing.code, { passphrase: PASSPHRASE }, { api: chain, storage: phone() })).status).toBe('ACTIVE')
    const late = phone()
    await expect(redeemCadetTicket(opened, { passphrase: PASSPHRASE }, { api: chain, storage: late })).rejects.toThrow(TICKET_REFUSALS.USED)
    expect(loadCadetVault(late)).toBeUndefined()
  })

  it('an unanswered redemption is PENDING and resumes with the very same transaction; a staff code is not a cadet code, nor the reverse', async () => {
    const ticket = await issue(master, chain, cadetId, true), store = phone()
    chain.failNextBroadcasts('ambiguousButAccepted')
    const pending = await redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE }, { api: chain, storage: store })
    expect(pending.status).toBe('PENDING')
    expect(pending.device.cadet).toBeUndefined()
    expect(Object.keys(loadCadetVault(store)!.secrets).sort()).toEqual(['check', 'redeeming'])
    await expect(resumeCadetRedemption({ passphrase: 'wrong passphrase 1' }, { api: chain, storage: store })).rejects.toThrow(/passphrase is not correct/)
    const resumed = await resumeCadetRedemption({ passphrase: PASSPHRASE }, { api: chain, storage: store })
    expect(resumed).toMatchObject({ status: 'ACTIVE', txid: pending.txid, device: { cadet: { cadetId } } })
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBe(pending.txid)
    expect(Object.keys(loadCadetVault(store)!.secrets).sort()).toEqual(['cadet', 'check'])
    expect(await resumeCadetRedemption({ passphrase: PASSPHRASE }, { api: chain, storage: store })).toBeUndefined()
    await expect(redeemCadetTicket(ticket.code, { passphrase: PASSPHRASE }, { api: chain, storage: store })).rejects.toThrow(/already belongs to a cadet/)

    const staff = await master.issueTicket('Pat Officer', 'SUPPLY_OFFICER'); await master.syncNow(); chain.mine()
    await expect(readCadetTicket(staff.code, { api: chain })).rejects.toThrow(TICKET_REFUSALS.DAMAGED)
    const cadetCode = await issue(master, chain, other, true)
    await expect(readTicket(cadetCode.code, { api: chain })).rejects.toThrow(TICKET_REFUSALS.DAMAGED)
    // A phone set up as staff is never turned into a cadet's.
    const staffPhone = phone(); staffPhone.setItem(DEVICE_VAULT_STORAGE_KEY, '{}')
    await expect(redeemCadetTicket(cadetCode.code, { passphrase: PASSPHRASE }, { api: chain, storage: staffPhone })).rejects.toThrow(/already belongs to a unit/)
  })

  it('refuses a cadet ticket from a Supply Assistant, before any money moves', async () => {
    const before = await assistant.balance()
    await expect(assistant.issueCadetTicket(cadetId)).rejects.toThrow(/Unauthorized: cadets\.admit/)
    await expect(assistant.reissueCadetTicket(cadetId)).rejects.toThrow(/Unauthorized: cadets\.admit/)
    expect((await assistant.wallet.pending()).length).toBe(0)
    expect((await assistant.balance()).spendable).toBe(before.spendable)
    // and an unknown cadet gets no ticket
    await expect(master.issueCadetTicket('cadet_nobody')).rejects.toThrow(/Cadet was not found/)
  })

  it('Replace phone rotates the channel: the old phone cannot read the new channel, and the new phone cannot read the old', async () => {
    const firstTicket = await issue(master, chain, other, true)
    const oldPhone = await redeemCadetTicket(firstTicket.code, { passphrase: PASSPHRASE, deviceLabel: 'Old phone' }, { api: chain, storage: phone() })
    chain.mine()
    const oldCadet = oldPhone.device.cadet!
    const sealedOld = await sealToChannel({ channelId: oldCadet.channelAddress, key: await importChannelKey(oldCadet.channelKey), kind: 'view', plaintext: { note: 'sealed under the old key' } })

    const replaced = await issue(master, chain, other, true)
    const channel = (await master.controller.technicalState()).cadetChannels.find(entry => entry.cadetId === other)!
    expect(channel.channelAddress).not.toBe(oldCadet.channelAddress)
    expect(replaced.channelAddress).toBe(channel.channelAddress)
    // The new channel shows no phone until the new one joins.
    expect(cadetPhoneLine(await master.readCadetChannel(other))).toBe('No phone yet')
    const newPhone = await redeemCadetTicket(replaced.code, { passphrase: PASSPHRASE, deviceLabel: 'New phone' }, { api: chain, storage: phone() })
    chain.mine()
    const newCadet = newPhone.device.cadet!
    expect(newCadet.channelKey).toBe(channel.channelKey)
    expect(newCadet.channelKey).not.toBe(oldCadet.channelKey)
    // The notices channel is the unit's one, the same on both phones.
    expect(newCadet.noticesKey).toBe(oldCadet.noticesKey)

    // A record sealed under the old key does not open on the new phone...
    await expect(openFromChannel(sealedOld, await importChannelKey(newCadet.channelKey))).rejects.toThrow(/authentication failed/)
    // ...and the old phone cannot open the new channel's record (the new phone's CADET_JOINED), nor find it at its own address.
    const [newRecord] = await readChannelRecords(chain, newCadet.channelAddress, newCadet.channelKey)
    expect(newRecord.plaintext).toMatchObject({ kind: 'CADET_JOINED', deviceLabel: 'New phone' })
    await expect(openFromChannel(newRecord.envelope, await importChannelKey(oldCadet.channelKey))).rejects.toThrow(/authentication failed/)
    expect((await readChannelRecords(chain, oldCadet.channelAddress, oldCadet.channelKey)).map(record => canonicalize(record.plaintext))).toEqual([canonicalize({ kind: 'CADET_JOINED', joinedAt: oldCadet.joinedAt, deviceLabel: 'Old phone' })])
    expect((await master.readCadetChannel(other)).joined).toMatchObject({ deviceLabel: 'New phone' })
  })

  it('a ticket made before Replace phone still redeems, but only into the replaced channel, which staff no longer read', async () => {
    const stale = await issue(master, chain, cadetId, true)
    await issue(master, chain, cadetId, true)
    const late = await redeemCadetTicket(stale.code, { passphrase: PASSPHRASE }, { api: chain, storage: phone() })
    const current = (await master.controller.technicalState()).cadetChannels.find(entry => entry.cadetId === cadetId)!
    expect(late.device.cadet!.channelKey).not.toBe(current.channelKey)
    expect(cadetPhoneLine(await master.readCadetChannel(cadetId))).toBe('No phone yet')
  })
})
