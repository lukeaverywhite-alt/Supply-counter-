import type { EncryptedArgusEnvelope, KeyGrantRecord, TicketCancellation, TicketCancelledFact, TicketChainRecord, TicketFundingOutpoint, TicketInvitation, TicketIssuedFact, TicketPackage, TicketRedeemedFact, TicketRedemption } from './types'
import type { ArgusRole, AuthorityCredential, SignedArgusEvent } from '../distributed/types'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function parseEncryptedEnvelope(value: unknown): EncryptedArgusEnvelope {
  if (!record(value) || value.protocol !== 'ARGUS_PRIVATE_EVENT' || value.protocolVersion !== 1 || value.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encrypted envelope protocol.')
  for (const field of ['organizationId', 'eventId', 'epochId', 'senderPublicIdentity', 'nonce', 'ciphertext', 'ciphertextHash', 'signature']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Invalid encrypted envelope field: ${field}.`)
  return value as EncryptedArgusEnvelope
}
/** The complete set of plaintext fields a KEY_GRANT record may carry; used to assert no personal data leaks onto the chain. */
export const KEY_GRANT_RECORD_FIELDS = ['protocol', 'protocolVersion', 'organizationId', 'epochId', 'granteePublicIdentity', 'grantorPublicIdentity', 'wrappedKey', 'nonce', 'signature'] as const
export function parseKeyGrantRecord(value: unknown): KeyGrantRecord {
  if (!record(value) || value.protocol !== 'ARGUS_KEY_GRANT' || value.protocolVersion !== 1) throw new Error('Unsupported key grant record protocol.')
  for (const field of ['organizationId', 'epochId', 'granteePublicIdentity', 'grantorPublicIdentity', 'wrappedKey', 'nonce', 'signature']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Invalid key grant record field: ${field}.`)
  return value as KeyGrantRecord
}
export function parseSignedEvent(value: unknown): SignedArgusEvent {
  if (!record(value) || value.protocol !== 'ARGUS' || value.protocolVersion !== 1 || value.eventVersion !== 1 || typeof value.organizationId !== 'string' || typeof value.eventId !== 'string' || typeof value.eventType !== 'string' || typeof value.entityId !== 'string' || typeof value.actorPublicIdentity !== 'string' || typeof value.timestamp !== 'string' || !record(value.payload) || typeof value.signature !== 'string') throw new Error('Invalid or unsupported signed event schema.')
  return value as SignedArgusEvent
}

// ---------- admission by invitation ticket (docs/adr/012-admission-by-invitation-ticket.md) ----------
/** A ticket dies on its own one week after it was issued (D3). */
export const TICKET_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
/** The complete set of plaintext fields a ticket record shows on chain; everything else is inside its ciphertext. */
export const TICKET_CHAIN_RECORD_FIELDS = ['v', 'nonce', 'ct'] as const
const ROLES: readonly ArgusRole[] = ['MASTER', 'INSTRUCTOR', 'SUPPLY_OFFICER', 'SUPPLY_ASSISTANT']
const CANCEL_REASONS: readonly TicketCancellation['reason'][] = ['CANCELLED', 'EXPIRED']
const TICKET_ID = /^t-[0-9a-f]{20}$/, TICKET_PUBLIC_KEY = /^k1:0[23][0-9a-f]{64}$/, TXID = /^[0-9a-f]{64}$/, TESTNET_ADDRESS = /^[mn][1-9A-HJ-NP-Za-km-z]{25,34}$/, RAW_KEY = /^[A-Za-z0-9_-]{43}$/
const fail = (what: string, field: string): never => { throw new Error(`Invalid ${what} field: ${field}.`) }
function text(value: Record<string, unknown>, field: string, what: string, pattern?: RegExp): string {
  const entry = value[field]
  return typeof entry === 'string' && entry && (!pattern || pattern.test(entry)) ? entry : fail(what, field)
}
const timestamp = (value: Record<string, unknown>, field: string, what: string) => { const entry = text(value, field, what); return Number.isNaN(Date.parse(entry)) ? fail(what, field) : entry }
const role = (value: Record<string, unknown>, what: string) => ROLES.includes(value.role as ArgusRole) ? value.role as ArgusRole : fail(what, 'role')
const reason = (value: Record<string, unknown>, what: string) => CANCEL_REASONS.includes(value.reason as TicketCancellation['reason']) ? value.reason as TicketCancellation['reason'] : fail(what, 'reason')
const displayName = (value: Record<string, unknown>, what: string) => { const name = text(value, 'displayName', what); return name.trim() && name.length <= 60 ? name : fail(what, 'displayName') }
function object(value: unknown, what: string): Record<string, unknown> { if (!record(value)) throw new Error(`Invalid ${what}.`); return value }
function funding(value: unknown, what: string): TicketFundingOutpoint {
  const outpoint = record(value) ? value : fail(what, 'funding')
  if (!Number.isSafeInteger(outpoint.vout) || (outpoint.vout as number) < 0 || !Number.isSafeInteger(outpoint.satoshis) || (outpoint.satoshis as number) <= 0) fail(what, 'funding')
  return { txid: text(outpoint, 'txid', `${what} funding`, TXID), vout: outpoint.vout as number, satoshis: outpoint.satoshis as number }
}
/** Structure only: signatures and the issuer chain are checked by the verifier, never here. */
function credentials(value: unknown, what: string): AuthorityCredential[] {
  if (!Array.isArray(value)) return fail(what, 'issuerCredentials')
  return value.map(entry => {
    const credential = object(entry, `${what} issuer credential`), label = `${what} issuer credential`
    if (credential.credentialVersion !== 1) fail(label, 'credentialVersion')
    if (!Array.isArray(credential.permissions) || credential.permissions.some(permission => typeof permission !== 'string')) fail(label, 'permissions')
    if (credential.expiresAt !== undefined) timestamp(credential, 'expiresAt', label)
    for (const field of ['credentialId', 'subjectPublicIdentity', 'issuedBy', 'signature']) text(credential, field, label)
    timestamp(credential, 'issuedAt', label); role(credential, label)
    return credential as AuthorityCredential
  })
}

export function parseTicketInvitation(value: unknown): TicketInvitation {
  const what = 'ticket invitation', invitation = object(value, what)
  if (invitation.invitationVersion !== 1) throw new Error('Unsupported ticket invitation version.')
  const issuedAt = timestamp(invitation, 'issuedAt', what), expiresAt = timestamp(invitation, 'expiresAt', what)
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt)
  if (lifetime <= 0 || lifetime > TICKET_LIFETIME_MS) throw new Error('A ticket must expire within a week of being issued.')
  return {
    invitationVersion: 1, ticketId: text(invitation, 'ticketId', what, TICKET_ID), unitId: text(invitation, 'unitId', what), displayName: displayName(invitation, what), role: role(invitation, what),
    issuedAt, expiresAt, ticketPublicKey: text(invitation, 'ticketPublicKey', what, TICKET_PUBLIC_KEY), funding: funding(invitation.funding, what), issuedBy: text(invitation, 'issuedBy', what), signature: text(invitation, 'signature', what),
  }
}

