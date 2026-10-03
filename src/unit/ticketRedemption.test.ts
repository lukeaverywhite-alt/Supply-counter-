import { Transaction } from '@bsv/sdk'
import { beforeAll, describe, expect, it } from 'vitest'
import { unitAnchorAddress } from '../blockchain/anchor'
import { decodeArgusRecords } from '../chain/codec'
import { FakeChain } from '../chain/fakeChain'
import type { ChainApi } from '../chain/types'
import { DeviceWallet } from '../chain/wallet'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { ticketCredential } from '../auth/authorization'
import { canonicalize } from '../distributed/canonical'
import { MAX_CLOCK_JUMP, authorBoundEventId } from '../distributed/replica'
import type { ArgusRole, SignedArgusEvent } from '../distributed/types'
import { TicketCodeError, decodeTicketCode, encodeTicketCode, makeTicketSecret } from '../identity/ticketCode'
import { deriveTicketKeys, signWithTicketKey, verifyTicketSignature } from '../identity/ticketKeys'
import { parseTicketPackage, parseTicketRedemption } from '../private-sync/schema'
import { openTicketRecord, sealTicketRecord } from '../private-sync/ticketRecord'
import { GENESIS_CATALOG } from '../stage3/domain'
import { serializeEnvelope, sealEnvelope } from './envelope'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { TICKET_REFUSALS, TicketRefusal, readTicket, redeemTicket, resumeTicketRedemption } from './ticketRedemption'
import { createJoiningDevice, createMasterDevice, type UnlockedDevice } from './vault'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
const open = (device: UnlockedDevice, chain: ChainApi) => UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() })

/** A brand-new phone: its own vault, ledger and wallet store, nothing of the unit yet. */
async function freshDevice(chain: ChainApi) {
  const options = { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() }
  const device = await createJoiningDevice({ passphrase: 'cadet locker 9', displayName: 'Typed at the gate' }, options.storage)
  return { device, options }
}
/** Redeems on a fresh device and opens it, as the identity gate will. */
async function redeemFresh(code: string, chain: ChainApi) {
  const { device, options } = await freshDevice(chain)
  const result = await redeemTicket(device, code, options)
  expect(result.status).toBe('ACTIVE')
  const runtime = await UnitRuntime.open(result.device, options)
  await runtime.syncNow()
  return { ...result, runtime, options }
}
async function issue(runtime: UnitRuntime, name: string, role: ArgusRole, chain: FakeChain) { const ticket = await runtime.issueTicket(name, role); await runtime.syncNow(); chain.mine(); return ticket }
const refusal = (words: string) => expect.objectContaining({ message: words })
/** What the code opens at the ticket's address: the genuine TICKET record, as the issuer wrote it. */
async function openPackage(code: string, chain: FakeChain) {
  const keys = await deriveTicketKeys(decodeTicketCode(code))
  const txid = (await chain.confirmedHistory(keys.address)).items.map(item => item.txid).find(candidate => decodeArgusRecords(chain.get(candidate)!.hex).some(record => record.kind === 'T'))!
  return { keys, txid, record: parseTicketPackage(await openTicketRecord(keys.wrappingKey, keys.address, decodeArgusRecords(chain.get(txid)!.hex).find(record => record.kind === 'T')!.payload)) }
}

