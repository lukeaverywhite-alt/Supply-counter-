import { describe, expect, it } from 'vitest'
import { canonicalize } from '../distributed/canonical'
import type { ArgusRole, AuthorityCredential } from '../distributed/types'
import { WebCryptoIdentityProvider, type ArgusIdentityProvider } from '../identity/identity'
import { makeTicketSecret } from '../identity/ticketCode'
import { deriveTicketKeys, newTicketId, signWithTicketKey, verifyTicketSignature, type TicketKeys } from '../identity/ticketKeys'
import { TICKET_LIFETIME_MS } from '../private-sync/schema'
import type { TicketRedeemedFact } from '../private-sync/types'
import { AuthorizationService, ROLE_PERMISSIONS, isTicketCredential, issueCredential, issueRevocation, ticketCredential } from './authorization'

const T0 = Date.parse('2026-10-01T12:00:00.000Z'), at = (ms: number) => new Date(T0 + ms).toISOString(), HOUR = 3_600_000
const credentialFor = (issuer: ArgusIdentityProvider, subject: string, role: ArgusRole, issuedAt = at(-HOUR)) => issueCredential(issuer, { subjectPublicIdentity: subject, role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt })

/** One ticket the whole way: the issuer signs the invitation, the ticket key signs the redemption binding the new device. */
async function redeemedFact(input: { issuer: ArgusIdentityProvider; issuerCredentials: AuthorityCredential[]; role: ArgusRole; subject: string; issuedAt?: number; redeemedAt?: string; keys?: TicketKeys; signRedemptionWith?: TicketKeys }): Promise<TicketRedeemedFact> {
  const keys = input.keys ?? await deriveTicketKeys(makeTicketSecret()), ticketId = newTicketId()
  const unsignedInvitation = { invitationVersion: 1 as const, ticketId, unitId: 'u-unit', displayName: 'Pat Cadet', role: input.role, issuedAt: at(input.issuedAt ?? 0), expiresAt: at((input.issuedAt ?? 0) + TICKET_LIFETIME_MS), ticketPublicKey: keys.publicIdentity, funding: { txid: 'ab'.repeat(32), vout: 0, satoshis: 2_000 }, issuedBy: await input.issuer.getPublicIdentity() }
  const invitation = { ...unsignedInvitation, signature: await input.issuer.sign(canonicalize(unsignedInvitation)) }
  const unsignedRedemption = { kind: 'TICKET_REDEEMED' as const, redemptionVersion: 1 as const, ticketId, unitId: 'u-unit', subjectPublicIdentity: input.subject, ecdhPublicKey: 'ecdh-spki', walletAddress: 'mzBc4XEFSdzCDcTxAgf6EZXgsZWpztRhef', redeemedAt: input.redeemedAt ?? at(HOUR) }
  const redemption = { ...unsignedRedemption, signature: signWithTicketKey((input.signRedemptionWith ?? keys).privateKey, canonicalize(unsignedRedemption)) }
  return { ticketId, invitation, issuerCredentials: input.issuerCredentials, redemption }
}

