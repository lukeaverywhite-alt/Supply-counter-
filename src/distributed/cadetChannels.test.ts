import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential, ticketRuleViolation } from '../auth/authorization'
import { channelAddress } from '../blockchain/anchor'
import { MockIdentityProvider } from '../identity/identity'
import { MemoryRepository, type RepositoryState } from '../storage/repository'
import { GENESIS_CATALOG } from '../stage3/domain'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { cadetViewFrom } from './cadetView'
import { ArgusReplica } from './replica'
import type { ArgusRole, SignedArgusEvent } from './types'

const root = new MockIdentityProvider('unit-root')
async function unit(roles: Record<string, ArgusRole>) {
  const authorization = new AuthorizationService(await root.getPublicIdentity(), new MockIdentityProvider('verifier'))
  const provider = new MockSyncProvider(), replicas: Record<string, ArgusReplica> = {}
  for (const [name, role] of Object.entries(roles)) {
    const identity = new MockIdentityProvider(name)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2020-01-01T00:00:00.000Z' }))
    replicas[name] = new ArgusReplica(new MemoryRepository(), identity, authorization, provider, 'unit-a', { genesisCatalog: true })
    await replicas[name].initialize(); replicas[name].online = false
  }
  return { replicas, authorization }
}
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)
const cadet = async (replica: ArgusReplica, input: { fullName?: string; cadetCode?: string; sizes?: Record<string, string> } = {}) => (await replica.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', ...input })).entityId
const channelOf = async (replica: ArgusReplica, cadetId: string) => (await replica.snapshot()).cadetChannels.find(channel => channel.cadetId === cadetId)
const hexBytes = (hex: string) => hex.length / 2
const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
/** Adds sizes to a genesis catalog item and receives stock; returns size label -> inventory ID. */
async function stock(replica: ArgusReplica, name: string, sizes: Record<string, number>) {
  await replica.addCatalogSizes(catalogId(name), Object.keys(sizes))
  const state = await replica.snapshot(), ids: Record<string, string> = {}
  for (const [label, quantity] of Object.entries(sizes)) { ids[label] = state.inventory.find(item => item.catalogId === catalogId(name) && item.variant === label)!.entityId; await replica.receiveStock(ids[label], quantity) }
  return ids
}
/** A signed event as `author`'s device could write it, past the command's checks: the fold must judge it on its own. */
async function forged(author: string, eventType: SignedArgusEvent['eventType'], entityId: string, payload: Record<string, unknown>, eventId: string) {
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'unit-a', eventVersion: 1 as const, eventId, eventType, entityId, actorPublicIdentity: `mock:${author}`, timestamp: '2026-10-03T12:00:00.000Z', clock: 1_000, payload }
  return { ...unsigned, signature: await new MockIdentityProvider(author).sign(canonicalize(unsigned)) } as SignedArgusEvent
}

