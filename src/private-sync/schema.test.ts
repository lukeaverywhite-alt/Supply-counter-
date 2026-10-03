import { describe, expect, it } from 'vitest'
import { TICKET_CHAIN_RECORD_FIELDS, TICKET_LIFETIME_MS, parseTicketCancellation, parseTicketCancelledFact, parseTicketChainRecord, parseTicketInvitation, parseTicketIssuedFact, parseTicketPackage, parseTicketRedeemedFact, parseTicketRedemption } from './schema'
import type { TicketCancellation, TicketCancelledFact, TicketChainRecord, TicketInvitation, TicketIssuedFact, TicketPackage, TicketRedeemedFact, TicketRedemption } from './types'
import type { AuthorityCredential } from '../distributed/types'

const issuedAt = '2026-10-02T12:00:00.000Z'
const expiresAt = new Date(Date.parse(issuedAt) + TICKET_LIFETIME_MS).toISOString()
const funding = { txid: 'ab'.repeat(32), vout: 0, satoshis: 2000 }
const invitation: TicketInvitation = {
  invitationVersion: 1, ticketId: 't-0123456789abcdef0123', unitId: 'u-00112233445566778899', displayName: 'Cadet Rivera', role: 'SUPPLY_ASSISTANT',
  issuedAt, expiresAt, ticketPublicKey: `k1:02${'cd'.repeat(32)}`, funding, issuedBy: 'p256:instructor', signature: 'p256sig:invitation',
}
const instructorCredential: AuthorityCredential = {
  credentialVersion: 1, credentialId: 'cred-instructor', subjectPublicIdentity: 'p256:instructor', role: 'INSTRUCTOR', permissions: ['inventory.read'],
  issuedAt: '2026-09-01T00:00:00.000Z', issuedBy: 'p256:authority', signature: 'p256sig:credential',
}
const ticketPackage: TicketPackage = {
  kind: 'TICKET', packageVersion: 1, invitation, issuerDisplayName: 'Chief Lopez', issuerCredentials: [instructorCredential],
  unit: { unitId: invitation.unitId, unitName: 'Harbor High NJROTC', authorityIdentity: 'p256:authority' },
  currentEpoch: 'e2-0a0b0c0d', epochKeys: [{ epochId: 'e1', key: 'A'.repeat(43) }, { epochId: 'e2-0a0b0c0d', key: 'B'.repeat(43) }],
  ticketEcdhPrivateKey: '{"crv":"P-256","d":"ZA","kty":"EC","x":"WA","y":"WQ"}',
}
const redemption: TicketRedemption = {
  kind: 'TICKET_REDEEMED', redemptionVersion: 1, ticketId: invitation.ticketId, unitId: invitation.unitId, subjectPublicIdentity: 'p256:newdevice',
  ecdhPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', walletAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', redeemedAt: '2026-10-03T08:00:00.000Z', signature: 'k1sig:redemption',
}
const cancellation: TicketCancellation = {
  kind: 'TICKET_CANCELLED', cancellationVersion: 1, ticketId: invitation.ticketId, unitId: invitation.unitId, reason: 'CANCELLED',
  cancelledAt: '2026-10-04T08:00:00.000Z', issuedBy: 'p256:instructor', signature: 'p256sig:cancel',
}
const chainRecord: TicketChainRecord = { v: 1, nonce: 'bm9uY2Vub25jZW5v', ct: 'Y2lwaGVydGV4dA' }
const issuedFact: TicketIssuedFact = {
  ticketId: invitation.ticketId, ticketAddress: 'n3GNqMveyvaPvUbH469vDRadqpJMPc84JA', ticketEcdhPublicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE', displayName: 'Cadet Rivera', role: 'SUPPLY_ASSISTANT', issuedAt, expiresAt, funding,
}
const cancelledFact: TicketCancelledFact = { ticketId: invitation.ticketId, reason: 'EXPIRED', cancelledAt: '2026-10-09T13:00:00.000Z', spendTxid: 'ef'.repeat(32) }
const redeemedFact: TicketRedeemedFact = { ticketId: invitation.ticketId, invitation, issuerCredentials: [instructorCredential], redemption }

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function without(value: object, path: string[]) {
  const copy = clone(value) as Record<string, unknown>
  let target = copy
  for (const key of path.slice(0, -1)) target = target[key] as Record<string, unknown>
  delete target[path.at(-1)!]
  return copy
}
/** Every field path of a sample, nested objects included (arrays of objects are checked through their first element). */
function fieldPaths(value: object, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = [...prefix, key]
    if (Array.isArray(entry)) return entry.length && typeof entry[0] === 'object' ? [path, ...fieldPaths(entry[0] as object, [...path, '0'])] : [path]
    return entry && typeof entry === 'object' ? [path, ...fieldPaths(entry as object, path)] : [path]
  })
}