describe('the authority -> ticket -> device credential chain (ADR 012)', () => {
  it('signs and checks with the ticket key: k1sig, over the exact text', async () => {
    const keys = await deriveTicketKeys(makeTicketSecret()), other = await deriveTicketKeys(makeTicketSecret())
    const signature = signWithTicketKey(keys.privateKey, 'hello')
    expect(signature).toMatch(/^k1sig:[A-Za-z0-9_-]+$/)
    expect(verifyTicketSignature(keys.publicIdentity, 'hello', signature)).toBe(true)
    expect(verifyTicketSignature(keys.publicIdentity, 'hellO', signature)).toBe(false)
    expect(verifyTicketSignature(other.publicIdentity, 'hello', signature)).toBe(false)
    expect(verifyTicketSignature(keys.publicIdentity, 'hello', 'k1sig:AAAA')).toBe(false)
    expect(verifyTicketSignature('p256:nope', 'hello', signature)).toBe(false)
  })

  it('accepts a redeemed device’s chain and then treats it as any member of that role, from the moment of redemption', async () => {
    const authority = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create()
    const service = new AuthorizationService(await authority.getPublicIdentity(), device)
    const fact = await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'SUPPLY_OFFICER', subject: await device.getPublicIdentity() })
    const credential = ticketCredential(fact)
    expect(isTicketCredential(credential)).toBe(true)
    expect(credential).toMatchObject({ credentialId: fact.ticketId, subjectPublicIdentity: await device.getPublicIdentity(), role: 'SUPPLY_OFFICER', issuedAt: fact.redemption.redeemedAt, issuedBy: fact.invitation.issuedBy, permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER].sort() })
    await service.acceptCredential(credential)
    expect(service.hasCredential(fact.ticketId)).toBe(true)
    expect(service.verifiedTicketCredential(fact.ticketId, await device.getPublicIdentity())?.credentialId).toBe(fact.ticketId)
    expect(() => service.require(credential.subjectPublicIdentity, 'cadets.manage', at(2 * HOUR))).not.toThrow()
    expect(() => service.require(credential.subjectPublicIdentity, 'users.authorize', at(2 * HOUR))).toThrow(/Unauthorized/)
    expect(() => service.require(credential.subjectPublicIdentity, 'cadets.manage', at(0))).toThrow(/Unauthorized/)
    // removed like anyone else, by its credential ID
    await service.acceptRevocation(await issueRevocation(authority, credential, at(3 * HOUR)))
    expect(() => service.require(credential.subjectPublicIdentity, 'cadets.manage', at(4 * HOUR))).toThrow(/Unauthorized/)
  })

  it('refuses a chain whose ticket signature is wrong, or whose invitation the issuer did not sign', async () => {
    const authority = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create(), stranger = await WebCryptoIdentityProvider.create()
    const service = new AuthorizationService(await authority.getPublicIdentity(), device), subject = await device.getPublicIdentity()
    const wrongKey = await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject, signRedemptionWith: await deriveTicketKeys(makeTicketSecret()) })
    await expect(service.acceptCredential(ticketCredential(wrongKey))).rejects.toThrow(/ticket signature/)
    const good = await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject })
    const swapped = { ...good, redemption: { ...good.redemption, ecdhPublicKey: 'someone-elses-key' } }
    await expect(service.acceptCredential(ticketCredential(swapped))).rejects.toThrow(/ticket signature/)
    const raised = { ...good, invitation: { ...good.invitation, role: 'MASTER' as const } }
    await expect(service.acceptCredential(ticketCredential(raised))).rejects.toThrow(/invitation signature/)
    // the credential itself must say only what the proof says
    await expect(service.acceptCredential({ ...ticketCredential(good), role: 'MASTER', permissions: [...ROLE_PERMISSIONS.MASTER].sort() })).rejects.toThrow(/does not match/)
    // signed by someone with no standing in the unit
    const outsider = await redeemedFact({ issuer: stranger, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject })
    await expect(service.acceptCredential(ticketCredential(outsider))).rejects.toThrow(/not authorized/)
    expect(service.hasCredential(good.ticketId)).toBe(false)
    await service.acceptCredential(ticketCredential(good))
    expect(service.hasCredential(good.ticketId)).toBe(true)
  })

  it('refuses a redemption at or after the ticket’s expiry, or before it was issued', async () => {
    const authority = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create()
    const service = new AuthorizationService(await authority.getPublicIdentity(), device), subject = await device.getPublicIdentity()
    for (const redeemedAt of [at(TICKET_LIFETIME_MS), at(TICKET_LIFETIME_MS + 1), at(-1)]) {
      await expect(service.acceptCredential(ticketCredential(await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject, redeemedAt })))).rejects.toThrow(/outside the ticket’s week/)
    }
  })

  it('follows D4 through the chain: an Instructor’s cadet ticket counts, an Instructor’s Instructor ticket does not, and a delegated Master cannot make a Master', async () => {
    const authority = await WebCryptoIdentityProvider.create(), instructor = await WebCryptoIdentityProvider.create(), master = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create()
    const service = new AuthorizationService(await authority.getPublicIdentity(), device), subject = await device.getPublicIdentity()
    const instructorCredential = await credentialFor(authority, await instructor.getPublicIdentity(), 'INSTRUCTOR'), masterCredential = await credentialFor(authority, await master.getPublicIdentity(), 'MASTER')
    // the issuer's own credential rides in the proof and is checked against the pinned authority on the way
    const cadet = await redeemedFact({ issuer: instructor, issuerCredentials: [instructorCredential], role: 'SUPPLY_ASSISTANT', subject })
    await service.acceptCredential(ticketCredential(cadet))
    expect(service.hasCredential(instructorCredential.credentialId)).toBe(true)
    await expect(service.acceptCredential(ticketCredential(await redeemedFact({ issuer: instructor, issuerCredentials: [instructorCredential], role: 'INSTRUCTOR', subject })))).rejects.toThrow(/not authorized/)
    await expect(service.acceptCredential(ticketCredential(await redeemedFact({ issuer: master, issuerCredentials: [masterCredential], role: 'MASTER', subject })))).rejects.toThrow(/not authorized/)
    await service.acceptCredential(ticketCredential(await redeemedFact({ issuer: master, issuerCredentials: [masterCredential], role: 'INSTRUCTOR', subject })))
  })

  it('kills an issuer’s open tickets when the issuer is removed: a redemption after the removal grants nothing, one before it stands', async () => {
    const authority = await WebCryptoIdentityProvider.create(), instructor = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create(), early = await WebCryptoIdentityProvider.create()
    const service = new AuthorizationService(await authority.getPublicIdentity(), device)
    const instructorCredential = await credentialFor(authority, await instructor.getPublicIdentity(), 'INSTRUCTOR')
    await service.acceptCredential(instructorCredential)
    const before = await redeemedFact({ issuer: instructor, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject: await early.getPublicIdentity(), redeemedAt: at(HOUR) })
    const after = await redeemedFact({ issuer: instructor, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject: await device.getPublicIdentity(), redeemedAt: at(3 * HOUR) })
    await service.acceptCredential(ticketCredential(before)); await service.acceptCredential(ticketCredential(after))
    await service.acceptRevocation(await issueRevocation(authority, instructorCredential, at(2 * HOUR)))
    const earlyIdentity = await early.getPublicIdentity(), lateIdentity = await device.getPublicIdentity()
    expect(() => service.require(earlyIdentity, 'inventory.count', at(5 * HOUR))).not.toThrow()
    expect(() => service.require(lateIdentity, 'inventory.count', at(5 * HOUR))).toThrow(/Unauthorized/)
    expect(service.verifiedTicketCredential(after.ticketId, await device.getPublicIdentity())).toBeUndefined()
  })

  it('never lets one ticket admit two devices: a second, different redemption of the same ticket voids both, in whichever order they arrive', async () => {
    const authority = await WebCryptoIdentityProvider.create(), first = await WebCryptoIdentityProvider.create(), second = await WebCryptoIdentityProvider.create()
    const keys = await deriveTicketKeys(makeTicketSecret())
    const fact = await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'SUPPLY_ASSISTANT', subject: await first.getPublicIdentity(), keys })
    // a code holder signs a redemption of the same ticket for another device, with the ticket key
    const { signature: _drop, ...unsigned } = { ...fact.redemption, subjectPublicIdentity: await second.getPublicIdentity() }
    void _drop
    const other = { ...fact, redemption: { ...unsigned, signature: signWithTicketKey(keys.privateKey, canonicalize(unsigned)) } }
    for (const order of [[fact, other], [other, fact]]) {
      const service = new AuthorizationService(await authority.getPublicIdentity(), first)
      await service.acceptCredential(ticketCredential(order[0]))
      await service.acceptCredential(ticketCredential(order[0])) // the same one again is fine
      expect(service.verifiedTicketCredential(fact.ticketId, order[0].redemption.subjectPublicIdentity)).toBeDefined()
      await expect(service.acceptCredential(ticketCredential(order[1]))).rejects.toThrow(/already used on another device/)
      for (const subject of [await first.getPublicIdentity(), await second.getPublicIdentity()]) {
        expect(service.verifiedTicketCredential(fact.ticketId, subject)).toBeUndefined()
        expect(() => service.require(subject, 'inventory.count', at(2 * HOUR))).toThrow(/Unauthorized/)
      }
    }
  })

  it('takes an issuer’s own ticket credential only once it is proven, never from the proof of a ticket that issuer made', async () => {
    const authority = await WebCryptoIdentityProvider.create(), instructor = await WebCryptoIdentityProvider.create(), device = await WebCryptoIdentityProvider.create()
    const root = await authority.getPublicIdentity()
    // the Instructor joined by ticket, and an hour later makes a cadet ticket, offering their ticket credential as their chain
    const instructorCredential = ticketCredential(await redeemedFact({ issuer: authority, issuerCredentials: [], role: 'INSTRUCTOR', subject: await instructor.getPublicIdentity() }))
    const cadet = await redeemedFact({ issuer: instructor, issuerCredentials: [instructorCredential], role: 'SUPPLY_ASSISTANT', subject: await device.getPublicIdentity(), issuedAt: 2 * HOUR, redeemedAt: at(3 * HOUR) })
    const service = new AuthorizationService(root, device)
    await expect(service.acceptCredential(ticketCredential(cadet))).rejects.toThrow(/not authorized/)
    expect(service.hasCredential(instructorCredential.credentialId)).toBe(false)
    // once the Instructor's own redemption is proven (by its own spend, the sync provider's part), their tickets count
    await service.acceptCredential(instructorCredential)
    await service.acceptCredential(ticketCredential(cadet))
    expect(service.verifiedTicketCredential(cadet.ticketId, await device.getPublicIdentity())).toBeDefined()
    // a fresh device about to redeem holds nothing of the unit: it checks the issuer's chain from the proof itself
    await expect(new AuthorizationService(root, device).verifyInvitation(cadet.invitation, cadet.issuerCredentials, at(3 * HOUR))).rejects.toThrow(/not authorized/)
    await new AuthorizationService(root, device).verifyInvitation(cadet.invitation, cadet.issuerCredentials, at(3 * HOUR), { acceptTicketProofs: true })
  })
})
