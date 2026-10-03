import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential, ticketCredential } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { makeTicketSecret } from '../identity/ticketCode'
import { deriveTicketKeys, signWithTicketKey } from '../identity/ticketKeys'
import { TICKET_LIFETIME_MS } from '../private-sync/schema'
import type { TicketCancelledFact, TicketIssuedFact, TicketRedeemedFact } from '../private-sync/types'
import { listTickets } from '../private-sync/tickets'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { canonicalize } from './canonical'
import { ArgusReplica } from './replica'
import type { ArgusRole, SignedArgusEvent } from './types'

const ISSUED_AT = '2026-10-02T12:00:00.000Z'
const expires = (issuedAt = ISSUED_AT) => new Date(Date.parse(issuedAt) + TICKET_LIFETIME_MS).toISOString()
const TXID = 'ab'.repeat(32), WALLET = 'mrcNu71ztWjAQA6ww9kHiW3zBWSQidHXTQ'

const root = new MockIdentityProvider('unit-root')
async function unit(roles: Record<string, ArgusRole>) {
  const verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const provider = new MockSyncProvider(), replicas: Record<string, ArgusReplica> = {}, identities: Record<string, MockIdentityProvider> = {}
  for (const [name, role] of Object.entries(roles)) {
    identities[name] = new MockIdentityProvider(name)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identities[name].getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: '2020-01-01T00:00:00.000Z' }))
    replicas[name] = new ArgusReplica(new MemoryRepository(), identities[name], authorization, provider, 'unit-a', { genesisCatalog: true })
    await replicas[name].initialize(); replicas[name].online = false
  }
  return { replicas, identities, authorization }
}
const issued = (ticketId: string, role: ArgusRole, overrides: Partial<TicketIssuedFact> = {}): TicketIssuedFact => ({ ticketId, ticketAddress: WALLET, ticketEcdhPublicKey: 'spki', displayName: 'Chris Cadet', role, issuedAt: ISSUED_AT, expiresAt: expires(), funding: { txid: TXID, vout: 0, satoshis: 2000 }, ...overrides })
const cancelled = (ticketId: string, reason: TicketCancelledFact['reason'] = 'CANCELLED'): TicketCancelledFact => ({ ticketId, reason, cancelledAt: '2026-10-03T12:00:00.000Z', spendTxid: 'cd'.repeat(32) })
/** A genuine redemption: the invitation signed by the unit authority, the redemption by the ticket key, binding `subject`. */
async function redeemed(fact: TicketIssuedFact, subject: string): Promise<TicketRedeemedFact> {
  const keys = await deriveTicketKeys(makeTicketSecret())
  const invitation = { invitationVersion: 1 as const, ticketId: fact.ticketId, unitId: 'unit-a', displayName: fact.displayName, role: fact.role, issuedAt: fact.issuedAt, expiresAt: fact.expiresAt, ticketPublicKey: keys.publicIdentity, funding: fact.funding, issuedBy: await root.getPublicIdentity() }
  const redemption = { kind: 'TICKET_REDEEMED' as const, redemptionVersion: 1 as const, ticketId: fact.ticketId, unitId: 'unit-a', subjectPublicIdentity: subject, ecdhPublicKey: 'spki', walletAddress: WALLET, redeemedAt: '2026-10-04T12:00:00.000Z' }
  return { ticketId: fact.ticketId, invitation: { ...invitation, signature: await root.sign(canonicalize(invitation)) }, issuerCredentials: [], redemption: { ...redemption, signature: signWithTicketKey(keys.privateKey, canonicalize(redemption)) } }
}
/** What the sync provider does for a redemption that came in the spend of its ticket: the verifier checks and holds its credential. */
async function proven(authorization: AuthorizationService, fact: TicketRedeemedFact) { await authorization.acceptCredential(ticketCredential(fact)); return fact }
const id = (n: number) => `t-${String(n).padStart(20, '0')}`
const events = async (replica: ArgusReplica) => (await replica.snapshot()).events.map(record => record.event)

