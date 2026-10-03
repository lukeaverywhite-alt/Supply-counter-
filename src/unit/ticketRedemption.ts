import { Transaction } from '@bsv/sdk'
import { AuthorizationService, ticketCredential } from '../auth/authorization'
import { unitAnchorAddress } from '../blockchain/anchor'
import { computeTxid, decodeArgusRecords } from '../chain/codec'
import type { ChainApi } from '../chain/types'
import { DeviceWallet } from '../chain/wallet'
import { IndexedDbWalletStateStore } from '../chain/walletStore'
import { WhatsOnChainApi } from '../chain/woc'
import { canonicalize } from '../distributed/canonical'
import { MAX_CLOCK_JUMP, authorBoundEventId, isAuthorBoundEventId, unsignedEventJson } from '../distributed/replica'
import type { ArgusRole, SignedArgusEvent, UnsignedArgusEvent } from '../distributed/types'
import { WebCryptoIdentityProvider, type ArgusIdentityProvider } from '../identity/identity'
import { decodeTicketCode } from '../identity/ticketCode'
import { deriveTicketKeys, signWithTicketKey, type TicketKeys } from '../identity/ticketKeys'
import { parseTicketPackage, parseTicketRedeemedFact } from '../private-sync/schema'
import { openTicketRecord, sealTicketRecord } from '../private-sync/ticketRecord'
import type { TicketPackage, TicketRedeemedFact } from '../private-sync/types'
import { deserializeEnvelope, openEnvelope, sealEnvelope, serializeEnvelope } from './envelope'
import { IndexedDbLedgerStore, type LedgerStore } from './ledgerStore'
import type { UnitRuntimeOptions } from './runtime'
import { ChainTransport } from './transport'
import { completeTicketRedemption, forgetRedemption, readRedemption, sealRedemption, type UnlockedDevice } from './vault'

/*
 * Redeeming an admission ticket on a fresh device (docs/adr/012-admission-by-invitation-ticket.md). The code alone leads to the ticket's
 * address; its TICKET record is read from the chain with no wallet and no keys; the device checks it (the issuer's signature and standing,
 * the expiry, the funding output still unspent) and redeems by spending that output in one transaction carrying its signed
 * TICKET_REDEEMED record and the unit-history fact. The network lets the output be spent once, so it alone decides single use.
 */

/** What a person is told when a ticket cannot be used, in words a cadet can act on (the code reader's own three come from TicketCodeError). */
export const TICKET_REFUSALS = {
  EXPIRED: 'This ticket has expired; ask for a new one.',
  CANCELLED: 'This ticket was cancelled.',
  USED: 'This ticket was already used on another device.',
  NOT_ON_NETWORK: 'This ticket is not on the network yet. Ask the person who made it to open A.R.G.U.S. while online, then try again.',
  DAMAGED: 'This ticket could not be checked: its record is damaged or was not made by your unit. Ask for a new one.',
} as const
export type TicketRefusalReason = keyof typeof TICKET_REFUSALS
export class TicketRefusal extends Error {
  constructor(readonly reason: TicketRefusalReason) { super(TICKET_REFUSALS[reason]); this.name = 'TicketRefusal' }
}

/** A ticket read from the chain and checked: what the gate shows before "Join" (unit, issuer, person, role), and what redeeming needs. */
export type OpenedTicket = { code: string; keys: TicketKeys; ticket: TicketPackage; ticketId: string; unitName: string; issuerDisplayName: string; displayName: string; role: ArgusRole; expiresAt: string; checkedAt: string }
export type TicketRedemptionResult = { status: 'ACTIVE' | 'PENDING'; device: UnlockedDevice; txid: string }
type ReadOptions = { api?: ChainApi; now?: () => Date }
/** A spend of the ticket's funding by this txid is this device's own redemption, not a refusal. */
type OpenOptions = ReadOptions & { ownSpend?: string }

const fromB64url = (value: string): Uint8Array<ArrayBuffer> => { const normalized = value.replaceAll('-', '+').replaceAll('_', '/'); return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)) }
const MAX_HISTORY_PAGES = 20
const inputsOf = (hex: string) => Transaction.fromHex(hex).inputs.map(input => `${input.sourceTXID}:${input.sourceOutputIndex}`)
const outpoint = (funding: { txid: string; vout: number }) => `${funding.txid}:${funding.vout}`