describe('cadet channels in the unit log (ADR 013)', () => {
  it('a Master’s createCadetChannel folds into cadetChannels with a fresh 32-byte key and the address channelAddress(key) gives', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cadetId = await cadet(master, { cadetCode: 'C-4F7K' })
    const event = await master.createCadetChannel(cadetId)
    expect(event.eventType).toBe('CADET_CHANNEL_CREATED')
    const channel = await channelOf(master, cadetId)
    expect(channel).toMatchObject({ cadetId, version: 1, createdBy: 'mock:master', eventId: event.eventId })
    expect(channel!.channelKey).toMatch(/^[0-9a-f]{64}$/)
    expect(hexBytes(channel!.channelKey)).toBe(32)
    expect(channel!.channelAddress).toBe(channelAddress(channel!.channelKey))
    expect(channel!.channelAddress).toMatch(/^[mn]/)
    // A second cadet gets a different key and address; one cadet has one channel.
    const other = await cadet(master, { cadetCode: 'C-9J2Q' })
    await master.createCadetChannel(other)
    const second = await channelOf(master, other)
    expect(second!.channelKey).not.toBe(channel!.channelKey)
    expect(second!.channelAddress).not.toBe(channel!.channelAddress)
    await expect(master.createCadetChannel(cadetId)).rejects.toThrow(/already has a channel/)
    await expect(master.createCadetChannel('cadet_missing')).rejects.toThrow(/Cadet was not found/)
  })

  it('rotateCadetChannel replaces the key and the address and bumps the version; a cadet without a channel cannot be rotated', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cadetId = await cadet(master, { cadetCode: 'C-4F7K' })
    await expect(master.rotateCadetChannel(cadetId, 'Replace phone')).rejects.toThrow(/no channel/)
    await master.createCadetChannel(cadetId)
    const before = (await channelOf(master, cadetId))!
    const event = await master.rotateCadetChannel(cadetId, 'Replace phone')
    expect(event.eventType).toBe('CADET_CHANNEL_ROTATED')
    const after = (await channelOf(master, cadetId))!
    expect(after.version).toBe(2)
    expect(after.channelKey).not.toBe(before.channelKey)
    expect(after.channelAddress).not.toBe(before.channelAddress)
    expect(after.channelAddress).toBe(channelAddress(after.channelKey))
    expect(after).toMatchObject({ rotationReason: 'Replace phone', eventId: event.eventId, createdAt: before.createdAt })
    await master.rotateCadetChannel(cadetId, 'Lost phone')
    expect((await channelOf(master, cadetId))!.version).toBe(3)
    await expect(master.rotateCadetChannel(cadetId, '  ')).rejects.toThrow(/reason/)
  })

  it('createNoticesKey makes the unit’s one notices key; a second is refused', async () => {
    const { replicas: { master, officer } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER' })
    await master.createNoticesKey()
    const notices = (await master.snapshot()).noticesChannel!
    expect(notices.key).toMatch(/^[0-9a-f]{64}$/)
    expect(notices.address).toBe(channelAddress(notices.key))
    expect(notices.createdBy).toBe('mock:master')
    await expect(master.createNoticesKey()).rejects.toThrow(/already has a notices key/)
    await officer.receiveMany(await events(master))
    await expect(officer.createNoticesKey()).rejects.toThrow(/already has a notices key/)
  })

  it('a second notices key from another device, written offline, is refused by the fold on every device: the first in the unit’s order wins', async () => {
    const { replicas: { master, officer } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER' })
    await master.createNoticesKey({ eventId: 'notices-a' })
    await officer.createNoticesKey({ eventId: 'notices-b' })
    await master.receiveMany(await events(officer)); await officer.receiveMany(await events(master))
    const [a, b] = [await master.snapshot(), await officer.snapshot()]
    expect(canonicalize(a.noticesChannel)).toBe(canonicalize(b.noticesChannel))
    expect(a.rejected.map(record => record.reason)).toEqual([expect.stringMatching(/already has a notices key/)])
  })

  it('refuses a Supply Assistant and lets a Master, an Instructor and a Supply Officer admit cadets and send notices', async () => {
    const { replicas: { master, instructor, officer, assistant } } = await unit({ master: 'MASTER', instructor: 'INSTRUCTOR', officer: 'SUPPLY_OFFICER', assistant: 'SUPPLY_ASSISTANT' })
    const cadetIds = [await cadet(master, { cadetCode: 'C-AAAA' }), await cadet(master, { cadetCode: 'C-BBBB' }), await cadet(master, { cadetCode: 'C-CCCC' })]
    for (const replica of [instructor, officer, assistant]) await replica.receiveMany(await events(master))
    await expect(assistant.createCadetChannel(cadetIds[0])).rejects.toThrow(/Unauthorized: cadets\.admit is required/)
    await expect(assistant.createNoticesKey()).rejects.toThrow(/Unauthorized: notices\.send is required/)
    await instructor.createCadetChannel(cadetIds[1])
    await officer.createCadetChannel(cadetIds[2])
    await expect(assistant.rotateCadetChannel(cadetIds[1], 'Replace phone')).rejects.toThrow(/Unauthorized/)
    expect(ROLE_PERMISSIONS.MASTER).toEqual(expect.arrayContaining(['cadets.admit', 'notices.send']))
    expect(ROLE_PERMISSIONS.INSTRUCTOR).toEqual(expect.arrayContaining(['cadets.admit', 'notices.send']))
    expect(ROLE_PERMISSIONS.SUPPLY_OFFICER).toEqual(expect.arrayContaining(['cadets.admit', 'notices.send']))
    expect(ROLE_PERMISSIONS.SUPPLY_ASSISTANT).not.toContain('cadets.admit')
    expect(ROLE_PERMISSIONS.SUPPLY_ASSISTANT).not.toContain('notices.send')
  })

  it('a channel event from a Supply Assistant’s device is refused by the fold too, so no device holds that channel', async () => {
    // The assistant is a member in good standing; only the permission is missing.
    const { replicas: { master } } = await unit({ master: 'MASTER', assistant: 'SUPPLY_ASSISTANT' })
    const cadetId = await cadet(master, { cadetCode: 'C-4F7K' })
    const key = 'ab'.repeat(32)
    await master.receive(await forged('assistant', 'CADET_CHANNEL_CREATED', cadetId, { cadetId, channelKey: key, channelAddress: channelAddress(key) }, 'from-assistant'))
    const state = await master.snapshot()
    expect(state.cadetChannels).toEqual([])
    expect(state.rejected).toEqual([expect.objectContaining({ eventId: 'from-assistant', reason: 'Unauthorized: cadets.admit is required.' })])
  })

  it('the fold refuses a channel whose address is not derived from its key, a malformed key, a key already in use and an unknown cadet', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const [first, second] = [await cadet(master, { cadetCode: 'C-AAAA' }), await cadet(master, { cadetCode: 'C-BBBB' })]
    await master.createCadetChannel(first)
    const taken = (await channelOf(master, first))!.channelKey, key = 'cd'.repeat(32)
    const cases: Array<[string, string, Record<string, unknown>, RegExp]> = [
      ['wrong-address', second, { cadetId: second, channelKey: key, channelAddress: channelAddress('ef'.repeat(32)) }, /not derived from its key/],
      ['short-key', second, { cadetId: second, channelKey: 'ab'.repeat(16), channelAddress: channelAddress(key) }, /Corrupted cadet channel event/],
      ['entity-mismatch', first, { cadetId: second, channelKey: key, channelAddress: channelAddress(key) }, /Corrupted cadet channel event/],
      ['key-reused', second, { cadetId: second, channelKey: taken, channelAddress: channelAddress(taken) }, /already in use/],
      ['no-cadet', 'cadet_x', { cadetId: 'cadet_x', channelKey: key, channelAddress: channelAddress(key) }, /Cadet projection is missing/],
    ]
    for (const [eventId, entityId, payload] of cases) await master.receive(await forged('master', 'CADET_CHANNEL_CREATED', entityId, payload, eventId))
    const state = await master.snapshot()
    expect(state.cadetChannels.map(channel => channel.cadetId)).toEqual([first])
    for (const [eventId, , , reason] of cases) expect(state.rejected.find(record => record.eventId === eventId)?.reason).toMatch(reason)
  })

  it('two devices receiving channel, rotation and notices events in different orders end byte-identical', async () => {
    const { replicas: { master, officer, fresh } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER', fresh: 'SUPPLY_ASSISTANT' })
    const [first, second] = [await cadet(master, { cadetCode: 'C-AAAA' }), await cadet(master, { cadetCode: 'C-BBBB' })]
    await officer.receiveMany(await events(master))
    await master.createCadetChannel(first); await officer.createCadetChannel(second); await officer.createCadetChannel(first)
    await master.createNoticesKey(); await master.rotateCadetChannel(first, 'Replace phone')
    await officer.receiveMany(await events(master)); await master.receiveMany(await events(officer))
    await fresh.receiveMany([...(await events(officer))].reverse())
    const visible = (state: RepositoryState) => canonicalize({ cadetChannels: state.cadetChannels, noticesChannel: state.noticesChannel, rejected: state.rejected })
    const states = await Promise.all([master, officer, fresh].map(replica => replica.snapshot()))
    expect(visible(states[1])).toBe(visible(states[0])); expect(visible(states[2])).toBe(visible(states[0]))
    expect(states[0].cadetChannels.map(channel => [channel.cadetId, channel.version]).sort()).toEqual([[first, 2], [second, 1]].sort())
  })
})