describe('tickets in the unit stream: who may make one, and what the unit then lists', () => {
  it('lets a Master issue a MASTER, INSTRUCTOR and SUPPLY_ASSISTANT ticket, and lists each as open', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    for (const [n, role] of (['MASTER', 'INSTRUCTOR', 'SUPPLY_ASSISTANT'] as const).entries()) await master.recordTicketIssued(issued(id(n), role))
    const tickets = (await master.snapshot()).tickets
    expect(tickets.map(ticket => [ticket.ticketId, ticket.role, ticket.status])).toEqual([[id(0), 'MASTER', 'OPEN'], [id(1), 'INSTRUCTOR', 'OPEN'], [id(2), 'SUPPLY_ASSISTANT', 'OPEN']])
    expect(tickets[0]).toMatchObject({ displayName: 'Chris Cadet', issuedBy: 'mock:master', ticketAddress: WALLET, funding: { txid: TXID, vout: 0, satoshis: 2000 } })
  })

  it('lets an Instructor issue a cadet-role ticket but refuses a MASTER and an INSTRUCTOR one, naming the rule', async () => {
    const { replicas: { instructor } } = await unit({ instructor: 'INSTRUCTOR' })
    await instructor.recordTicketIssued(issued(id(1), 'SUPPLY_ASSISTANT'))
    await instructor.recordTicketIssued(issued(id(2), 'SUPPLY_OFFICER'))
    await expect(instructor.recordTicketIssued(issued(id(3), 'MASTER'))).rejects.toThrow(/Instructor can make tickets only for Supply Officers and Supply Assistants/)
    await expect(instructor.recordTicketIssued(issued(id(4), 'INSTRUCTOR'))).rejects.toThrow(/Only a Master can make a Master or Instructor ticket/)
    expect((await instructor.snapshot()).tickets.map(ticket => ticket.ticketId)).toEqual([id(1), id(2)])
  })

  it('refuses a cadet role making a ticket at all', async () => {
    const { replicas: { officer } } = await unit({ officer: 'SUPPLY_OFFICER' })
    await expect(officer.recordTicketIssued(issued(id(1), 'SUPPLY_ASSISTANT'))).rejects.toThrow(/Only a Master or an Instructor can make tickets/)
  })

  it('sets aside, visibly, a ticket event from another device that breaks the role rule, and lists nothing for it', async () => {
    const { replicas: { instructor, master } } = await unit({ instructor: 'INSTRUCTOR', master: 'MASTER' })
    // A tampered device skips the command-side check: the fold on every other device still applies D4.
    const forged = await signedBy(instructor, 'TICKET_ISSUED', id(7), issued(id(7), 'MASTER'))
    await master.receiveMany([forged])
    const state = await master.snapshot()
    expect(state.tickets).toEqual([])
    expect(state.rejected).toEqual([{ eventId: forged.eventId, eventType: 'TICKET_ISSUED', reason: expect.stringContaining('Instructor can make tickets only') }])
  })

  it('refuses a repeated ticket id, an invitation longer than a week, and a malformed fact', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    await master.recordTicketIssued(issued(id(1), 'SUPPLY_OFFICER'))
    await expect(master.recordTicketIssued(issued(id(1), 'SUPPLY_OFFICER'))).rejects.toThrow(/already exists/)
    await expect(master.recordTicketIssued(issued(id(2), 'SUPPLY_OFFICER', { expiresAt: new Date(Date.parse(ISSUED_AT) + TICKET_LIFETIME_MS + 1).toISOString() }))).rejects.toThrow(/within a week/)
    await expect(master.recordTicketIssued(issued(id(3), 'SUPPLY_OFFICER', { displayName: '   ' }))).rejects.toThrow(/displayName/)
  })

  it('lets only the issuing person cancel, once, and lists it as cancelled with the reason', async () => {
    const { replicas: { master, instructor, other } } = await unit({ master: 'MASTER', instructor: 'INSTRUCTOR', other: 'MASTER' })
    await instructor.recordTicketIssued(issued(id(1), 'SUPPLY_ASSISTANT'))
    await master.receiveMany(await events(instructor)); await other.receiveMany(await events(instructor))
    await expect(master.recordTicketCancelled(cancelled(id(1)))).rejects.toThrow(/Only the person who made a ticket can cancel it/)
    await expect(other.recordTicketCancelled(cancelled(id(9)))).rejects.toThrow(/missing/)
    await instructor.recordTicketCancelled(cancelled(id(1)))
    expect((await instructor.snapshot()).tickets[0]).toMatchObject({ status: 'CANCELLED', cancelReason: 'CANCELLED', cancelledAt: '2026-10-03T12:00:00.000Z', spendTxid: 'cd'.repeat(32) })
    await expect(instructor.recordTicketCancelled(cancelled(id(1)))).rejects.toThrow(/already closed/)
    await master.receiveMany(await events(instructor))
    expect((await master.snapshot()).tickets[0].status).toBe('CANCELLED')
  })

  it('marks a ticket redeemed from the new member’s own fact, and closes it for good: no cancelling after, no redeeming twice', async () => {
    const { replicas: { master, newcomer }, authorization } = await unit({ master: 'MASTER', newcomer: 'SUPPLY_ASSISTANT' })
    const fact = issued(id(1), 'SUPPLY_ASSISTANT')
    await master.recordTicketIssued(fact)
    await newcomer.receiveMany(await events(master))
    await expect(newcomer.recordTicketRedeemed(await redeemed(fact, 'mock:somebody-else'))).rejects.toThrow(/own device/)
    await expect(newcomer.recordTicketRedeemed(await redeemed({ ...fact, role: 'MASTER' }, 'mock:newcomer'))).rejects.toThrow(/does not match/)
    // signed correctly, but its credential was never proven by the ticket's spend: refused
    await expect(newcomer.recordTicketRedeemed(await redeemed(fact, 'mock:newcomer'))).rejects.toThrow(/signatures have not been verified/)
    await newcomer.recordTicketRedeemed(await proven(authorization, await redeemed(fact, 'mock:newcomer')))
    expect((await newcomer.snapshot()).tickets[0]).toMatchObject({ status: 'REDEEMED', redeemedAt: '2026-10-04T12:00:00.000Z', redeemedBy: 'mock:newcomer' })
    expect((await newcomer.snapshot()).members.find(member => member.publicIdentity === 'mock:newcomer')).toMatchObject({ status: 'ACTIVE', role: 'SUPPLY_ASSISTANT', credentialId: id(1), admittedBy: 'mock:master', activatedAt: '2026-10-04T12:00:00.000Z', ecdhPublicKey: 'spki', walletAddress: WALLET })
    await expect(newcomer.recordTicketRedeemed(await redeemed(fact, 'mock:newcomer'))).rejects.toThrow(/already closed/)
    await master.receiveMany(await events(newcomer))
    await expect(master.recordTicketCancelled(cancelled(id(1)))).rejects.toThrow(/already closed/)
  })

  it('ends byte-identical on two devices that receive the same ticket events in different orders, whoever won', async () => {
    const { replicas: { master, a, b, newcomer }, authorization } = await unit({ master: 'MASTER', a: 'SUPPLY_OFFICER', b: 'SUPPLY_OFFICER', newcomer: 'SUPPLY_ASSISTANT' })
    const one = issued(id(1), 'SUPPLY_ASSISTANT'), two = issued(id(2), 'SUPPLY_OFFICER')
    await master.recordTicketIssued(one); await master.recordTicketIssued(two)
    await newcomer.receiveMany(await events(master))
    await newcomer.recordTicketRedeemed(await proven(authorization, await redeemed(one, 'mock:newcomer')))
    await master.recordTicketCancelled(cancelled(id(2)))
    const all = [...await events(master), ...(await events(newcomer))]
    await a.receiveMany(all); await b.receiveMany([...all].reverse())
    const view = async (replica: ArgusReplica) => canonicalize([(await replica.snapshot()).tickets, (await replica.snapshot()).members])
    expect(await view(a)).toBe(await view(b))
    expect((await a.snapshot()).tickets.map(ticket => [ticket.ticketId, ticket.status])).toEqual([[id(1), 'REDEEMED'], [id(2), 'CANCELLED']])
  })

  it('keeps the first of a redemption and a cancellation in the unit’s own order, the same on every device', async () => {
    const { replicas: { master, newcomer, reader }, authorization } = await unit({ master: 'MASTER', newcomer: 'SUPPLY_ASSISTANT', reader: 'SUPPLY_OFFICER' })
    const fact = issued(id(1), 'SUPPLY_ASSISTANT')
    await master.recordTicketIssued(fact)
    await newcomer.receiveMany(await events(master))
    // Both act on the open ticket without seeing the other (as when two devices race): the order of the unit's history decides.
    await newcomer.recordTicketRedeemed(await proven(authorization, await redeemed(fact, 'mock:newcomer'))); await master.recordTicketCancelled(cancelled(id(1)))
    const both = [...await events(master), ...await events(newcomer)]
    await reader.receiveMany(both)
    await master.receiveMany(await events(newcomer)); await newcomer.receiveMany(await events(master))
    const verdicts = await Promise.all([master, newcomer, reader].map(async replica => (await replica.snapshot()).tickets[0].status))
    expect(new Set(verdicts).size).toBe(1)
    const rejected = (await reader.snapshot()).rejected
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/already closed/)
  })
})

