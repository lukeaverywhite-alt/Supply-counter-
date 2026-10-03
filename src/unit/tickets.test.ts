import { beforeAll, describe, expect, it } from 'vitest'
import { decodeArgusRecords } from '../chain/codec'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { DeviceWallet, InsufficientFundsError } from '../chain/wallet'
import { canonicalize } from '../distributed/canonical'
import { decodeTicketCode } from '../identity/ticketCode'
import { deriveTicketKeys } from '../identity/ticketKeys'
import { TICKET_CHAIN_RECORD_FIELDS, TICKET_LIFETIME_MS, parseTicketCancellation, parseTicketPackage } from '../private-sync/schema'
import { openTicketRecord } from '../private-sync/ticketRecord'
import { Transaction } from '@bsv/sdk'
import { MemoryLedgerStore } from './ledgerStore'
import { DEFAULT_MEMBER_TOP_UP_SATOSHIS, UnitRuntime } from './runtime'
import { joinByTicket } from '../test/joinByTicket'
import { createMasterDevice, rawUnitKeys, readTicketSecret, type UnlockedDevice } from './vault'
import type { ArgusRole } from '../distributed/types'

const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
const open = (device: UnlockedDevice, chain: FakeChain) => UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() })
const DAY = 24 * 60 * 60 * 1000

async function join(master: UnitRuntime, chain: FakeChain, name: string, role: ArgusRole, satoshis = 30_000) {
  const { runtime, device } = await joinByTicket(master, chain, name, role, { satoshis })
  await runtime.syncNow(); await master.syncNow(); chain.mine()
  return { runtime, device }
}

/** Issues a ticket and lets the device publish it, as the running app does a moment later. */
async function issue(runtime: UnitRuntime, ...args: Parameters<UnitRuntime['issueTicket']>) { const ticket = await runtime.issueTicket(...args); await runtime.syncNow(); return ticket }

/** Every `T` record paid to a ticket address, oldest first. */
async function ticketRecords(chain: FakeChain, address: string) {
  const txids = [...(await chain.confirmedHistory(address)).items.map(item => item.txid), ...await chain.unconfirmedHistory(address)]
  return txids.flatMap(txid => decodeArgusRecords(chain.get(txid)!.hex).filter(record => record.kind === 'T').map(record => ({ txid, payload: record.payload })))
}
const openPackage = async (code: string, chain: FakeChain) => {
  const keys = await deriveTicketKeys(decodeTicketCode(code)), [first] = await ticketRecords(chain, keys.address)
  return { keys, record: parseTicketPackage(await openTicketRecord(keys.wrappingKey, keys.address, first.payload)), txid: first.txid }
}