const cases = [
  { name: 'TICKET invitation', parse: parseTicketInvitation, sample: invitation },
  { name: 'TICKET package', parse: parseTicketPackage, sample: ticketPackage },
  { name: 'TICKET_REDEEMED record', parse: parseTicketRedemption, sample: redemption },
  { name: 'TICKET_CANCELLED record', parse: parseTicketCancellation, sample: cancellation },
  { name: 'ticket chain record', parse: parseTicketChainRecord, sample: chainRecord },
  { name: 'TICKET_ISSUED fact', parse: parseTicketIssuedFact, sample: issuedFact },
  { name: 'TICKET_CANCELLED fact', parse: parseTicketCancelledFact, sample: cancelledFact },
  { name: 'TICKET_REDEEMED fact', parse: parseTicketRedeemedFact, sample: redeemedFact },
] as const

describe.each(cases)('$name validator', ({ parse, sample }) => {
  it('accepts its sample unchanged', () => {
    expect((parse as (value: unknown) => unknown)(clone(sample))).toEqual(sample)
  })
  it.each(fieldPaths(sample).map(path => [path.join('.'), path] as const))('refuses the sample without %s', (_, path) => {
    expect(() => (parse as (value: unknown) => unknown)(without(sample, path))).toThrow()
  })
  it('refuses something that is not an object', () => {
    for (const value of [null, 'text', 7, []]) expect(() => (parse as (value: unknown) => unknown)(value)).toThrow()
  })
})

describe('ticket validators', () => {
  it('refuse an invitation that lives longer than a week or ends before it starts', () => {
    expect(() => parseTicketInvitation({ ...invitation, expiresAt: new Date(Date.parse(issuedAt) + TICKET_LIFETIME_MS + 1).toISOString() })).toThrow(/week/)
    expect(() => parseTicketInvitation({ ...invitation, expiresAt: issuedAt })).toThrow(/week/)
  })
  it('refuse an unknown role, a malformed ticket key and an unusable funding outpoint', () => {
    expect(() => parseTicketInvitation({ ...invitation, role: 'ADMIRAL' })).toThrow(/role/)
    expect(() => parseTicketInvitation({ ...invitation, ticketPublicKey: 'p256:abc' })).toThrow(/ticketPublicKey/)
    expect(() => parseTicketInvitation({ ...invitation, funding: { ...funding, vout: -1 } })).toThrow(/funding/)
    expect(() => parseTicketInvitation({ ...invitation, funding: { ...funding, satoshis: 0 } })).toThrow(/funding/)
  })
  it('refuse a package whose current key is not among its keys, or whose invitation is for another unit', () => {
    expect(() => parseTicketPackage({ ...ticketPackage, currentEpoch: 'e9' })).toThrow(/current/)
    expect(() => parseTicketPackage({ ...ticketPackage, unit: { ...ticketPackage.unit, unitId: 'u-99999999999999999999' } })).toThrow(/unit/)
  })
  it('refuse a redeemed fact whose parts name different tickets', () => {
    expect(() => parseTicketRedeemedFact({ ...redeemedFact, redemption: { ...redemption, ticketId: 't-ffffffffffffffffffff' } })).toThrow(/ticket/)
  })
  it('refuse a cancellation with an unknown reason', () => {
    expect(() => parseTicketCancellation({ ...cancellation, reason: 'BORED' })).toThrow(/reason/)
    expect(() => parseTicketCancelledFact({ ...cancelledFact, reason: 'BORED' })).toThrow(/reason/)
  })
  it('keep only the known fields of a unit-stream fact, so nothing secret can ride along', () => {
    const parsed = parseTicketIssuedFact({ ...issuedFact, ticketCode: 'ABCDE-FGHJK', secret: 'oops' }) as Record<string, unknown>
    expect(parsed).toEqual(issuedFact)
    expect(Object.keys(parsed)).not.toContain('ticketCode')
    expect(parseTicketRedeemedFact({ ...redeemedFact, secret: 'oops' })).toEqual(redeemedFact)
    expect(parseTicketCancelledFact({ ...cancelledFact, secret: 'oops' })).toEqual(cancelledFact)
  })
  it('show only a version, a nonce and ciphertext in a ticket record on chain', () => {
    expect(Object.keys(parseTicketChainRecord({ ...chainRecord, name: 'Cadet Rivera' })).sort()).toEqual([...TICKET_CHAIN_RECORD_FIELDS].sort())
    expect(() => parseTicketChainRecord({ ...chainRecord, v: 2 })).toThrow()
  })
})