describe('the list of tickets with days left and expiry (D3, D6)', () => {
  const NOW = new Date('2026-10-05T12:00:00.000Z')
  it('shows open tickets with whole days left, and marks one past its expiry as expired without changing the unit’s history', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    await master.recordTicketIssued(issued(id(1), 'SUPPLY_OFFICER'))
    await master.recordTicketIssued(issued(id(2), 'SUPPLY_ASSISTANT', { issuedAt: '2026-09-20T12:00:00.000Z', expiresAt: expires('2026-09-20T12:00:00.000Z') }))
    const tickets = (await master.snapshot()).tickets
    expect(listTickets(tickets, NOW).map(entry => [entry.ticketId, entry.status, entry.daysLeft])).toEqual([[id(1), 'open', 4], [id(2), 'expired', 0]])
    // The fold holds no clock: the same projection is 'open' for a viewer whose clock is earlier.
    expect(listTickets(tickets, new Date('2026-09-25T00:00:00.000Z')).map(entry => entry.status)).toEqual(['open', 'open'])
    expect(tickets.map(ticket => ticket.status)).toEqual(['OPEN', 'OPEN'])
  })

  it('counts a part-day as a day left and says expired exactly at the expiry moment', async () => {
    const { replicas: { master } } = await unit({ master: 'MASTER' })
    await master.recordTicketIssued(issued(id(1), 'SUPPLY_OFFICER'))
    const tickets = (await master.snapshot()).tickets
    const at = (ms: number) => listTickets(tickets, new Date(Date.parse(expires()) + ms))[0]
    expect(at(-1)).toMatchObject({ status: 'open', daysLeft: 1 })
    expect(at(-24 * 60 * 60 * 1000 - 1)).toMatchObject({ status: 'open', daysLeft: 2 })
    expect(at(0)).toMatchObject({ status: 'expired', daysLeft: 0 })
    expect(listTickets(tickets, new Date(ISSUED_AT))[0].daysLeft).toBe(7)
  })

  it('lists redeemed and cancelled tickets as such, however long ago they were due, and sorts open ones first', async () => {
    const { replicas: { master, newcomer }, authorization } = await unit({ master: 'MASTER', newcomer: 'SUPPLY_ASSISTANT' })
    const one = issued(id(1), 'SUPPLY_ASSISTANT'), two = issued(id(2), 'SUPPLY_OFFICER'), three = issued(id(3), 'SUPPLY_OFFICER')
    for (const fact of [one, two, three]) await master.recordTicketIssued(fact)
    await master.recordTicketCancelled(cancelled(id(2)))
    await newcomer.receiveMany(await events(master)); await newcomer.recordTicketRedeemed(await proven(authorization, await redeemed(one, 'mock:newcomer'))); await master.receiveMany(await events(newcomer))
    const later = new Date(Date.parse(expires()) + 30 * 24 * 60 * 60 * 1000)
    expect(listTickets((await master.snapshot()).tickets, later).map(entry => [entry.ticketId, entry.status, entry.daysLeft])).toEqual([[id(3), 'expired', 0], [id(1), 'redeemed', 0], [id(2), 'cancelled', 0]])
    expect(listTickets((await master.snapshot()).tickets, NOW).map(entry => entry.status)).toEqual(['open', 'redeemed', 'cancelled'])
  })
})

/** Builds a signed ticket event as another device would, bypassing the command-side checks. */
async function signedBy(replica: ArgusReplica, eventType: SignedArgusEvent['eventType'], entityId: string, payload: object): Promise<SignedArgusEvent> {
  const identity = (replica as unknown as { identity: MockIdentityProvider }).identity
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'unit-a', eventVersion: 1 as const, eventId: `forged-${entityId}`, eventType, entityId, actorPublicIdentity: await identity.getPublicIdentity(), timestamp: ISSUED_AT, clock: 1, payload: payload as Record<string, unknown> }
  return { ...unsigned, signature: await identity.sign(canonicalize(unsigned)) }
}
