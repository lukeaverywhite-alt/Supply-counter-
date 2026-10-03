import { canonicalize } from '../distributed/canonical'
import { parseTicketChainRecord } from './schema'
import type { TicketChainRecord } from './types'

/**
 * The bytes of a `'T'` record at a ticket address (ADR 012): canonical JSON `{ v: 1, nonce, ct }` and nothing else. `ct` is
 * AES-256-GCM under the ticket's wrapping key with a fresh 12-byte nonce and the additional data `{ v: 1, address }`, so a
 * record cannot be replayed at another ticket's address.
 */
const b64url = (bytes: Uint8Array) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
const fromB64url = (value: string): Uint8Array<ArrayBuffer> => { const normalized = value.replaceAll('-', '+').replaceAll('_', '/'); return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)) }
const associatedData = (address: string) => new TextEncoder().encode(canonicalize({ v: 1, address }))

export async function sealTicketRecord(wrappingKey: CryptoKey, address: string, plaintext: object): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: associatedData(address) }, wrappingKey, new TextEncoder().encode(canonicalize(plaintext)))
  const record: TicketChainRecord = { v: 1, nonce: b64url(nonce), ct: b64url(new Uint8Array(ct)) }
  return new TextEncoder().encode(canonicalize(record))
}

/** The decrypted JSON of a ticket record, or an error saying it could not be opened (wrong ticket, wrong address, damaged). Not yet checked for shape: pass it to a parseTicket* validator. */
export async function openTicketRecord(wrappingKey: CryptoKey, address: string, payload: Uint8Array): Promise<unknown> {
  try {
    const record = parseTicketChainRecord(JSON.parse(new TextDecoder().decode(payload)))
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64url(record.nonce), additionalData: associatedData(address) }, wrappingKey, fromB64url(record.ct))
    return JSON.parse(new TextDecoder().decode(clear))
  } catch (cause) {
    throw new Error('This ticket record could not be opened.', { cause })
  }
}
