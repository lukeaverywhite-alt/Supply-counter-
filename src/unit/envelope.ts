import { canonicalize } from '../distributed/canonical'
import type { AuthorityCredential, SignedArgusEvent } from '../distributed/types'
import { parseSignedEvent } from '../private-sync/schema'

/**
 * Encrypted A.R.G.U.S. envelope, version 2 — the only thing a unit ever writes to BSV.
 *
 * Public (visible to anyone reading the testnet chain): format version, opaque unit ID, key
 * epoch, random event ID, nonce and ciphertext. Everything else — who acted, what they did, when,
 * cadet IDs and names, sizes, quantities, member display names — is inside AES-256-GCM
 * ciphertext under the unit data key, which only admitted devices hold. The public header is the
 * GCM additional data, so it cannot be altered or replayed under another unit/event ID.
 *
 * Authenticity does not rely on the envelope: the inner event carries the actor's ECDSA
 * signature, and the actor's Master-signed credential travels with it so any member can check
 * the actor's role without contacting anyone.
 */
export type UnitEnvelope = { v: 2; unit: string; epoch: string; eventId: string; z: 0 | 1; nonce: string; ct: string }
export type UnitEnvelopePlaintext = { event: SignedArgusEvent; credential?: AuthorityCredential }

const encoder = new TextEncoder(), decoder = new TextDecoder()
const MAX_ENVELOPE_BYTES = 60 * 1024
export const bytesToBase64 = (bytes: Uint8Array) => { let binary = ''; for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000)); return btoa(binary) }
export const base64ToBytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))
const aad = (envelope: Pick<UnitEnvelope, 'v' | 'unit' | 'epoch' | 'eventId' | 'z'>) => encoder.encode(canonicalize({ v: envelope.v, unit: envelope.unit, epoch: envelope.epoch, eventId: envelope.eventId, z: envelope.z }))
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer

async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const output = new Blob([buffer(bytes)]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(output).arrayBuffer())
}
/** Deflate when the runtime supports it; envelopes record whether they were compressed so any device can read any other's. */
async function compress(bytes: Uint8Array): Promise<{ z: 0 | 1; bytes: Uint8Array }> {
  if (typeof CompressionStream === 'undefined') return { z: 0, bytes }
  try { const packed = await transform(bytes, new CompressionStream('deflate-raw')); return packed.length < bytes.length ? { z: 1, bytes: packed } : { z: 0, bytes } } catch { return { z: 0, bytes } }
}
async function decompress(bytes: Uint8Array, z: 0 | 1) {
  if (!z) return bytes
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed A.R.G.U.S. records; update it.')
  return transform(bytes, new DecompressionStream('deflate-raw'))
}

export async function sealEnvelope(input: { unitId: string; epochId: string; key: CryptoKey; plaintext: UnitEnvelopePlaintext }): Promise<UnitEnvelope> {
  const { event } = input.plaintext
  if (event.organizationId !== input.unitId) throw new Error('Event belongs to a different unit.')
  const packed = await compress(encoder.encode(JSON.stringify(input.plaintext)))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = { v: 2 as const, unit: input.unitId, epoch: input.epochId, eventId: event.eventId, z: packed.z }
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(header), tagLength: 128 }, input.key, buffer(packed.bytes)))
  const envelope: UnitEnvelope = { ...header, nonce: bytesToBase64(nonce), ct: bytesToBase64(ciphertext) }
  if (serializeEnvelope(envelope).length > MAX_ENVELOPE_BYTES) throw new Error('This record is too large to publish.')
  return envelope
}

export async function openEnvelope(envelope: UnitEnvelope, keyFor: (epochId: string) => Promise<CryptoKey | undefined>): Promise<UnitEnvelopePlaintext> {
  const key = await keyFor(envelope.epoch)
  if (!key) throw new Error(`NO_EPOCH_KEY: this device has no key for ${envelope.epoch}.`)
  let clear: Uint8Array
  try { clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(base64ToBytes(envelope.nonce)), additionalData: aad(envelope), tagLength: 128 }, key, buffer(base64ToBytes(envelope.ct)))) }
  catch { throw new Error('Envelope authentication failed: wrong unit key or tampered record.') }
  const parsed = JSON.parse(decoder.decode(await decompress(clear, envelope.z))) as { event?: unknown; credential?: AuthorityCredential }
  const event = parseSignedEvent(parsed.event)
  if (event.eventId !== envelope.eventId || event.organizationId !== envelope.unit) throw new Error('Envelope header does not match its event.')
  return { event, ...(parsed.credential ? { credential: parsed.credential } : {}) }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function parseEnvelope(value: unknown): UnitEnvelope {
  if (!record(value) || value.v !== 2 || (value.z !== 0 && value.z !== 1)) throw new Error('Unsupported A.R.G.U.S. envelope.')
  for (const field of ['unit', 'epoch', 'eventId', 'nonce', 'ct'] as const) if (typeof value[field] !== 'string' || !value[field] || (value[field] as string).length > MAX_ENVELOPE_BYTES) throw new Error(`Invalid envelope field: ${field}.`)
  return { v: 2, unit: value.unit as string, epoch: value.epoch as string, eventId: value.eventId as string, z: value.z, nonce: value.nonce as string, ct: value.ct as string }
}
export const serializeEnvelope = (envelope: UnitEnvelope) => encoder.encode(canonicalize(envelope))
export const deserializeEnvelope = (bytes: Uint8Array) => parseEnvelope(JSON.parse(decoder.decode(bytes)))
/** The complete set of fields that ever appear in plaintext on chain. Tests assert nothing else leaks. */
export const PUBLIC_ENVELOPE_FIELDS = ['v', 'unit', 'epoch', 'eventId', 'z', 'nonce', 'ct'] as const

