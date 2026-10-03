import type { ArgusRole, AuthorityCredential } from '../distributed/types'

export type EncryptedArgusEnvelope = {
  protocol: 'ARGUS_PRIVATE_EVENT'
  protocolVersion: 1
  organizationId: string
  eventId: string
  epochId: string
  senderPublicIdentity: string
  algorithm: 'AES-256-GCM'
  nonce: string
  ciphertext: string
  ciphertextHash: string
  signature: string
}

/**
 * Wraps a raw epoch key to one admitted device's ECDH public identity. Plaintext carries no
 * name, role, or anything derived from a person beyond the two public identities involved.
 */
export type KeyGrantRecord = {
  protocol: 'ARGUS_KEY_GRANT'
  protocolVersion: 1
  organizationId: string
  epochId: string
  granteePublicIdentity: string
  grantorPublicIdentity: string
  wrappedKey: string
  nonce: string
  signature: string
}

export type HistoryPage = { envelopes: unknown[]; cursor: string; hasMore?: boolean }
export type PublishResult = { accepted: true; duplicate: boolean; sequence: number }
export type ProviderHealth = { ok: boolean; provider: string; protocolVersion: number }
export interface PrivateHistoryProvider {
  readonly name: string
  publish(envelope: EncryptedArgusEnvelope): Promise<void | PublishResult>
  getSince(cursor?: string): Promise<HistoryPage>
  getByEventId(eventId: string): Promise<unknown | undefined>
  health?(): Promise<ProviderHealth>
}

export type KeyGrantPage = { records: KeyGrantRecord[]; cursor: string; hasMore?: boolean }
/** Carries KEY_GRANT records the same way a PrivateHistoryProvider carries event envelopes. */
export interface KeyGrantChainProvider {
  publishKeyGrant(record: KeyGrantRecord): Promise<void>
  getKeyGrantsSince(cursor?: string): Promise<KeyGrantPage>
}

/** Resolves an admitted device's ECDH public key from its signing public identity. Real discovery
 * (e.g. an on-chain announcement) is a composition-layer concern outside this module. */
export interface EcdhKeyDirectory {
  publicKeyFor(identity: string): Promise<CryptoKey>
}

/*
 * Admission by invitation ticket (docs/adr/012-admission-by-invitation-ticket.md). A ticket is a 128-bit secret
 * (src/identity/ticketCode.ts); from it both sides derive a one-use secp256k1 ticket key, whose testnet P2PKH address
 * is where the ticket's records live, and an AES-256-GCM key that encrypts them. None of these types ever carries
 * the secret or the code.
 */

/** The one transaction output whose spending decides a ticket's fate: redeemed, or cancelled by its issuer. */
export type TicketFundingOutpoint = { txid: string; vout: number; satoshis: number }

/** Signed by the issuer: the first link of the authority -> ticket -> device chain. Travels only inside ciphertext. */
export type TicketInvitation = {
  invitationVersion: 1
  /** t- and 20 hex digits, random. */
  ticketId: string
  unitId: string
  /** The one named person this ticket is for (D1). */
  displayName: string
  role: ArgusRole
  issuedAt: string
  /** At most TICKET_LIFETIME_MS after issuedAt (D3). */
  expiresAt: string
  /** k1: and the compressed secp256k1 public key of the ticket key, in hex. */
  ticketPublicKey: string
  funding: TicketFundingOutpoint
  issuedBy: string
  signature: string
}

/** The plaintext of the TICKET record at the ticket address: everything a fresh device learns from the code. */
export type TicketPackage = {
  kind: 'TICKET'
  packageVersion: 1
  invitation: TicketInvitation
  issuerDisplayName: string
  /** The issuer's own credential chain up to the unit authority (empty when the authority itself issued the ticket). */
  issuerCredentials: AuthorityCredential[]
  unit: { unitId: string; unitName: string; authorityIdentity: string }
  currentEpoch: string
  /** Every unit key generation the issuer holds, raw 32-byte AES keys in base64url. */
  epochKeys: { epochId: string; key: string }[]
  /** The ticket's own P-256 ECDH private key (JWK JSON), random, made by the issuer: unit keys made while the ticket is open are granted to it. */
  ticketEcdhPrivateKey: string
}

/** The plaintext of the TICKET_REDEEMED record: signed by the ticket key, it binds the new device's own keys (the second link). */
export type TicketRedemption = {
  kind: 'TICKET_REDEEMED'
  redemptionVersion: 1
  ticketId: string
  unitId: string
  subjectPublicIdentity: string
  ecdhPublicKey: string
  walletAddress: string
  redeemedAt: string
  signature: string
}

/** The plaintext of the TICKET_CANCELLED record: signed by the issuer, in the transaction that spends the funding output. */
export type TicketCancellation = {
  kind: 'TICKET_CANCELLED'
  cancellationVersion: 1
  ticketId: string
  unitId: string
  reason: 'CANCELLED' | 'EXPIRED'
  cancelledAt: string
  issuedBy: string
  signature: string
}

/** What a TICKET, TICKET_REDEEMED or TICKET_CANCELLED record shows on chain: a version, a nonce and ciphertext, nothing else. */
export type TicketChainRecord = { v: 1; nonce: string; ct: string }

/** Unit-stream facts (payloads inside the unit's own encrypted history), for the open-tickets list and membership. No secret. */
export type TicketIssuedFact = { ticketId: string; ticketAddress: string; ticketEcdhPublicKey: string; displayName: string; role: ArgusRole; issuedAt: string; expiresAt: string; funding: TicketFundingOutpoint }
export type TicketCancelledFact = { ticketId: string; reason: TicketCancellation['reason']; cancelledAt: string; spendTxid: string }
export type TicketRedeemedFact = { ticketId: string; invitation: TicketInvitation; issuerCredentials: AuthorityCredential[]; redemption: TicketRedemption }