describe('redeeming an admission ticket on a fresh device (ADR 012)', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let masterDevice: UnlockedDevice, master: UnitRuntime
  beforeAll(async () => {
    masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, storage())
    chain.fund(masterDevice.record.walletAddress, 400_000, { confirmed: true })
    master = await open(masterDevice, chain)
    await master.controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    await master.syncNow(); chain.mine()
  })

  it('reads the ticket from the chain with no wallet and no keys, and shows who it is for before anything is made', async () => {
    const ticket = await issue(master, 'Pat Cadet', 'SUPPLY_OFFICER', chain)
    const opened = await readTicket(` ${ticket.code.toLowerCase().replaceAll('-', ' ')} `, { api: chain })
    expect(opened).toMatchObject({ ticketId: ticket.ticketId, unitName: 'Bethel NJROTC', issuerDisplayName: 'Chief', displayName: 'Pat Cadet', role: 'SUPPLY_OFFICER', expiresAt: ticket.expiresAt })
    // reading spent nothing: the funding output is still there
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBeUndefined()
  })

  it('redeems: the device is ACTIVE with the ticket’s role and name, reads the unit’s records, and every device accepts what it writes', async () => {
    const ticket = await issue(master, 'Robin Recruit', 'SUPPLY_OFFICER', chain)
    const { device, txid, runtime } = await redeemFresh(ticket.code, chain)
    expect(device.record).toMatchObject({ role: 'SUPPLY_OFFICER', displayName: 'Robin Recruit', credential: { credentialId: ticket.ticketId, role: 'SUPPLY_OFFICER', subjectPublicIdentity: device.record.signingIdentity } })
    expect(runtime.status()).toMatchObject({ role: 'SUPPLY_OFFICER', displayName: 'Robin Recruit', unitName: 'Bethel NJROTC', revoked: false })

    // the redemption spent the ticket's funding output: that is what makes it single-use
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBe(txid)
    const records = decodeArgusRecords(chain.get(txid)!.hex), keys = await deriveTicketKeys(decodeTicketCode(ticket.code))
    const redemption = parseTicketRedemption(await openTicketRecord(keys.wrappingKey, keys.address, records.find(record => record.kind === 'T')!.payload))
    // signed by the ticket key, binding this device's own identity, ECDH key and wallet
    expect(redemption).toMatchObject({ ticketId: ticket.ticketId, subjectPublicIdentity: device.record.signingIdentity, ecdhPublicKey: device.record.ecdhPublicKey, walletAddress: device.record.walletAddress })
    const { signature, ...unsigned } = redemption
    expect(verifyTicketSignature(keys.publicIdentity, canonicalize(unsigned), signature)).toBe(true)
    // the TICKET_REDEEMED fact travels in the same transaction, to the unit's anchor
    expect(records.some(record => record.kind === 'E')).toBe(true)
    const outputs = Transaction.fromHex(chain.get(txid)!.hex).outputs.map(output => output.lockingScript.toHex())
    expect(outputs).toContain(Transaction.fromHex(chain.get(ticket.funding.txid)!.hex).outputs[ticket.funding.vout].lockingScript.toHex())
    // it needed no satoshis of its own: the change of the redemption is its wallet's first coins
    expect((await runtime.balance()).spendable).toBeGreaterThan(1_000)

    // it reads what the unit wrote before it joined
    const projection = await runtime.controller.project()
    expect(projection.inventory.filter(item => item.catalogId === PT_SHORTS).map(item => item.variant).sort()).toEqual(['M', 'S'])
    expect(projection.members.find(member => member.publicIdentity === device.record.signingIdentity)).toMatchObject({ status: 'ACTIVE', role: 'SUPPLY_OFFICER', displayName: 'Robin Recruit', credentialId: ticket.ticketId })
    expect(projection.tickets.find(entry => entry.ticketId === ticket.ticketId)).toMatchObject({ status: 'REDEEMED', redeemedBy: device.record.signingIdentity })

    // it writes, and the Master's device accepts its authority -> ticket -> device chain
    await runtime.controller.addCatalogSizes(PT_SHORTS, ['XL'])
    await runtime.syncNow(); chain.mine(); await master.syncNow()
    const seen = await master.controller.project()
    expect(seen.inventory.some(item => item.catalogId === PT_SHORTS && item.variant === 'XL')).toBe(true)
    expect(seen.members.find(member => member.publicIdentity === device.record.signingIdentity)).toMatchObject({ status: 'ACTIVE', role: 'SUPPLY_OFFICER', displayName: 'Robin Recruit', ecdhPublicKey: device.record.ecdhPublicKey, walletAddress: device.record.walletAddress, admittedBy: masterDevice.record.signingIdentity })
    expect((await master.tickets()).find(entry => entry.ticketId === ticket.ticketId)).toMatchObject({ status: 'redeemed' })
    expect(seen.rejected).toEqual([])
    expect((await runtime.controller.project()).rejected).toEqual([])

    // a second fresh device with the same code is refused in plain words, before it spends or keeps anything
    const second = await freshDevice(chain)
    await expect(readTicket(ticket.code, { api: chain })).rejects.toEqual(refusal(TICKET_REFUSALS.USED))
    await expect(redeemTicket(second.device, ticket.code, second.options)).rejects.toEqual(refusal('This ticket was already used on another device.'))
    expect(second.device.record).toMatchObject({ role: 'PENDING' })
    expect(second.device.record.unit).toBeUndefined()
    expect(await second.options.ledger.envelopes()).toEqual([])

    // after a rotation the ticket-admitted device receives the new unit key, wrapped to the ECDH key its redemption carried
    const rotation = await master.rotateUnitKey()
    await master.syncNow(); chain.mine(); await runtime.syncNow()
    expect(device.unitKeys.has(rotation.epochId)).toBe(true)
    expect(runtime.status().currentEpoch).toBe(rotation.epochId)
    await master.controller.addCatalogSizes(PT_SHORTS, ['XS'])
    await master.syncNow(); chain.mine(); await runtime.syncNow()
    expect((await runtime.controller.project()).inventory.some(item => item.catalogId === PT_SHORTS && item.variant === 'XS')).toBe(true)
  })

  it('is not thrown off by a record far ahead in the unit’s clock: its fact still lands where every device can place it', async () => {
    const ticket = await issue(master, 'Cal Clock', 'SUPPLY_ASSISTANT', chain)
    const { record: ticketPackage } = await openPackage(ticket.code, chain), unitId = ticketPackage.unit.unitId
    // someone holding the unit key (here, from the ticket) signs a record of their own with a clock far beyond the fold's limit
    const stranger = await createJoiningDevice({ passphrase: 'stranger pass 12', displayName: 'Stranger' }, storage())
    const clock = (await master.controller.project()).events.reduce((max, entry) => Math.max(max, entry.event.clock ?? 0), 0) + 10 * MAX_CLOCK_JUMP
    const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: unitId, eventVersion: 1 as const, eventId: await authorBoundEventId(stranger.record.signingIdentity, crypto.randomUUID()), eventType: 'CATALOG_SIZES_ADDED' as const, entityId: PT_SHORTS, actorPublicIdentity: stranger.record.signingIdentity, timestamp: new Date().toISOString(), clock, payload: { sizes: [{ itemId: 'far-ahead', label: '5XL' }] } }
    const key = await crypto.subtle.importKey('raw', Buffer.from(ticketPackage.epochKeys.find(entry => entry.epochId === ticketPackage.currentEpoch)!.key, 'base64url'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    const envelope = await sealEnvelope({ unitId, epochId: ticketPackage.currentEpoch, key, plaintext: { event: { ...unsigned, signature: await stranger.identity.sign(canonicalize(unsigned)) } } })
    const wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(wallet.address, 10_000, { confirmed: true }); await wallet.refresh()
    await wallet.prepareRecords([{ kind: 'E', payload: serializeEnvelope(envelope) }], unitAnchorAddress(unitId), [])
    expect((await wallet.flush()).broadcast).toHaveLength(1)
    chain.mine()
    const { device } = await redeemFresh(ticket.code, chain)
    await master.syncNow()
    expect((await master.controller.project()).members.find(member => member.publicIdentity === device.record.signingIdentity)).toMatchObject({ status: 'ACTIVE', credentialId: ticket.ticketId })
  })

  it('decides a race by the network: the device whose redemption loses is told the ticket was already used, and keeps nothing', async () => {
    const ticket = await issue(master, 'Sam Second', 'SUPPLY_ASSISTANT', chain)
    const late = await freshDevice(chain), opened = await readTicket(ticket.code, { api: chain })
    await redeemFresh(ticket.code, chain)
    await expect(redeemTicket(late.device, opened, late.options)).rejects.toEqual(refusal(TICKET_REFUSALS.USED))
    expect(late.device.record.role).toBe('PENDING')
    expect(late.device.record.unit).toBeUndefined()
    expect(Object.keys(late.device.record.secrets).sort()).toEqual(['ecdh', 'signing', 'wallet'])
    expect(await late.options.walletStore.load(late.device.record.walletAddress).then(state => state?.pending ?? [])).toEqual([])
  })

  it('refuses a cancelled ticket', async () => {
    const ticket = await issue(master, 'Cass Cancel', 'SUPPLY_ASSISTANT', chain)
    expect((await master.cancelTicket(ticket.ticketId)).status).toBe('CANCELLED')
    await expect(readTicket(ticket.code, { api: chain })).rejects.toEqual(refusal('This ticket was cancelled.'))
    const { device, options } = await freshDevice(chain)
    await expect(redeemTicket(device, ticket.code, options)).rejects.toBeInstanceOf(TicketRefusal)
  })

  it('refuses a ticket past its expiry by the later of the device’s clock and the chain’s, so a phone with its clock set back gains nothing', async () => {
    const ticket = await issue(master, 'Eve Expired', 'SUPPLY_ASSISTANT', chain)
    const expiry = Date.parse(ticket.expiresAt)
    await expect(readTicket(ticket.code, { api: chain, now: () => new Date(expiry) })).rejects.toEqual(refusal('This ticket has expired; ask for a new one.'))
    await expect(readTicket(ticket.code, { api: chain, now: () => new Date(expiry - 60_000) })).resolves.toMatchObject({ ticketId: ticket.ticketId })
    chain.blockTime = new Date(expiry + 1)
    try {
      await expect(readTicket(ticket.code, { api: chain })).rejects.toEqual(refusal(TICKET_REFUSALS.EXPIRED))
      const { device, options } = await freshDevice(chain)
      await expect(redeemTicket(device, ticket.code, options)).rejects.toEqual(refusal(TICKET_REFUSALS.EXPIRED))
      expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBeUndefined()
    } finally { chain.blockTime = undefined }
  })

  it('refuses a TICKET record that was tampered with on its way from the network', async () => {
    const ticket = await issue(master, 'Tess Tamper', 'SUPPLY_ASSISTANT', chain)
    const { txid: recordTxid } = await openPackage(ticket.code, chain)
    const payloadHex = Buffer.from(decodeArgusRecords(chain.get(recordTxid)!.hex).find(record => record.kind === 'T')!.payload).toString('hex')
    // an indexer (or anyone in between) changes one character of the ciphertext
    const at = payloadHex.indexOf(Buffer.from('"ct":"').toString('hex')) + 20, flipped = payloadHex.slice(0, at) + (payloadHex[at] === '4' ? '5' : '4') + payloadHex.slice(at + 1)
    const tampering: ChainApi = Object.assign(Object.create(chain) as FakeChain, { txHex: async (txid: string) => txid === recordTxid ? chain.get(txid)!.hex.replace(payloadHex, flipped) : chain.txHex(txid) })
    await expect(readTicket(ticket.code, { api: tampering })).rejects.toEqual(refusal(TICKET_REFUSALS.DAMAGED))
    const { device, options } = await freshDevice(tampering)
    await expect(redeemTicket(device, ticket.code, options)).rejects.toEqual(refusal(TICKET_REFUSALS.DAMAGED))
    expect(chain.spenderOf(ticket.funding.txid, ticket.funding.vout)).toBeUndefined()
  })

  it('refuses a ticket someone made up: a TICKET record whose invitation the issuer never signed (here, its role raised to Master)', async () => {
    const real = await issue(master, 'Mo Forger', 'SUPPLY_ASSISTANT', chain)
    const { record: genuine } = await openPackage(real.code, chain)
    // a code of the forger's own, funded and carrying the real package with the role changed: the issuer's signature no longer fits
    const secret = makeTicketSecret(), code = encodeTicketCode(secret), keys = await deriveTicketKeys(secret)
    const fundingTxid = chain.fund(keys.address, 2_000, { confirmed: true })
    const forged = { ...genuine, invitation: { ...genuine.invitation, role: 'MASTER' as const, ticketPublicKey: keys.publicIdentity, funding: { txid: fundingTxid, vout: 0, satoshis: 2_000 } } }
    const forger = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(forger.address, 10_000, { confirmed: true }); await forger.refresh()
    await forger.prepareRecords([{ kind: 'T', payload: await sealTicketRecord(keys.wrappingKey, keys.address, forged) }], keys.address, [])
    expect((await forger.flush()).broadcast).toHaveLength(1)
    await expect(readTicket(code, { api: chain })).rejects.toEqual(refusal(TICKET_REFUSALS.DAMAGED))
  })

  it('says a ticket is not on the network yet when its record has not arrived', async () => {
    const secret = makeTicketSecret()
    await expect(readTicket(encodeTicketCode(secret), { api: chain })).rejects.toEqual(refusal(TICKET_REFUSALS.NOT_ON_NETWORK))
  })

  it('passes the code reader’s own three refusals through unchanged', async () => {
    await expect(readTicket('https://example.com/not-a-ticket', { api: chain })).rejects.toMatchObject({ fault: 'NOT_A_TICKET_CODE' })
    const code = encodeTicketCode(makeTicketSecret())
    await expect(readTicket(code.slice(0, 20), { api: chain })).rejects.toMatchObject({ fault: 'PART_MISSING' })
    await expect(readTicket(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A'), { api: chain })).rejects.toBeInstanceOf(TicketCodeError)
  })

  it('makes no member of a code holder who publishes a TICKET_REDEEMED fact outside the ticket’s own spend, and lets them do nothing', async () => {
    const ticket = await issue(master, 'Lee Leak', 'SUPPLY_OFFICER', chain)
    const { device: member, runtime } = await redeemFresh(ticket.code, chain)
    // someone else holding the code (and so the unit keys it carried) writes a redemption of their own, signed with the ticket key
    const { keys, record: ticketPackage } = await openPackage(ticket.code, chain), unitId = ticketPackage.unit.unitId
    const thief = await createJoiningDevice({ passphrase: 'thief pass 1234', displayName: 'Thief' }, storage())
    const unsigned = { kind: 'TICKET_REDEEMED' as const, redemptionVersion: 1 as const, ticketId: ticket.ticketId, unitId, subjectPublicIdentity: thief.record.signingIdentity, ecdhPublicKey: thief.record.ecdhPublicKey, walletAddress: thief.record.walletAddress, redeemedAt: new Date(Date.parse(ticket.issuedAt) + 1).toISOString() }
    const fact = { ticketId: ticket.ticketId, invitation: ticketPackage.invitation, issuerCredentials: ticketPackage.issuerCredentials, redemption: { ...unsigned, signature: signWithTicketKey(keys.privateKey, canonicalize(unsigned)) } }
    const credential = ticketCredential(fact), clock = (await master.controller.project()).events.reduce((max, entry) => Math.max(max, entry.event.clock ?? 0), 0)
    const forge = async (eventType: SignedArgusEvent['eventType'], entityId: string, payload: Record<string, unknown>, offset: number) => {
      const event = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: unitId, eventVersion: 1 as const, eventId: await authorBoundEventId(thief.record.signingIdentity, crypto.randomUUID()), eventType, entityId, actorPublicIdentity: thief.record.signingIdentity, timestamp: new Date().toISOString(), clock: clock + offset, payload }
      return { ...event, signature: await thief.identity.sign(canonicalize(event)) } as SignedArgusEvent
    }
    const key = await crypto.subtle.importKey('raw', Buffer.from(ticketPackage.epochKeys.find(entry => entry.epochId === ticketPackage.currentEpoch)!.key, 'base64url'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    const events = [await forge('TICKET_REDEEMED', ticket.ticketId, fact, 1), await forge('CATALOG_SIZES_ADDED', PT_SHORTS, { sizes: [{ itemId: 'stolen-size', label: 'XXXL' }] }, 2)]
    const envelopes = await Promise.all(events.map(event => sealEnvelope({ unitId, epochId: ticketPackage.currentEpoch, key, plaintext: { event, credential } })))
    const wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(wallet.address, 10_000, { confirmed: true }); await wallet.refresh()
    await wallet.prepareRecords(envelopes.map(envelope => ({ kind: 'E' as const, payload: serializeEnvelope(envelope) })), unitAnchorAddress(unitId), [])
    expect((await wallet.flush()).broadcast).toHaveLength(1)
    chain.mine(); await master.syncNow()
    let projection = await master.controller.project()
    expect(projection.members.find(entry => entry.publicIdentity === thief.record.signingIdentity)).toBeUndefined()
    expect(projection.inventory.some(item => item.variant === 'XXXL')).toBe(false)
    // the real member keeps the ticket's role and goes on working
    await runtime.controller.addCatalogSizes(PT_SHORTS, ['XXL'])
    await runtime.syncNow(); chain.mine(); await master.syncNow()
    projection = await master.controller.project()
    expect(projection.members.find(entry => entry.publicIdentity === member.record.signingIdentity)).toMatchObject({ status: 'ACTIVE', credentialId: ticket.ticketId })
    expect(projection.inventory.some(item => item.variant === 'XXL')).toBe(true)
  })
})

describe('redemption around rotations and an unreachable network', { timeout: 240_000 }, () => {
  it('gives a device redeeming after a rotation made while its ticket was open the key of that rotation, through the ticket’s own ECDH key', async () => {
    const chain = new FakeChain(), masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(masterDevice.record.walletAddress, 200_000, { confirmed: true })
    const master = await open(masterDevice, chain)
    const ticket = await issue(master, 'Gap Gale', 'SUPPLY_ASSISTANT', chain)
    const rotation = await master.rotateUnitKey()
    expect(rotation.recipients).toBe(1)
    await master.controller.addCatalogSizes(PT_SHORTS, ['L'])
    await master.syncNow(); chain.mine()
    const { device, runtime } = await redeemFresh(ticket.code, chain)
    expect(device.unitKeys.has(rotation.epochId)).toBe(true)
    expect(runtime.status().currentEpoch).toBe(rotation.epochId)
    expect((await runtime.controller.project()).inventory.some(item => item.catalogId === PT_SHORTS && item.variant === 'L')).toBe(true)
    // once redeemed, a later rotation no longer wraps to the ticket, only to the member
    await master.syncNow()
    const next = await master.rotateUnitKey()
    expect(next.recipients).toBe(2)
    const event = (await master.controller.project()).events.find(entry => entry.event.eventType === 'UNIT_KEY_ROTATED' && entry.event.entityId === next.epochId)!.event
    expect((event.payload.grants as { granteePublicIdentity: string }[]).map(grant => grant.granteePublicIdentity)).not.toContain(`ticket:${ticket.ticketId}`)
  })

  it('stays joining while the network does not answer, and finishes with the same redemption when it does', async () => {
    const chain = new FakeChain(), masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(masterDevice.record.walletAddress, 200_000, { confirmed: true })
    const master = await open(masterDevice, chain)
    const ticket = await issue(master, 'Pen Ding', 'INSTRUCTOR', chain)
    const { device, options } = await freshDevice(chain)
    chain.failNextBroadcasts('ambiguous', 3)
    const first = await redeemTicket(device, ticket.code, options)
    expect(first.status).toBe('PENDING')
    expect(device.record.role).toBe('PENDING')
    expect(device.record.unit).toBeUndefined()
    await expect(UnitRuntime.open(device, options)).rejects.toThrow(/not been admitted/)
    chain.clearInjectedFailures()
    const second = (await resumeTicketRedemption(device, options))!
    expect(second).toMatchObject({ status: 'ACTIVE', txid: first.txid })
    expect(second.device.record).toMatchObject({ role: 'INSTRUCTOR', displayName: 'Pen Ding' })
    const runtime = await UnitRuntime.open(second.device, options)
    await runtime.syncNow(); chain.mine(); await master.syncNow()
    expect((await master.controller.project()).members.find(member => member.publicIdentity === device.record.signingIdentity)).toMatchObject({ status: 'ACTIVE', role: 'INSTRUCTOR' })
    expect(await resumeTicketRedemption(second.device, options)).toBeUndefined()
  })
})