const TESTNET_ADDRESS = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn'
/** A cadet ticket as the unit log records it (ADR 013, mw-kmgi38.2): no key, no code, no name. */
const cadetTicketFact = (cadetId: string, channel: string, ticketId = `t-${'a1'.repeat(10)}`, issuedAt = '2026-10-03T12:00:00.000Z', days = 7) => ({ ticketId, cadetId, ticketAddress: TESTNET_ADDRESS, channelAddress: channel, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + days * 24 * 60 * 60 * 1000).toISOString(), funding: { txid: 'b2'.repeat(32), vout: 0, satoshis: 500 } })

describe('cadet tickets in the unit log (CADET_TICKET_ISSUED, mw-kmgi38.2)', () => {
  it('a Master records a cadet ticket against the cadet’s channel; it is never a staff ticket', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const cadetId = await cadet(master, { cadetCode: 'C-4F7K' })
    await expect(master.recordCadetTicketIssued(cadetTicketFact(cadetId, TESTNET_ADDRESS))).rejects.toThrow(/no channel/)
    await master.createCadetChannel(cadetId)
    const channel = (await channelOf(master, cadetId))!
    const event = await master.recordCadetTicketIssued(cadetTicketFact(cadetId, channel.channelAddress))
    expect(event).toMatchObject({ eventType: 'CADET_TICKET_ISSUED', entityId: `t-${'a1'.repeat(10)}` })
    const state = await master.snapshot()
    expect(state.cadetTickets).toEqual([{ ...cadetTicketFact(cadetId, channel.channelAddress), issuedBy: 'mock:master', issuedEventId: event.eventId }])
    expect(state.tickets).toEqual([])
    await expect(master.recordCadetTicketIssued(cadetTicketFact(cadetId, channel.channelAddress))).rejects.toThrow(/already exists/)
  })

  it('the fold refuses a cadet ticket from a Supply Assistant, for a cadet with no channel or no record, malformed, or longer than a week', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER', assistant: 'SUPPLY_ASSISTANT' })
    const [first, second] = [await cadet(master, { cadetCode: 'C-AAAA' }), await cadet(master, { cadetCode: 'C-BBBB' })]
    await master.createCadetChannel(first)
    const address = (await channelOf(master, first))!.channelAddress, id = (n: number) => `t-${String(n).padStart(20, '0')}`
    const cases: Array<[string, string, string, Record<string, unknown>, RegExp]> = [
      ['from-assistant', 'assistant', id(1), cadetTicketFact(first, address, id(1)), /Unauthorized: cadets\.admit is required/],
      ['no-channel', 'master', id(2), cadetTicketFact(second, address, id(2)), /no channel/],
      ['no-cadet', 'master', id(3), cadetTicketFact('cadet_x', address, id(3)), /Cadet projection is missing/],
      ['too-long', 'master', id(4), cadetTicketFact(first, address, id(4), undefined, 8), /within a week/],
      ['entity-mismatch', 'master', id(9), cadetTicketFact(first, address, id(5)), /Corrupted cadet ticket event/],
      ['bad-address', 'master', id(6), { ...cadetTicketFact(first, address, id(6)), ticketAddress: 'not-an-address' }, /Invalid CADET_TICKET_ISSUED fact field: ticketAddress/],
    ]
    for (const [eventId, author, entityId, payload] of cases) await master.receive(await forged(author, 'CADET_TICKET_ISSUED', entityId, payload, eventId))
    const state = await master.snapshot()
    expect(state.cadetTickets).toEqual([])
    for (const [eventId, , , , reason] of cases) expect(state.rejected.find(record => record.eventId === eventId)?.reason).toMatch(reason)
  })

  it('two devices receiving channel, rotation and cadet ticket events in different orders end byte-identical', async () => {
    const { replicas: { master, officer, fresh } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER', fresh: 'SUPPLY_ASSISTANT' })
    const [first, second] = [await cadet(master, { cadetCode: 'C-AAAA' }), await cadet(master, { cadetCode: 'C-BBBB' })]
    await master.createCadetChannel(first); await master.createCadetChannel(second)
    await officer.receiveMany(await events(master))
    const address = async (cadetId: string) => (await channelOf(master, cadetId))!.channelAddress
    await master.recordCadetTicketIssued(cadetTicketFact(first, await address(first), `t-${'01'.repeat(10)}`))
    await officer.recordCadetTicketIssued(cadetTicketFact(second, (await channelOf(officer, second))!.channelAddress, `t-${'02'.repeat(10)}`))
    // the same ticket ID written on two devices offline: the first in the unit's order holds
    await officer.recordCadetTicketIssued(cadetTicketFact(second, (await channelOf(officer, second))!.channelAddress, `t-${'01'.repeat(10)}`))
    await master.rotateCadetChannel(first, 'Replace phone')
    await master.recordCadetTicketIssued(cadetTicketFact(first, await address(first), `t-${'03'.repeat(10)}`))
    await officer.receiveMany(await events(master)); await master.receiveMany(await events(officer))
    await fresh.receiveMany([...(await events(officer))].reverse())
    const visible = (state: RepositoryState) => canonicalize({ cadetChannels: state.cadetChannels, cadetTickets: state.cadetTickets, rejected: state.rejected })
    const states = await Promise.all([master, officer, fresh].map(replica => replica.snapshot()))
    expect(visible(states[1])).toBe(visible(states[0])); expect(visible(states[2])).toBe(visible(states[0]))
    expect(states[0].cadetTickets.map(ticket => ticket.ticketId).sort()).toEqual([`t-${'01'.repeat(10)}`, `t-${'02'.repeat(10)}`, `t-${'03'.repeat(10)}`])
    expect(states[0].rejected.map(record => record.reason)).toEqual([expect.stringMatching(/already exists/)])
  })
})

