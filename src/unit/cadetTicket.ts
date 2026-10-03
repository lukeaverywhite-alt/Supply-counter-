import { P2PKH, SatoshisPerKilobyte, Transaction } from '@bsv/sdk'
import { anchorLockingScript, channelAddress } from '../blockchain/anchor'
import { assertTestnetAddress, computeTxid, encodeArgusRecordScript } from '../chain/codec'
import type { ChainApi } from '../chain/types'
import { DEFAULT_FEE_SAT_PER_KB } from '../chain/wallet'
import { WhatsOnChainApi } from '../chain/woc'
import { decodeTicketCode } from '../identity/ticketCode'
import { deriveTicketKeys, type TicketKeys } from '../identity/ticketKeys'
import { MAX_DEVICE_LABEL_LENGTH, parseCadetTicketPackage } from '../private-sync/schema'
import type { CadetJoinedRecord, CadetTicketPackage } from '../private-sync/types'
import { importChannelKey, sealToChannel, serializeChannelEnvelope } from './envelope'
import { TicketRefusal, refuseSpentOrExpired, ticketCheckTime, ticketHistory } from './ticketRedemption'
import { CADET_VAULT_STORAGE_KEY, DEVICE_VAULT_STORAGE_KEY, completeCadetRedemption, createCadetVault, forgetCadetRedemption, loadCadetVault, readCadetRedemption, sealCadetRedemption, unlockCadetDevice, validatePassphrase, type CadetDevice, type UnlockedCadetDevice } from './vault'

/*
 * Redeeming a cadet's ticket on the cadet's own phone (docs/adr/013-cadet-channels.md, mw-kmgi38.2). The code leads to the ticket's
 * address, as a staff ticket's does (ADR 012); its CADET record carries the cadet's channel key and address and the unit's notices
 * key and address, and nothing of the unit. The phone redeems by spending the ticket's funding output in one transaction that seals a
 * CADET_JOINED record to the cadet's channel and sends what is left of the starter satoshis back to the issuer, so the network alone
 * decides single use. The phone then holds a CadetDevice sealed under its passphrase: no unit key, no wallet, no unit credential.
 */

/** A cadet ticket read from the chain and checked: what the gate shows before "Join", and what redeeming needs. */
export type OpenedCadetTicket = { code: string; keys: TicketKeys; ticket: CadetTicketPackage; ticketId: string; cadetId: string; displayName: string; unitName: string; expiresAt: string; checkedAt: string }
export type CadetRedemptionResult = { status: 'ACTIVE' | 'PENDING'; device: UnlockedCadetDevice; txid: string }
type ReadOptions = { api?: ChainApi; now?: () => Date }
export type CadetRedeemOptions = ReadOptions & { storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> }
/** What a phone calls itself in its CADET_JOINED record when it is not told. */
export const DEFAULT_DEVICE_LABEL = 'Phone'
const MARKER_SATOSHIS = 1

/** The first CADET record at the address that is for this ticket key and whose addresses are the ones its keys give. */
function genuineCadetPackage(entries: Awaited<ReturnType<typeof ticketHistory>>, keys: TicketKeys) {
  for (const { records } of entries) for (const { value } of records) {
    if ((value as { kind?: unknown } | undefined)?.kind !== 'CADET') continue
    let ticket: CadetTicketPackage
    try { ticket = parseCadetTicketPackage(value) } catch { continue }
    if (ticket.invitation.ticketPublicKey !== keys.publicIdentity || channelAddress(ticket.channelKey) !== ticket.channelAddress || channelAddress(ticket.noticesKey) !== ticket.noticesAddress) continue
    return ticket
  }
  return undefined
}