export function parseTicketPackage(value: unknown): TicketPackage {
  const what = 'ticket package', ticket = object(value, what)
  if (ticket.kind !== 'TICKET' || ticket.packageVersion !== 1) throw new Error('Unsupported ticket package.')
  const invitation = parseTicketInvitation(ticket.invitation), unit = object(ticket.unit, `${what} unit`)
  const unitInfo = { unitId: text(unit, 'unitId', `${what} unit`), unitName: text(unit, 'unitName', `${what} unit`), authorityIdentity: text(unit, 'authorityIdentity', `${what} unit`) }
  if (unitInfo.unitId !== invitation.unitId) throw new Error('This ticket names a different unit from its invitation.')
  if (!Array.isArray(ticket.epochKeys) || !ticket.epochKeys.length) fail(what, 'epochKeys')
  const epochKeys = (ticket.epochKeys as unknown[]).map(entry => { const key = object(entry, `${what} key`); return { epochId: text(key, 'epochId', `${what} key`), key: text(key, 'key', `${what} key`, RAW_KEY) } })
  const currentEpoch = text(ticket, 'currentEpoch', what)
  if (!epochKeys.some(key => key.epochId === currentEpoch)) throw new Error('This ticket is missing the current unit key.')
  return { kind: 'TICKET', packageVersion: 1, invitation, issuerDisplayName: text(ticket, 'issuerDisplayName', what), issuerCredentials: credentials(ticket.issuerCredentials, what), unit: unitInfo, currentEpoch, epochKeys, ticketEcdhPrivateKey: text(ticket, 'ticketEcdhPrivateKey', what) }
}