/**
 * Cadet channel envelope, version 3 (ADR 013): a record sealed to ONE channel, a cadet's own or the unit's notices channel, and
 * paid to that channel's address under record kind 'C'. It never carries a unit ID or key epoch: a cadet's phone holds no unit
 * key and cannot open anything sealed under one, and a unit key cannot open this.
 *
 * Public: format version, channel ID (the channel's address), what the record is ('view': the cadet's record; 'notice': a
 * notice), whether it was compressed, nonce and ciphertext. Names, codes, sizes, gear and notice text are inside AES-256-GCM
 * ciphertext under the channel key. The public header is the GCM additional data, so a record cannot be moved to another
 * channel or relabelled. Same 60 KB cap as a unit record. 'joined': the cadet's phone says it joined (CADET_JOINED, mw-kmgi38.2).
 */
export type ChannelRecordKind = 'view' | 'notice' | 'joined'
export type ChannelEnvelope = { v: 3; ch: string; kind: ChannelRecordKind; z: 0 | 1; nonce: string; ct: string }
export const CHANNEL_RECORD_KINDS: readonly ChannelRecordKind[] = ['view', 'notice', 'joined']
/** The complete set of fields of a channel record that appear in plaintext on chain. */
export const PUBLIC_CHANNEL_ENVELOPE_FIELDS = ['v', 'ch', 'kind', 'z', 'nonce', 'ct'] as const
const MAX_CHANNEL_ID_LENGTH = 100
const CHANNEL_KEY_PATTERN = /^[0-9a-fA-F]{64}$/
const channelAad = (envelope: Pick<ChannelEnvelope, 'v' | 'ch' | 'kind' | 'z'>) => encoder.encode(canonicalize({ v: envelope.v, ch: envelope.ch, kind: envelope.kind, z: envelope.z }))
const validChannelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_CHANNEL_ID_LENGTH

/** A fresh channel key: 32 random bytes as 64 lowercase hex characters, the form the unit log records (CADET_CHANNEL_CREATED). */
export const newChannelKey = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
export async function importChannelKey(channelKey: string): Promise<CryptoKey> {
  if (typeof channelKey !== 'string' || !CHANNEL_KEY_PATTERN.test(channelKey)) throw new Error('A channel key is 32 bytes, written as 64 hex characters.')
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(32)
  for (let index = 0; index < 32; index++) bytes[index] = Number.parseInt(channelKey.slice(index * 2, index * 2 + 2), 16)
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function sealToChannel(input: { channelId: string; key: CryptoKey; kind: ChannelRecordKind; plaintext: unknown }): Promise<ChannelEnvelope> {
  if (!validChannelId(input.channelId)) throw new Error('A channel record needs the channel it belongs to.')
  if (!CHANNEL_RECORD_KINDS.includes(input.kind)) throw new Error('Unknown kind of channel record.')
  if (input.plaintext === undefined) throw new Error('A channel record needs content.')
  const packed = await compress(encoder.encode(JSON.stringify(input.plaintext)))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const header = { v: 3 as const, ch: input.channelId, kind: input.kind, z: packed.z }
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: channelAad(header), tagLength: 128 }, input.key, buffer(packed.bytes)))
  const envelope: ChannelEnvelope = { ...header, nonce: bytesToBase64(nonce), ct: bytesToBase64(ciphertext) }
  if (serializeChannelEnvelope(envelope).length > MAX_ENVELOPE_BYTES) throw new Error('This record is too large to publish.')
  return envelope
}

/** Opens a channel record with the channel key; `channelId`, when given, must be the channel the reader expects (its address). */
export async function openFromChannel(envelope: ChannelEnvelope, key: CryptoKey, channelId?: string): Promise<{ kind: ChannelRecordKind; plaintext: unknown }> {
  if (channelId !== undefined && envelope.ch !== channelId) throw new Error('This record belongs to another channel.')
  let clear: Uint8Array
  try { clear = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(base64ToBytes(envelope.nonce)), additionalData: channelAad(envelope), tagLength: 128 }, key, buffer(base64ToBytes(envelope.ct)))) }
  catch { throw new Error('Envelope authentication failed: wrong channel key or tampered record.') }
  return { kind: envelope.kind, plaintext: JSON.parse(decoder.decode(await decompress(clear, envelope.z))) as unknown }
}

export function parseChannelEnvelope(value: unknown): ChannelEnvelope {
  if (!record(value) || value.v !== 3 || (value.z !== 0 && value.z !== 1) || Object.keys(value).sort().join() !== [...PUBLIC_CHANNEL_ENVELOPE_FIELDS].sort().join()) throw new Error('Unsupported A.R.G.U.S. channel envelope.')
  if (!CHANNEL_RECORD_KINDS.includes(value.kind as ChannelRecordKind)) throw new Error('Invalid channel envelope field: kind.')
  if (!validChannelId(value.ch)) throw new Error('Invalid channel envelope field: ch.')
  for (const field of ['nonce', 'ct'] as const) if (typeof value[field] !== 'string' || !value[field] || (value[field] as string).length > MAX_ENVELOPE_BYTES) throw new Error(`Invalid channel envelope field: ${field}.`)
  return { v: 3, ch: value.ch, kind: value.kind as ChannelRecordKind, z: value.z, nonce: value.nonce as string, ct: value.ct as string }
}
export const serializeChannelEnvelope = (envelope: ChannelEnvelope) => encoder.encode(canonicalize(envelope))
export const deserializeChannelEnvelope = (bytes: Uint8Array) => parseChannelEnvelope(JSON.parse(decoder.decode(bytes)))