/** Every transaction at the ticket's address, oldest first, with the outputs it spends and its `T` records opened (or not). */
export async function ticketHistory(api: ChainApi, keys: TicketKeys) {
  const txids: string[] = []
  let token: string | undefined, pages = 0
  do { const page = await api.confirmedHistory(keys.address, token ? { token } : {}); txids.push(...page.items.map(item => item.txid)); token = page.nextToken; pages++ } while (token && pages < MAX_HISTORY_PAGES)
  for (const txid of await api.unconfirmedHistory(keys.address)) if (!txids.includes(txid)) txids.push(txid)
  const entries: Array<{ txid: string; spends: string[]; records: Array<{ value?: unknown }> }> = []
  for (const txid of txids) {
    const hex = (await api.txHex(txid)).trim().toLowerCase()
    let records, spends: string[]
    // A transaction whose bytes are not the ones its txid names was changed on the way: every record in it counts as damaged.
    try { if (computeTxid(hex) !== txid) throw new Error('altered'); records = decodeArgusRecords(hex).filter(record => record.kind === 'T'); spends = inputsOf(hex) } catch { entries.push({ txid, spends: [], records: [{}] }); continue }
    const opened: Array<{ value?: unknown }> = []
    for (const record of records) opened.push(await openTicketRecord(keys.wrappingKey, keys.address, record.payload).then(value => ({ value }), () => ({})))
    entries.push({ txid, spends, records: opened })
  }
  return entries
}

/** The first TICKET record at the address that is genuine: for this ticket key, and signed by someone the unit's authority lets issue it. */
async function genuinePackage(entries: Awaited<ReturnType<typeof ticketHistory>>, keys: TicketKeys, at: string) {
  const verifier = await WebCryptoIdentityProvider.create()
  for (const { records } of entries) for (const { value } of records) {
    if ((value as { kind?: unknown } | undefined)?.kind !== 'TICKET') continue
    let ticket: TicketPackage
    try { ticket = parseTicketPackage(value) } catch { continue }
    const { invitation } = ticket
    if (invitation.ticketPublicKey !== keys.publicIdentity || ticket.unit.unitId !== invitation.unitId || !ticket.epochKeys.some(entry => entry.epochId === ticket.currentEpoch)) continue
    // Link 1, against the authority the ticket names: a made-up ticket names an authority whose chain its invitation cannot show.
    if (await new AuthorizationService(ticket.unit.authorityIdentity, verifier).verifyInvitation(invitation, ticket.issuerCredentials, at, { acceptTicketProofs: true }).then(() => true, () => false)) return ticket
  }
  return undefined
}

/** No single clock is trusted: the later of this device's and the chain's own (a phone set back gains nothing). */
export async function ticketCheckTime(api: ChainApi, now?: () => Date) {
  const chainTime = await api.tipTime().catch(() => undefined)
  return new Date(Math.max((now?.() ?? new Date()).getTime(), chainTime ? Date.parse(chainTime) : 0)).toISOString()
}
/** Refuses a ticket whose funding output was spent (by anyone but this device's own redemption `ownSpend`), or that ran out unspent. */
export function refuseSpentOrExpired(entries: Awaited<ReturnType<typeof ticketHistory>>, invitation: { funding: { txid: string; vout: number }; expiresAt: string }, checkedAt: string, ownSpend?: string) {
  const spender = entries.find(entry => entry.spends.includes(outpoint(invitation.funding)))
  if (spender && spender.txid !== ownSpend) throw new TicketRefusal(spender.records.some(record => (record.value as { kind?: unknown } | undefined)?.kind === 'TICKET_CANCELLED') ? 'CANCELLED' : 'USED')
  if (!spender && Date.parse(checkedAt) >= Date.parse(invitation.expiresAt)) throw new TicketRefusal('EXPIRED')
}

async function openTicket(code: string, options: OpenOptions): Promise<OpenedTicket> {
  const keys = await deriveTicketKeys(decodeTicketCode(code)), api = options.api ?? new WhatsOnChainApi()
  const entries = await ticketHistory(api, keys)
  const checkedAt = await ticketCheckTime(api, options.now)
  const ticket = await genuinePackage(entries, keys, checkedAt)
  if (!ticket) throw new TicketRefusal(entries.some(entry => entry.records.length) ? 'DAMAGED' : 'NOT_ON_NETWORK')
  const { invitation } = ticket
  refuseSpentOrExpired(entries, invitation, checkedAt, options.ownSpend)
  return { code, keys, ticket, ticketId: invitation.ticketId, unitName: ticket.unit.unitName, issuerDisplayName: ticket.issuerDisplayName, displayName: invitation.displayName, role: invitation.role, expiresAt: invitation.expiresAt, checkedAt }
}

/**
 * Reads a ticket from its code (typed or scanned; spaces, hyphens, case and O/I/L look-alikes do not matter) and checks it, spending
 * nothing and needing no wallet: refused in plain words when it has expired, was cancelled or already used, is not on the network yet,
 * or is damaged or made up; a code that is not a ticket code is refused by the code reader (TicketCodeError).
 */