async function openCadetTicket(code: string, options: ReadOptions & { ownSpend?: string }): Promise<OpenedCadetTicket> {
  const keys = await deriveTicketKeys(decodeTicketCode(code)), api = options.api ?? new WhatsOnChainApi()
  const entries = await ticketHistory(api, keys), checkedAt = await ticketCheckTime(api, options.now)
  const ticket = genuineCadetPackage(entries, keys)
  if (!ticket) throw new TicketRefusal(entries.some(entry => entry.records.length) ? 'DAMAGED' : 'NOT_ON_NETWORK')
  const { invitation } = ticket
  refuseSpentOrExpired(entries, invitation, checkedAt, options.ownSpend)
  return { code, keys, ticket, ticketId: invitation.ticketId, cadetId: invitation.cadetId, displayName: invitation.displayName, unitName: ticket.unit.unitName, expiresAt: invitation.expiresAt, checkedAt }
}

/**
 * Reads a cadet's ticket from its code and checks it, spending nothing and needing no wallet: refused in plain words when it has
 * expired, was cancelled or already used, is not on the network yet, or is damaged (a staff ticket's code is not a cadet ticket).
 */
export const readCadetTicket = (code: string, options: ReadOptions = {}) => openCadetTicket(code, options)

/** The redemption: the funding output spent by the ticket key; a CADET_JOINED record sealed to the cadet's channel; the rest back to the issuer. */
async function buildRedemption(api: ChainApi, opened: OpenedCadetTicket, joined: CadetJoinedRecord) {
  const { ticket, keys } = opened, { invitation } = ticket, { funding } = invitation
  assertTestnetAddress(invitation.returnAddress, 'Return address')
  const envelope = await sealToChannel({ channelId: ticket.channelAddress, key: await importChannelKey(ticket.channelKey), kind: 'joined', plaintext: joined })
  const sourceHex = (await api.txHex(funding.txid)).trim().toLowerCase()
  if (computeTxid(sourceHex) !== funding.txid) throw new TicketRefusal('DAMAGED')
  const source = Transaction.fromHex(sourceHex)
  if (source.outputs[funding.vout]?.lockingScript.toHex() !== new P2PKH().lock(keys.address).toHex()) throw new TicketRefusal('DAMAGED')
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: source, sourceOutputIndex: funding.vout, unlockingScriptTemplate: new P2PKH().unlock(keys.privateKey) })
  tx.addOutput({ lockingScript: encodeArgusRecordScript({ kind: 'C', payload: serializeChannelEnvelope(envelope) }), satoshis: 0 })
  // Markers: the spend shows at the ticket's address (a second phone reads it was used) and at the channel's (staff find the record).
  for (const marker of [keys.address, ticket.channelAddress]) tx.addOutput({ lockingScript: anchorLockingScript(marker), satoshis: MARKER_SATOSHIS })
  tx.addOutput({ lockingScript: new P2PKH().lock(invitation.returnAddress), change: true })
  try { await tx.fee(new SatoshisPerKilobyte(DEFAULT_FEE_SAT_PER_KB)) } catch (error) { if (error instanceof RangeError) throw new Error('The ticket’s funding is too small to pay for joining.', { cause: error }); throw error }
  await tx.sign()
  return { txid: tx.id('hex'), hex: tx.toHex() }
}

/**
 * Redeems a cadet's ticket on a fresh phone: `ticket` is what readCadetTicket returned (or the code, read now). Makes the phone's
 * cadet record under `passphrase` (or unlocks the one a PENDING redemption left), builds the redemption, keeps it sealed until the
 * network decides, and broadcasts it. Accepted: the phone holds its CadetDevice and is in cadet mode (ACTIVE). Unanswered: PENDING;
 * resumeCadetRedemption (or the same call again) sends the very same transaction. Refused because the output was spent first: says
 * who in plain words, and keeps nothing.
 */