describe('issuing and cancelling admission tickets (ADR 012)', { timeout: 180_000 }, () => {
  const chain = new FakeChain()
  let masterDevice: UnlockedDevice, master: UnitRuntime, instructor: UnitRuntime, instructorDevice: UnlockedDevice, officer: UnitRuntime
  beforeAll(async () => {
    masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, storage())
    chain.fund(masterDevice.record.walletAddress, 400_000, { confirmed: true })
    master = await open(masterDevice, chain)
    ;({ runtime: instructor, device: instructorDevice } = await join(master, chain, 'Lt Jones', 'INSTRUCTOR'))
    ;({ runtime: officer } = await join(master, chain, 'Officer B', 'SUPPLY_OFFICER'))
  })

  it('lets a Master issue a MASTER, INSTRUCTOR and SUPPLY_ASSISTANT ticket, each signed, funded, and published to its own address', async () => {
    for (const role of ['MASTER', 'INSTRUCTOR', 'SUPPLY_ASSISTANT'] as const) {
      const before = Date.now(), ticket = await issue(master, 'Chris Cadet', role)
      expect(ticket).toMatchObject({ role, displayName: 'Chris Cadet', ticketId: expect.stringMatching(/^t-[0-9a-f]{20}$/), code: expect.stringMatching(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/) })
      const { keys, record, txid } = await openPackage(ticket.code, chain)
      // the invitation is the Master's own, signed with the unit authority key (as the old admission is)
      const { invitation } = record, { signature, ...unsigned } = invitation
      expect(invitation).toMatchObject({ ticketId: ticket.ticketId, unitId: masterDevice.record.unit!.unitId, displayName: 'Chris Cadet', role, ticketPublicKey: keys.publicIdentity, issuedBy: masterDevice.record.unit!.authorityIdentity, funding: { vout: 0, satoshis: DEFAULT_MEMBER_TOP_UP_SATOSHIS } })
      expect(await masterDevice.identity.verify(canonicalize(unsigned), signature, invitation.issuedBy)).toBe(true)
      expect(await masterDevice.identity.verify(canonicalize({ ...unsigned, role: 'MASTER' }), signature, invitation.issuedBy)).toBe(role === 'MASTER')
      // expires exactly one week after it was issued, and it was issued just now
      expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.issuedAt)).toBe(TICKET_LIFETIME_MS)
      expect(Date.parse(invitation.issuedAt)).toBeGreaterThanOrEqual(before - 1)
      expect(ticket.expiresAt).toBe(invitation.expiresAt)
      // the unit's keys travel in it, the issuer's credential chain is empty because the authority signed, and the unit is named
      expect(record.epochKeys).toEqual(await rawUnitKeys(masterDevice))
      // and they really are the unit's keys: the first one is the key the Master encrypts the unit's history with
      expect(Buffer.from(record.epochKeys[0].key, 'base64url')).toEqual(Buffer.from(await crypto.subtle.exportKey('raw', masterDevice.unitKeys.get(record.epochKeys[0].epochId)!)))
      expect(record.currentEpoch).toBe(masterDevice.record.unit!.currentEpoch)
      expect(record.issuerCredentials).toEqual([])
      expect(record.unit).toEqual({ unitId: masterDevice.record.unit!.unitId, unitName: 'Bethel NJROTC', authorityIdentity: masterDevice.record.unit!.authorityIdentity })
      expect(record.issuerDisplayName).toBe('Chief')
      expect(JSON.parse(record.ticketEcdhPrivateKey)).toMatchObject({ kty: 'EC', crv: 'P-256' })
      // the funding output is the first output of a transaction that pays the ticket address its starter satoshis
      expect(Transaction.fromHex(chain.get(invitation.funding.txid)!.hex).outputs[0].lockingScript.toHex()).toBe(Transaction.fromHex(chain.get(txid)!.hex).outputs[1].lockingScript.toHex())
      expect(chain.spenderOf(invitation.funding.txid, 0)).toBeUndefined()
    }
    await master.syncNow()
    const listed = (await master.tickets()).filter(entry => entry.status === 'open')
    expect(listed.map(entry => [entry.role, entry.status, entry.daysLeft])).toEqual([['MASTER', 'open', 7], ['INSTRUCTOR', 'open', 7], ['SUPPLY_ASSISTANT', 'open', 7]])
  })

  it('shows nothing about the ticket on chain in the clear: no name, no code, no keys, only version, nonce and ciphertext', async () => {
    const ticket = await issue(master, 'Zebediah Quux', 'SUPPLY_OFFICER')
    await master.syncNow(); chain.mine()
    const keys = await deriveTicketKeys(decodeTicketCode(ticket.code)), [{ payload }] = await ticketRecords(chain, keys.address)
    expect(Object.keys(JSON.parse(new TextDecoder().decode(payload))).sort()).toEqual([...TICKET_CHAIN_RECORD_FIELDS].sort())
    const secrets = [new TextEncoder().encode('Zebediah'), new TextEncoder().encode(ticket.code), new TextEncoder().encode(ticket.code.replaceAll('-', ''))]
    const hexes = chain.transactions().map(tx => tx.hex)
    for (const secret of secrets) { const needle = Buffer.from(secret).toString('hex'); expect(hexes.filter(hex => hex.includes(needle))).toEqual([]) }
    // the unit's own history names the person only inside ciphertext too
    expect(chain.transactions().some(tx => tx.hex.includes(Buffer.from('Zebediah').toString('hex')))).toBe(false)
  })

  it('records TICKET_ISSUED in the unit stream so every device sees the ticket, and keeps the ticket secret sealed in the issuer’s vault', async () => {
    const ticket = await issue(master, 'Dana Dee', 'SUPPLY_ASSISTANT')
    await master.syncNow(); chain.mine(); await officer.syncNow()
    const seen = (await officer.controller.project()).tickets.find(entry => entry.ticketId === ticket.ticketId)
    expect(seen).toMatchObject({ displayName: 'Dana Dee', role: 'SUPPLY_ASSISTANT', status: 'OPEN', ticketAddress: ticket.ticketAddress, issuedBy: masterDevice.record.signingIdentity })
    expect(JSON.stringify(seen)).not.toContain(ticket.code)
    expect(await readTicketSecret(masterDevice, ticket.ticketId)).toBe(ticket.code)
    expect(JSON.stringify(masterDevice.record)).not.toContain(ticket.code)
    expect(await readTicketSecret(instructorDevice, ticket.ticketId)).toBeUndefined()
  })

  it('lets an Instructor issue a SUPPLY_ASSISTANT ticket with the Instructor’s own key and credential, and refuses a MASTER and an INSTRUCTOR one naming the rule', async () => {
    const ticket = await issue(instructor, 'Eli Eff', 'SUPPLY_ASSISTANT')
    const { record } = await openPackage(ticket.code, chain), { signature, ...unsigned } = record.invitation
    expect(record.invitation.issuedBy).toBe(instructorDevice.record.signingIdentity)
    expect(await instructorDevice.identity.verify(canonicalize(unsigned), signature, record.invitation.issuedBy)).toBe(true)
    expect(record.issuerCredentials).toEqual([instructorDevice.record.credential])
    // the Instructor’s unit keys are not extractable on the device, yet the ticket carries them
    expect(record.epochKeys).toEqual(await rawUnitKeys(instructorDevice))

    const pendingBefore = (await instructor.wallet.pending()).length, secretsBefore = Object.keys(instructorDevice.record.secrets).sort()
    await expect(instructor.issueTicket('Fay Gee', 'MASTER')).rejects.toThrow(/Instructor can make tickets only for Supply Officers and Supply Assistants/)
    await expect(instructor.issueTicket('Fay Gee', 'INSTRUCTOR')).rejects.toThrow(/Only a Master can make a Master or Instructor ticket/)
    // a refused ticket costs nothing and leaves nothing behind
    expect((await instructor.wallet.pending()).length).toBe(pendingBefore)
    expect(Object.keys(instructorDevice.record.secrets).sort()).toEqual(secretsBefore)
    expect((await instructor.tickets()).map(entry => entry.displayName)).toContain('Eli Eff')
    expect((await instructor.tickets()).map(entry => entry.displayName)).not.toContain('Fay Gee')

    // the Master sees the Instructor’s ticket in the same list, but cannot cancel it: only its maker's device holds the key
    await instructor.syncNow(); chain.mine(); await master.syncNow()
    const there = (await master.tickets()).find(entry => entry.displayName === 'Eli Eff')
    expect(there).toMatchObject({ status: 'open', issuedBy: instructorDevice.record.signingIdentity })
    await expect(master.cancelTicket(there!.ticketId)).rejects.toThrow(/Only the person who made a ticket can cancel it/)
  })

  it('does not let a Supply Officer make a ticket at all', async () => {
    await expect(officer.issueTicket('Gus Haw', 'SUPPLY_ASSISTANT')).rejects.toThrow(/Only a Master or an Instructor can make tickets/)
  })

  it('refuses an empty or over-long name before anything is spent', async () => {
    const pending = (await master.wallet.pending()).length
    await expect(master.issueTicket('   ', 'SUPPLY_ASSISTANT')).rejects.toThrow(/name/)
    await expect(master.issueTicket('x'.repeat(61), 'SUPPLY_ASSISTANT')).rejects.toThrow(/name/)
    expect((await master.wallet.pending()).length).toBe(pending)
  })

  it('cancels a ticket: the funding output is spent by a TICKET_CANCELLED record at the ticket address, the starter satoshis come back, and the list shows cancelled', async () => {
    const ticket = await issue(master, 'Cy Pee', 'SUPPLY_OFFICER')
    await master.syncNow(); chain.mine()
    const balanceBefore = (await master.balance()).spendable
    const cancelled = await master.cancelTicket(ticket.ticketId)
    expect(cancelled.status).toBe('CANCELLED')
    const { keys, record } = await openPackage(ticket.code, chain)
    expect(chain.spenderOf(record.invitation.funding.txid, 0)).toBe(cancelled.txid)
    const records = await ticketRecords(chain, keys.address)
    expect(records.map(entry => entry.txid)).toContain(cancelled.txid)
    const cancellation = parseTicketCancellation(await openTicketRecord(keys.wrappingKey, keys.address, records.find(entry => entry.txid === cancelled.txid)!.payload)), { signature, ...unsigned } = cancellation
    expect(cancellation).toMatchObject({ ticketId: ticket.ticketId, unitId: masterDevice.record.unit!.unitId, reason: 'CANCELLED', issuedBy: record.invitation.issuedBy })
    expect(await masterDevice.identity.verify(canonicalize(unsigned), signature, cancellation.issuedBy)).toBe(true)
    // the leftover came back to the wallet (the ticket cost fees only), and the unit stream says so
    expect((await master.balance()).spendable).toBeGreaterThan(balanceBefore + DEFAULT_MEMBER_TOP_UP_SATOSHIS - 50)
    await master.syncNow(); chain.mine(); await officer.syncNow()
    for (const runtime of [master, officer]) expect((await runtime.tickets()).find(entry => entry.ticketId === ticket.ticketId)).toMatchObject({ status: 'cancelled', daysLeft: 0, cancelReason: 'CANCELLED', spendTxid: cancelled.txid })
    expect(await readTicketSecret(masterDevice, ticket.ticketId)).toBeUndefined()
    await expect(master.cancelTicket(ticket.ticketId)).rejects.toThrow(/already cancelled/)
    await expect(master.cancelTicket('t-00000000000000000000')).rejects.toThrow(/not in this unit/)
  })

  it('shows days left counting down and marks a ticket expired once past its expiry, on the viewer’s clock', async () => {
    const ticket = await issue(master, 'Di Kay', 'SUPPLY_ASSISTANT'), issued = Date.parse(ticket.expiresAt) - TICKET_LIFETIME_MS
    const at = async (ms: number) => (await master.tickets(new Date(ms))).find(entry => entry.ticketId === ticket.ticketId)!
    expect(await at(issued)).toMatchObject({ status: 'open', daysLeft: 7 })
    expect(await at(issued + 2 * DAY)).toMatchObject({ status: 'open', daysLeft: 5 })
    expect(await at(issued + 6.5 * DAY)).toMatchObject({ status: 'open', daysLeft: 1 })
    expect(await at(issued + 7 * DAY)).toMatchObject({ status: 'expired', daysLeft: 0 })
    expect(await at(issued + 30 * DAY)).toMatchObject({ status: 'expired', daysLeft: 0 })
  })

  it('records the reason when a device sweeps a ticket that ran out (reason EXPIRED), so its satoshis are not stranded', async () => {
    const ticket = await issue(master, 'Ed Ell', 'SUPPLY_ASSISTANT')
    const swept = await master.cancelTicket(ticket.ticketId, 'EXPIRED')
    expect(swept.status).toBe('CANCELLED')
    expect((await master.tickets()).find(entry => entry.ticketId === ticket.ticketId)).toMatchObject({ status: 'cancelled', cancelReason: 'EXPIRED' })
  })

  it('says plainly that a cancellation lost the race when the ticket’s funding was already spent', async () => {
    const ticket = await issue(master, 'Flo Em', 'SUPPLY_ASSISTANT')
    await master.syncNow(); chain.mine()
    const { keys, record } = await openPackage(ticket.code, chain)
    // someone holding the code redeems first: its transaction spends the funding output
    const wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    await wallet.prepareSpendOfOutpoint({ key: keys.privateKey, outpoint: record.invitation.funding, records: [{ kind: 'T', payload: Uint8Array.of(1) }], markerAddress: keys.address, correlationIds: [] })
    await wallet.flush()
    await expect(master.cancelTicket(ticket.ticketId)).rejects.toThrow(/network refused it.*already been used/)
    expect((await master.tickets()).find(entry => entry.ticketId === ticket.ticketId)?.status).toBe('open')
    // nothing is left queued to fail again and again
    expect((await master.wallet.pending()).filter(tx => tx.correlationIds.includes(`cancel:${ticket.ticketId}`))).toEqual([])
  })
})