export const readTicket = (code: string, options: ReadOptions = {}) => openTicket(code, options)

/**
 * The unit's history read with the ticket's keys, so the TICKET_REDEEMED fact follows everything this device has seen (Lamport clock).
 * Only genuine records count, and none that jumps further ahead than the fold allows, so a forged record cannot push the fact out of reach.
 */
async function unitHistory(input: { api: ChainApi; wallet: DeviceWallet; ledger: LedgerStore; ticket: TicketPackage; unitKeys: Map<string, CryptoKey>; verifier: ArgusIdentityProvider }) {
  const keyFor = async (epochId: string) => input.unitKeys.get(epochId), unitId = input.ticket.unit.unitId
  const transport = new ChainTransport({ unitId, api: input.api, wallet: input.wallet, store: input.ledger, onRemoteEnvelopes: async () => undefined, checkEnvelope: async envelope => { try { await openEnvelope(envelope, keyFor); return 'valid' } catch (error) { return error instanceof Error && error.message.startsWith('NO_EPOCH_KEY') ? 'unknown' : 'invalid' } } })
  await transport.scanOnce()
  const clocks: number[] = []
  let issued = false
  for (const record of await input.ledger.envelopes()) {
    let event: SignedArgusEvent
    try { event = (await openEnvelope(record.envelope, keyFor)).event } catch { continue } // written under a later key generation: not readable with this ticket's keys yet
    if (!(await isAuthorBoundEventId(event.eventId, event.actorPublicIdentity)) || !(await input.verifier.verify(unsignedEventJson(event), event.signature, event.actorPublicIdentity))) continue
    clocks.push(event.clock ?? 0)
    if (event.eventType === 'TICKET_ISSUED' && event.entityId === input.ticket.invitation.ticketId) issued = true
  }
  const clock = clocks.sort((a, b) => a - b).reduce((max, next) => next <= max + MAX_CLOCK_JUMP ? Math.max(max, next) : max, 0)
  return { clock, issued }
}