export async function redeemCadetTicket(ticket: OpenedCadetTicket | string, input: { passphrase: string; deviceLabel?: string }, options: CadetRedeemOptions = {}): Promise<CadetRedemptionResult> {
  const api = options.api ?? new WhatsOnChainApi(), storage = options.storage ?? localStorage, now = options.now ?? (() => new Date())
  const deviceLabel = (input.deviceLabel ?? DEFAULT_DEVICE_LABEL).trim()
  if (!deviceLabel || deviceLabel.length > MAX_DEVICE_LABEL_LENGTH) throw new Error(`Name this phone in 1–${MAX_DEVICE_LABEL_LENGTH} characters.`)
  if (storage.getItem(DEVICE_VAULT_STORAGE_KEY)) throw new Error('This device already belongs to a unit.')
  const stored = loadCadetVault(storage)
  if (!stored) validatePassphrase(input.passphrase)
  let device = stored ? await unlockCadetDevice(stored, input.passphrase) : undefined, created = false
  if (device?.cadet) throw new Error('This phone already belongs to a cadet.')
  const inProgress = device ? await readCadetRedemption(device) : undefined
  const opened = typeof ticket === 'string' ? await openCadetTicket(ticket, { api, now, ...(inProgress ? { ownSpend: inProgress.txid } : {}) }) : ticket
  const { invitation } = opened.ticket
  if (inProgress && inProgress.ticketId !== invitation.ticketId) throw new Error('This phone is already joining with another ticket.')

  let redemption = inProgress
  if (!redemption) {
    const joinedAt = new Date(Math.max(now().getTime(), Date.parse(opened.checkedAt), Date.parse(invitation.issuedAt))).toISOString()
    if (Date.parse(joinedAt) >= Date.parse(invitation.expiresAt)) throw new TicketRefusal('EXPIRED')
    redemption = { ticketId: invitation.ticketId, code: opened.code, joinedAt, ...await buildRedemption(api, opened, { kind: 'CADET_JOINED', joinedAt, deviceLabel }) }
    if (!device) { device = await createCadetVault(input.passphrase, storage); created = true }
    // Sealed before it is sent: a restart resends these very bytes, never a second, conflicting spend.
    await sealCadetRedemption(device, redemption, storage)
  }
  const outcome = await api.broadcast(redemption.hex).catch((error: unknown) => ({ status: 'ambiguous' as const, message: error instanceof Error ? error.message : String(error) }))
  if (!device) throw new Error('This phone’s redemption was lost.')
  if (outcome.status === 'ambiguous') return { status: 'PENDING', device, txid: redemption.txid }
  if (outcome.status === 'accepted') {
    const { ticket: { unit, channelKey, channelAddress: channel, noticesKey, noticesAddress } } = opened
    const cadet: CadetDevice = { cadetId: invitation.cadetId, displayName: invitation.displayName, unit: { unitId: unit.unitId, unitName: unit.unitName }, channelKey, channelAddress: channel, noticesKey, noticesAddress, joinedAt: redemption.joinedAt }
    return { status: 'ACTIVE', device: await completeCadetRedemption(device, cadet, storage), txid: redemption.txid }
  }
  // Refused: the phone keeps nothing, so it can try another code under another passphrase.
  if (created) storage.removeItem(CADET_VAULT_STORAGE_KEY); else forgetCadetRedemption(device, storage)
  if (outcome.status !== 'conflict') throw new Error(`The network refused this redemption (${outcome.message}). Try again.`)
  // The funding output was spent first: by a cancellation, or by another phone. Read which, and say so.
  await openCadetTicket(opened.code, { api, now })
  throw new TicketRefusal('USED')
}

/** Finishes a cadet redemption a restart or an unanswered network left PENDING, with the same transaction. Undefined when none is in progress. */
export async function resumeCadetRedemption(input: { passphrase: string }, options: CadetRedeemOptions = {}) {
  const stored = loadCadetVault(options.storage ?? localStorage); if (!stored) return undefined
  const inProgress = await readCadetRedemption(await unlockCadetDevice(stored, input.passphrase))
  return inProgress ? redeemCadetTicket(inProgress.code, input, options) : undefined
}