describe('tickets when the money or the network is not there', { timeout: 180_000 }, () => {
  it('refuses to issue when the wallet cannot pay for the ticket, and leaves nothing behind: no fact, no sealed secret, no queued transaction', async () => {
    const chain = new FakeChain(), device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    const master = await open(device, chain), secrets = Object.keys(device.record.secrets).sort()
    await expect(master.issueTicket('Gil Aitch', 'SUPPLY_ASSISTANT')).rejects.toBeInstanceOf(InsufficientFundsError)
    await expect(master.issueTicket('Gil Aitch', 'SUPPLY_ASSISTANT')).rejects.toThrow(/testnet wallet .* spendable satoshis/)
    expect(await master.tickets()).toEqual([])
    expect(Object.keys(device.record.secrets).sort()).toEqual(secrets)
    expect(await master.wallet.pending()).toEqual([])
    expect((await master.controller.project()).events.filter(record => record.event.eventType === 'TICKET_ISSUED')).toEqual([])
    // funds that cover the starter satoshis but not the fees are not enough either
    chain.fund(device.record.walletAddress, DEFAULT_MEMBER_TOP_UP_SATOSHIS + 1, { confirmed: true })
    await expect(master.issueTicket('Gil Aitch', 'SUPPLY_ASSISTANT')).rejects.toBeInstanceOf(InsufficientFundsError)
    expect(await master.wallet.pending()).toEqual([])
  })

  it('keeps the funding, the ticket record and the fact queued while the network is unreachable, and sends them in order when it returns', async () => {
    const chain = new FakeChain(), device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(device.record.walletAddress, 100_000, { confirmed: true })
    const master = await open(device, chain)
    chain.failNextBroadcasts('ambiguous', 50)
    const ticket = await master.issueTicket('Hal Eye', 'SUPPLY_OFFICER')
    await master.syncNow()
    // listed at once for the person who made it, but nothing reached the network yet
    expect((await master.tickets()).map(entry => entry.status)).toEqual(['open'])
    expect((await master.wallet.pending()).length).toBeGreaterThanOrEqual(2)
    expect(await ticketRecords(chain, ticket.ticketAddress)).toEqual([])
    const fact = (await master.controller.project()).events.find(record => record.event.eventType === 'TICKET_ISSUED')!
    expect(fact.syncStatus).not.toBe('SYNCHRONIZED')
    expect(master.status().queued).toBeGreaterThan(0)
    // the network comes back
    chain.clearInjectedFailures()
    await master.syncNow(); await master.syncNow(); chain.mine(); await master.syncNow()
    expect(await master.wallet.pending()).toEqual([])
    const { record } = await openPackage(ticket.code, chain)
    expect(record.invitation.ticketId).toBe(ticket.ticketId)
    expect(chain.balanceOf(ticket.ticketAddress)).toBe(DEFAULT_MEMBER_TOP_UP_SATOSHIS + 1)
    expect((await master.controller.project()).events.find(entry => entry.event.eventType === 'TICKET_ISSUED')!.syncStatus).toBe('SYNCHRONIZED')
    expect(master.status().queued).toBe(0)
  })

  it('cancels later when the network was unreachable, without building a second cancellation', async () => {
    const chain = new FakeChain(), device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(device.record.walletAddress, 100_000, { confirmed: true })
    const master = await open(device, chain)
    const ticket = await issue(master, 'Ivy Jay', 'SUPPLY_OFFICER'); chain.mine()
    chain.failNextBroadcasts('ambiguous', 5)
    const first = await master.cancelTicket(ticket.ticketId)
    expect(first.status).toBe('PENDING')
    expect((await master.tickets())[0].status).toBe('open')
    chain.clearInjectedFailures()
    const second = await master.cancelTicket(ticket.ticketId)
    expect(second).toEqual({ status: 'CANCELLED', txid: first.txid })
    expect((await master.tickets())[0]).toMatchObject({ status: 'cancelled', spendTxid: first.txid })
  })

  it('lets a delegated Master issue cadet and Instructor tickets with its own key, but not a Master ticket (only the authority makes Masters)', async () => {
    const chain = new FakeChain(), device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
    const master = await open(device, chain)
    const { runtime: second, device: secondDevice } = await join(master, chain, 'Second Master', 'MASTER', 50_000)
    expect(secondDevice.authoritySigner).toBeUndefined()
    const ticket = await issue(second, 'Jo Kay', 'INSTRUCTOR')
    const { record } = await openPackage(ticket.code, chain), { signature, ...unsigned } = record.invitation
    expect(record.invitation.issuedBy).toBe(secondDevice.record.signingIdentity)
    expect(await secondDevice.identity.verify(canonicalize(unsigned), signature, record.invitation.issuedBy)).toBe(true)
    expect(record.issuerCredentials).toEqual([secondDevice.record.credential])
    await expect(second.issueTicket('Jo Kay', 'MASTER')).rejects.toThrow(/Only the unit authority/)
    expect((await second.tickets()).filter(entry => entry.status === 'open').map(entry => entry.role)).toEqual(['INSTRUCTOR'])
  })
})
