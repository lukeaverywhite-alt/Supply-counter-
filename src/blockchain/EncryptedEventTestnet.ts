import { canonicalize, sha256 } from '../distributed/canonical'
import { parseEncryptedEnvelope } from '../private-sync/schema'
import type { EncryptedArgusEnvelope } from '../private-sync/types'
import { assertTestnetOnly } from './ArgusWalletAdapter'

/** Minimal subset of the current BRC-100 createAction contract used by A.R.G.U.S. */
export interface Brc100TestnetWallet {
  getNetwork(): Promise<{ network: 'mainnet' | 'testnet' }>
  createAction(args: {
    description: string
    outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string; tags: string[] }>
    labels: string[]
    options: { acceptDelayedBroadcast: false; returnTXIDOnly: false; randomizeOutputs: false }
  }): Promise<{ txid?: string; tx?: number[] | Uint8Array; sendWithResults?: Array<{ txid: string; status: string }> }>
}

export type IndexedChainRecord = { transactionId: string; lockingScript: string; blockHeight?: number; merkleProof?: number[] }
export interface ArgusOverlayClient {
  history(query: { organizationId: string; cursor?: string; limit: number }): Promise<{ records: IndexedChainRecord[]; nextCursor?: string; complete: boolean }>
  event(eventId: string): Promise<IndexedChainRecord | undefined>
}

const utf8 = new TextEncoder()
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, '0')).join('')
const unhex = (value: string) => Uint8Array.from(value.match(/.{2}/g)?.map(byte => Number.parseInt(byte, 16)) ?? [])
const push = (length: number) => length <= 75 ? Uint8Array.of(length) : length <= 0xff ? Uint8Array.of(0x4c, length) : length <= 0xffff ? Uint8Array.of(0x4d, length & 255, length >>> 8) : (() => { throw new Error('Encrypted event is too large for the supported data envelope.') })()
const concat = (...parts: Uint8Array[]) => { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length } return result }

/** Encodes the complete authenticated ciphertext envelope, not a hash-only commitment. */
export function encodeEventOutput(input: EncryptedArgusEnvelope) {
  const envelope = parseEncryptedEnvelope(input)
  const payload = utf8.encode(canonicalize(envelope))
  return hex(concat(Uint8Array.of(0x00, 0x6a), push(payload.length), payload))
}

export function decodeEventOutput(lockingScript: string) {
  const bytes = unhex(lockingScript)
  if (bytes[0] !== 0x00 || bytes[1] !== 0x6a) throw new Error('Transaction output is not an A.R.G.U.S. data output.')
  let length = bytes[2], offset = 3
  if (length === 0x4c) { length = bytes[3]; offset = 4 }
  else if (length === 0x4d) { length = bytes[3] | bytes[4] << 8; offset = 5 }
  if (offset + length !== bytes.length) throw new Error('A.R.G.U.S. data output length is invalid.')
  return parseEncryptedEnvelope(JSON.parse(new TextDecoder().decode(bytes.slice(offset))))
}

export class EncryptedEventTestnetAdapter {
  constructor(private wallet: Brc100TestnetWallet, private overlay: ArgusOverlayClient, private organizationId: string) {}
  private async testnet() { const { network } = await this.wallet.getNetwork(); assertTestnetOnly(network.toUpperCase()) }
  async publish(envelope: EncryptedArgusEnvelope) {
    await this.testnet()
    const parsed = parseEncryptedEnvelope(envelope)
    if (parsed.organizationId !== this.organizationId) throw new Error('Cannot publish an event for another organization.')
    // Resolving the stable event ID before funding another action makes an
    // ambiguous wallet/broadcast timeout safe to retry.
    const known = await this.overlay.event(parsed.eventId).catch(() => undefined)
    if (known) return { transactionId: known.transactionId, duplicate: true, state: known.blockHeight === undefined ? 'BROADCAST' : 'CONFIRMED' as const }
    const result = await this.wallet.createAction({ description: 'Publish encrypted ARGUS event', outputs: [{ lockingScript: encodeEventOutput(parsed), satoshis: 1, outputDescription: 'Encrypted ARGUS event record', tags: [`argus-org-${await sha256(this.organizationId)}`, `argus-event-${parsed.eventId}`] }], labels: ['argus-encrypted-history'], options: { acceptDelayedBroadcast: false, returnTXIDOnly: false, randomizeOutputs: false } })
    if (!result.txid || !/^[0-9a-f]{64}$/i.test(result.txid)) throw new Error('Testnet wallet did not durably acknowledge a transaction ID; query before retrying.')
    return { transactionId: result.txid, duplicate: false, state: 'BROADCAST' as const, preparedTransaction: result.tx ? [...result.tx] : undefined }
  }
  async retrieve(cursor?: string, limit = 100) {
    await this.testnet()
    const page = await this.overlay.history({ organizationId: this.organizationId, cursor, limit })
    const records = page.records.map(record => ({ ...record, envelope: decodeEventOutput(record.lockingScript), verification: record.merkleProof ? 'MERKLE_PROOF_PRESENT' as const : record.blockHeight === undefined ? 'BROADCAST' as const : 'INCLUSION_UNVERIFIED' as const }))
    for (const record of records) if (record.envelope.organizationId !== this.organizationId) throw new Error('Overlay returned an event for another organization.')
    return { records, nextCursor: page.nextCursor, complete: page.complete }
  }
}