/** Builds and queues (never broadcasts) the redemption: the funding output spent by the ticket key, carrying both records. */
async function prepareRedemption(device: UnlockedDevice, opened: OpenedTicket, input: { api: ChainApi; wallet: DeviceWallet; ledger: LedgerStore; now: () => Date; marker: string }) {
  const { ticket, keys } = opened, { invitation } = ticket, { record } = device, unitId = ticket.unit.unitId
  const unitKeys = new Map<string, CryptoKey>()
  for (const { epochId, key } of ticket.epochKeys) unitKeys.set(epochId, await crypto.subtle.importKey('raw', fromB64url(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']))
  const history = await unitHistory({ api: input.api, wallet: input.wallet, ledger: input.ledger, ticket, unitKeys, verifier: device.identity })
  // The fact must come after the ticket's own announcement in the unit's order, or no device could place it.
  if (!history.issued) throw new TicketRefusal('NOT_ON_NETWORK')
  const redeemedAt = new Date(Math.max(input.now().getTime(), Date.parse(opened.checkedAt), Date.parse(invitation.issuedAt))).toISOString()
  if (Date.parse(redeemedAt) >= Date.parse(invitation.expiresAt)) throw new TicketRefusal('EXPIRED')
  const unsignedRedemption = { kind: 'TICKET_REDEEMED' as const, redemptionVersion: 1 as const, ticketId: invitation.ticketId, unitId, subjectPublicIdentity: record.signingIdentity, ecdhPublicKey: record.ecdhPublicKey, walletAddress: record.walletAddress, redeemedAt }
  const redemption = { ...unsignedRedemption, signature: signWithTicketKey(keys.privateKey, canonicalize(unsignedRedemption)) }
  const fact: TicketRedeemedFact = { ticketId: invitation.ticketId, invitation, issuerCredentials: ticket.issuerCredentials, redemption }
  const unsignedEvent: UnsignedArgusEvent = { protocol: 'ARGUS', protocolVersion: 1, organizationId: unitId, eventVersion: 1, eventId: await authorBoundEventId(record.signingIdentity, crypto.randomUUID()), eventType: 'TICKET_REDEEMED', entityId: invitation.ticketId, actorPublicIdentity: record.signingIdentity, timestamp: redeemedAt, clock: history.clock + 1, payload: { ...fact } }
  const event = { ...unsignedEvent, signature: await device.identity.sign(canonicalize(unsignedEvent)) } as SignedArgusEvent
  const envelope = await sealEnvelope({ unitId, epochId: ticket.currentEpoch, key: unitKeys.get(ticket.currentEpoch)!, plaintext: { event, credential: ticketCredential(fact) } })
  const records = [{ kind: 'T' as const, payload: await sealTicketRecord(keys.wrappingKey, keys.address, redemption) }, { kind: 'E' as const, payload: serializeEnvelope(envelope) }]
  return (await input.wallet.prepareSpendOfOutpoint({ key: keys.privateKey, outpoint: invitation.funding, records, markerAddress: keys.address, alsoMarkAddresses: [unitAnchorAddress(unitId)], correlationIds: [input.marker] })).txid
}

/**
 * Redeems a ticket on a fresh device (PENDING, of no unit): `ticket` is what readTicket returned (or the code, read now). Builds the
 * redemption, keeps it sealed with the code until the network decides, and broadcasts it. Accepted: the device takes the unit's keys,
 * the ticket's role and the named person's name, and its TICKET_REDEEMED fact goes into its local copy as delivered from the chain;
 * it is ACTIVE on its own (D5), needing no satoshis of its own (the redemption's change is its wallet's first coins). Unanswered:
 * PENDING, nothing of the unit installed; resumeTicketRedemption (or the same call again) sends the very same transaction. Refused
 * by the network because someone spent the ticket first: says who in plain words, and keeps nothing.
 */
export async function redeemTicket(device: UnlockedDevice, ticket: OpenedTicket | string, options: UnitRuntimeOptions & { now?: () => Date } = {}): Promise<TicketRedemptionResult> {
  if (device.record.unit || device.record.role !== 'PENDING') throw new Error('This device already belongs to a unit.')
  const api = options.api ?? new WhatsOnChainApi(), storage = options.storage ?? localStorage, now = options.now ?? (() => new Date())
  const inProgress = await readRedemption(device)
  const opened = typeof ticket === 'string' ? await openTicket(ticket, { api, now, ...(inProgress ? { ownSpend: inProgress.txid } : {}) }) : ticket
  const { invitation } = opened.ticket
  if (inProgress && inProgress.ticketId !== invitation.ticketId) throw new Error('This device is already joining with another ticket.')
  const ledger = options.ledger ?? new IndexedDbLedgerStore(opened.ticket.unit.unitId)
  const wallet = DeviceWallet.fromWif(device.walletWif, api, options.walletStore ?? new IndexedDbWalletStateStore())
  const marker = `redeem:${invitation.ticketId}`
  let txid = inProgress?.txid ?? (await wallet.pending()).find(tx => tx.correlationIds.includes(marker))?.txid
  if (!txid) txid = await prepareRedemption(device, opened, { api, wallet, ledger, now, marker })
  if (!inProgress) await sealRedemption(device, { ticketId: invitation.ticketId, code: opened.code, txid }, storage)

  const flushed = await wallet.flush()
  if ((await wallet.pending()).some(tx => tx.txid === txid)) return { status: 'PENDING', device, txid }
  const hex = await wallet.ownTxHex(txid)
  if (!hex) {
    forgetRedemption(device, storage)
    const refused = flushed.rolledBack.find(entry => entry.txid === txid)
    if (refused && refused.status !== 'conflict') throw new Error(`The network refused this redemption (${refused.reason}). Try again.`)
    // The funding output was spent first: by a cancellation, or by another device's redemption. Read which, and say so.
    await openTicket(opened.code, { api, now })
    // The address does not show the spender yet (an index lags the network), but the network said the output is spent.
    if (refused) throw new TicketRefusal('USED')
    throw new Error('This redemption did not reach the network. Try again.')
  }
  // Accepted. The fact in it is this device's admission: kept as delivered from the chain, with the spend that proves it.
  const envelope = deserializeEnvelope(decodeArgusRecords(hex).find(record => record.kind === 'E')!.payload), spends = [outpoint(invitation.funding)]
  const epochKey = opened.ticket.epochKeys.find(entry => entry.epochId === envelope.epoch)!
  const key = await crypto.subtle.importKey('raw', fromB64url(epochKey.key), { name: 'AES-GCM' }, false, ['decrypt'])
  const fact = parseTicketRedeemedFact((await openEnvelope(envelope, async () => key)).event.payload)
  if (!(await ledger.addEnvelope({ eventId: envelope.eventId, envelope, origin: 'chain', status: 'CONFIRMED', txid, height: 0, spends, addedAt: new Date().toISOString() }))) await ledger.updateEnvelopes([envelope.eventId], { spends })
  return { status: 'ACTIVE', device: await completeTicketRedemption(device, { ticket: opened.ticket, credential: ticketCredential(fact) }, storage), txid }
}

/** Finishes a redemption a restart or an unanswered network left PENDING, with the same transaction. Undefined when none is in progress. */
export async function resumeTicketRedemption(device: UnlockedDevice, options: UnitRuntimeOptions & { now?: () => Date } = {}) {
  const inProgress = await readRedemption(device)
  return inProgress ? redeemTicket(device, inProgress.code, options) : undefined
}