export function parseTicketRedemption(value: unknown): TicketRedemption {
  const what = 'ticket redemption', redemption = object(value, what)
  if (redemption.kind !== 'TICKET_REDEEMED' || redemption.redemptionVersion !== 1) throw new Error('Unsupported ticket redemption.')
  return {
    kind: 'TICKET_REDEEMED', redemptionVersion: 1, ticketId: text(redemption, 'ticketId', what, TICKET_ID), unitId: text(redemption, 'unitId', what),
    subjectPublicIdentity: text(redemption, 'subjectPublicIdentity', what), ecdhPublicKey: text(redemption, 'ecdhPublicKey', what), walletAddress: text(redemption, 'walletAddress', what, TESTNET_ADDRESS),
    redeemedAt: timestamp(redemption, 'redeemedAt', what), signature: text(redemption, 'signature', what),
  }
}

export function parseTicketCancellation(value: unknown): TicketCancellation {
  const what = 'ticket cancellation', cancellation = object(value, what)
  if (cancellation.kind !== 'TICKET_CANCELLED' || cancellation.cancellationVersion !== 1) throw new Error('Unsupported ticket cancellation.')
  return {
    kind: 'TICKET_CANCELLED', cancellationVersion: 1, ticketId: text(cancellation, 'ticketId', what, TICKET_ID), unitId: text(cancellation, 'unitId', what), reason: reason(cancellation, what),
    cancelledAt: timestamp(cancellation, 'cancelledAt', what), issuedBy: text(cancellation, 'issuedBy', what), signature: text(cancellation, 'signature', what),
  }
}

export function parseTicketChainRecord(value: unknown): TicketChainRecord {
  const what = 'ticket record', chainRecord = object(value, what)
  if (chainRecord.v !== 1) throw new Error('Unsupported ticket record.')
  return { v: 1, nonce: text(chainRecord, 'nonce', what), ct: text(chainRecord, 'ct', what) }
}

export function parseTicketIssuedFact(value: unknown): TicketIssuedFact {
  const what = 'TICKET_ISSUED fact', fact = object(value, what)
  const issuedAt = timestamp(fact, 'issuedAt', what), expiresAt = timestamp(fact, 'expiresAt', what)
  return { ticketId: text(fact, 'ticketId', what, TICKET_ID), ticketAddress: text(fact, 'ticketAddress', what, TESTNET_ADDRESS), ticketEcdhPublicKey: text(fact, 'ticketEcdhPublicKey', what), displayName: displayName(fact, what), role: role(fact, what), issuedAt, expiresAt, funding: funding(fact.funding, what) }
}

export function parseTicketCancelledFact(value: unknown): TicketCancelledFact {
  const what = 'TICKET_CANCELLED fact', fact = object(value, what)
  return { ticketId: text(fact, 'ticketId', what, TICKET_ID), reason: reason(fact, what), cancelledAt: timestamp(fact, 'cancelledAt', what), spendTxid: text(fact, 'spendTxid', what, TXID) }
}

export function parseTicketRedeemedFact(value: unknown): TicketRedeemedFact {
  const what = 'TICKET_REDEEMED fact', fact = object(value, what)
  const ticketId = text(fact, 'ticketId', what, TICKET_ID), invitation = parseTicketInvitation(fact.invitation), redemption = parseTicketRedemption(fact.redemption)
  if (invitation.ticketId !== ticketId || redemption.ticketId !== ticketId || redemption.unitId !== invitation.unitId) throw new Error('This redemption names a different ticket from its invitation.')
  return { ticketId, invitation, issuerCredentials: credentials(fact.issuerCredentials, what), redemption }
}