describe('the CADET role: outside the unit log', () => {
  it('has no unit permissions, cannot be granted as a unit credential and gets no staff ticket', async () => {
    expect(ROLE_PERMISSIONS.CADET).toEqual([])
    const authorization = new AuthorizationService(await root.getPublicIdentity(), new MockIdentityProvider('verifier'))
    await expect(authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: 'mock:cadet', role: 'CADET', permissions: [], issuedAt: '2020-01-01T00:00:00.000Z' }))).rejects.toThrow(/cadet never joins the unit/i)
    expect(ticketRuleViolation('MASTER', 'CADET')).toMatch(/cadet’s record/)
    expect(ticketRuleViolation('INSTRUCTOR', 'CADET')).toMatch(/cadet’s record/)
  })
})

describe('cadetViewFor: what a cadet’s own record shows, built from the fold', () => {
  it('after CADET_CREATED, two ITEM_ISSUED, one ITEM_RETURNED and one STILL_NEEDED_ADDED lists exactly the right Have and Still-needed lines', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const shorts = await stock(master, 'PT Shorts', { S: 4, M: 4 }), shirts = await stock(master, 'Gold PT Shirt', { L: 3 })
    const cadetId = await cadet(master, { fullName: 'Jordan Rivera', cadetCode: 'C-4F7K', sizes: { 'PT Shorts': 'M', 'Gold PT Shirt': 'L' } })
    const firstIssue = await master.issueTransaction({ transactionId: 'issue-1', cadetId, lines: [{ lineId: 'shorts', itemId: shorts.M, quantity: 2 }, { lineId: 'shirt', itemId: shirts.L, quantity: 1 }] }, { timestamp: '2026-09-01T10:00:00.000Z' })
    await master.issueTransaction({ transactionId: 'issue-2', cadetId, lines: [{ lineId: 'shorts', itemId: shorts.S, quantity: 1 }] }, { timestamp: '2026-09-02T10:00:00.000Z' })
    const shirtHolding = (await master.snapshot()).cadets.find(c => c.cadetId === cadetId)!.currentProperty.find(line => line.itemId === shirts.L)!
    await master.returnTransaction({ transactionId: 'return-1', cadetId, lines: [{ lineId: 'shirt', propertyId: shirtHolding.propertyId, quantity: 1 }] })
    await master.addStillNeeded({ requirementId: 'need-cover', cadetId, displayLabel: 'Combination Cover', size: '7 1/4', quantityNeeded: 2, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-03T00:00:00.000Z', source: 'MANUAL' })
    const state = await master.snapshot(), projection = state.cadets.find(c => c.cadetId === cadetId)!, need = state.stillNeeded.find(n => n.requirementId === 'need-cover')!
    const view = await master.cadetViewFor(cadetId)
    expect(view).toEqual({
      cadetId, cadetCode: 'C-4F7K', fullName: 'Jordan Rivera', sizes: { 'PT Shorts': 'M', 'Gold PT Shirt': 'L' },
      have: [
        { itemId: shorts.M, label: 'PT Shorts', size: 'M', quantity: 2, issuedAt: firstIssue.timestamp },
        { itemId: shorts.S, label: 'PT Shorts', size: 'S', quantity: 1, issuedAt: '2026-09-02T10:00:00.000Z' },
      ],
      stillNeeded: [{ label: 'Combination Cover', size: '7 1/4', quantity: 2 }],
      version: projection.version + need.version,
      updatedAt: [projection.updatedAt, need.updatedAt].sort().at(-1),
    })
    // The cadet's version counts every folded change to the cadet (create, two issues, a return); the record adds its Still Needed lines'.
    expect(projection.version).toBe(4)
    expect(view.version).toBe(5)
  })

  it('carries nothing else: no gender, level, status, notes, staff names or record IDs; closed and fulfilled needs drop out', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    const shorts = await stock(master, 'PT Shorts', { M: 2 })
    const cadetId = await cadet(master, { cadetCode: 'C-4F7K' })
    await master.addStillNeeded({ requirementId: 'need-shorts', cadetId, displayLabel: 'PT Shorts', size: 'M', quantityNeeded: 2, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-03T00:00:00.000Z', source: 'MANUAL' })
    await master.addStillNeeded({ requirementId: 'need-cap', cadetId, displayLabel: 'Ball Cap', quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-09-03T00:00:00.000Z', source: 'MANUAL' })
    const before = await master.cadetViewFor(cadetId)
    await master.cancelStillNeeded('need-cap', 'Not needed this year')
    await master.issueTransaction({ transactionId: 'issue-1', cadetId, lines: [{ lineId: 'shorts', itemId: shorts.M, quantity: 1, requirementId: 'need-shorts' }] }, { timestamp: '2026-09-04T10:00:00.000Z' })
    const view = await master.cadetViewFor(cadetId)
    expect(Object.keys(view).sort()).toEqual(['cadetCode', 'cadetId', 'fullName', 'have', 'sizes', 'stillNeeded', 'updatedAt', 'version'])
    expect(Object.keys(view.have[0]).sort()).toEqual(['issuedAt', 'itemId', 'label', 'quantity', 'size'])
    expect(view.stillNeeded).toEqual([{ label: 'PT Shorts', size: 'M', quantity: 1 }])
    expect(view.fullName).toBe('')
    // Each change to the cadet's record, including a Still Needed change alone, raises the record's version.
    expect(view.version).toBeGreaterThan(before.version)
    const cancelledOnly = await master.cadetViewFor(cadetId)
    await master.updateStillNeeded('need-shorts', { quantityNeeded: 3 })
    expect((await master.cadetViewFor(cadetId)).version).toBe(cancelledOnly.version + 1)
    await expect(master.cadetViewFor('cadet_missing')).rejects.toThrow(/Cadet was not found/)
  })

  it('is a pure function of the fold: two devices with the same events build the same record', async () => {
    const { replicas: { master, officer } } = await unit({ master: 'MASTER', officer: 'SUPPLY_OFFICER' })
    const shorts = await stock(master, 'PT Shorts', { M: 2 })
    const cadetId = await cadet(master, { fullName: 'Sam Lee', cadetCode: 'C-4F7K' })
    await master.issueTransaction({ transactionId: 'issue-1', cadetId, lines: [{ lineId: 'shorts', itemId: shorts.M, quantity: 1 }] })
    await officer.receiveMany([...(await events(master))].reverse())
    expect(canonicalize(cadetViewFrom(await officer.snapshot(), cadetId))).toBe(canonicalize(await master.cadetViewFor(cadetId)))
  })
})
