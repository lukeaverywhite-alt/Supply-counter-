/**
 * A.R.G.U.S. record codec: turns opaque record bytes into OP_FALSE OP_RETURN data outputs and
 * finds them again in raw transaction hex.
 *
 * Adapted from spell-forge src/bsv (MIT): record.ts (explicit one-byte version push, and
 * parsing the pushes after OP_RETURN by hand) and keys.ts (testnet address check).
 *
 * Script layout (format 2):
 *   0x00 OP_FALSE
 *   0x6a OP_RETURN
 *   push "ARGUS"          protocol tag (ASCII)
 *   push [0x02]           format version as a one-byte DATA push (never OP_2)
 *   push [kind]           'E' (encrypted event envelope), 'G' (key grant) or 'T' (admission ticket record)
 *   push payload          opaque, already-encrypted bytes
 */

import { Hash, LockingScript, Utils } from '@bsv/sdk'
import type { ArgusRecord, ArgusRecordKind, DecodedArgusRecord } from './types'

export const ARGUS_PROTOCOL_TAG = 'ARGUS'
export const ARGUS_RECORD_FORMAT_VERSION = 0x02
export const MAX_RECORD_PAYLOAD_BYTES = 64 * 1024
export const MAX_RECORDS_PER_TX = 25

const OP_FALSE = 0x00
const OP_RETURN = 0x6a
const OP_PUSHDATA1 = 0x4c
const OP_PUSHDATA2 = 0x4d
const OP_PUSHDATA4 = 0x4e

const TESTNET_P2PKH_PREFIX = 0x6f
const P2PKH_HASH_BYTES = 20

const PROTOCOL_TAG_BYTES: readonly number[] = Array.from(ARGUS_PROTOCOL_TAG, (character) => character.charCodeAt(0))
const RECORD_KINDS: readonly ArgusRecordKind[] = ['E', 'G', 'T']

/** Serializes one data push with the smallest correct push opcode for its length. */
function pushData(bytes: Uint8Array): number[] {
  const length = bytes.length
  let prefix: number[]
  if (length < OP_PUSHDATA1) {
    prefix = [length]
  } else if (length <= 0xff) {
    prefix = [OP_PUSHDATA1, length]
  } else if (length <= 0xffff) {
    prefix = [OP_PUSHDATA2, length & 0xff, (length >> 8) & 0xff]
  } else {
    prefix = [OP_PUSHDATA4, length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff, (length >>> 24) & 0xff]
  }
  return [...prefix, ...bytes]
}

/**
 * Realm-safe Uint8Array check. `instanceof Uint8Array` fails for arrays made in another realm
 * (TextEncoder output under jsdom, iframes, workers), so test the brand instead. Node Buffers,
 * being Uint8Array subclasses, pass too.
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
}

/** Throws unless the record is something this format can carry. */
export function assertValidRecord(record: ArgusRecord): void {
  if (!RECORD_KINDS.includes(record.kind)) {
    throw new Error(`Unknown A.R.G.U.S. record kind "${String(record.kind)}"; expected 'E', 'G' or 'T'.`)
  }
  if (!isUint8Array(record.payload)) {
    throw new Error('A.R.G.U.S. record payload must be a Uint8Array.')
  }
  if (record.payload.length > MAX_RECORD_PAYLOAD_BYTES) {
    throw new Error(`A.R.G.U.S. record payload is ${record.payload.length} bytes, over the ${MAX_RECORD_PAYLOAD_BYTES}-byte limit.`)
  }
}

/** Throws unless the batch fits in one transaction (1..MAX_RECORDS_PER_TX valid records). */
export function assertValidRecordBatch(records: readonly ArgusRecord[]): void {
  if (records.length === 0) throw new Error('At least one A.R.G.U.S. record is required.')
  if (records.length > MAX_RECORDS_PER_TX) {
    throw new Error(`${records.length} records do not fit in one transaction; the limit is ${MAX_RECORDS_PER_TX}.`)
  }
  records.forEach(assertValidRecord)
}

/** Builds the data output script for one record. */
export function encodeArgusRecordScript(record: ArgusRecord): LockingScript {
  assertValidRecord(record)
  // Normalize to this realm's Uint8Array (and a private copy) before reading the bytes.
  const payload = Uint8Array.from(record.payload)
  const bytes = [
    OP_FALSE,
    OP_RETURN,
    ...pushData(Uint8Array.from(PROTOCOL_TAG_BYTES)),
    ...pushData(Uint8Array.of(ARGUS_RECORD_FORMAT_VERSION)),
    ...pushData(Uint8Array.of(record.kind.charCodeAt(0))),
    ...pushData(payload),
  ]
  // fromHex rather than writeBin chunks: the bytes above are exactly what goes on chain,
  // so there is no question of how the SDK chooses to serialize pushes after OP_RETURN.
  return LockingScript.fromHex(Utils.toHex(bytes))
}

/**
 * Splits a byte run into its data pushes. Returns undefined if any opcode is not a push or a
 * push runs past the end. Needed because the SDK treats everything after OP_RETURN as one blob.
 */
function parsePushes(bytes: Uint8Array, start: number): Uint8Array[] | undefined {
  const pushes: Uint8Array[] = []
  let index = start
  while (index < bytes.length) {
    const opcode = bytes[index]
    index += 1
    let length: number
    if (opcode < OP_PUSHDATA1) {
      length = opcode
    } else if (opcode === OP_PUSHDATA1) {
      if (index + 1 > bytes.length) return undefined
      length = bytes[index]
      index += 1
    } else if (opcode === OP_PUSHDATA2) {
      if (index + 2 > bytes.length) return undefined
      length = bytes[index] | (bytes[index + 1] << 8)
      index += 2
    } else if (opcode === OP_PUSHDATA4) {
      if (index + 4 > bytes.length) return undefined
      length = (bytes[index] | (bytes[index + 1] << 8) | (bytes[index + 2] << 16) | (bytes[index + 3] << 24)) >>> 0
      index += 4
    } else {
      return undefined
    }
    if (index + length > bytes.length) return undefined
    pushes.push(bytes.subarray(index, index + length))
    index += length
  }
  return pushes
}

function bytesEqual(left: Uint8Array, right: readonly number[]): boolean {
  return left.length === right.length && right.every((byte, index) => left[index] === byte)
}

/**
 * Decodes one output script into a record, or undefined if it is not a format-2 A.R.G.U.S.
 * record (P2PKH outputs, foreign OP_RETURNs, unknown kinds and future formats are all skipped).
 */
export function decodeArgusRecordScript(script: Uint8Array): ArgusRecord | undefined {
  if (script.length < 2 || script[0] !== OP_FALSE || script[1] !== OP_RETURN) return undefined
  const pushes = parsePushes(script, 2)
  if (!pushes || pushes.length !== 4) return undefined
  const [tag, version, kind, payload] = pushes
  if (!bytesEqual(tag, PROTOCOL_TAG_BYTES)) return undefined
  if (version.length !== 1 || version[0] !== ARGUS_RECORD_FORMAT_VERSION) return undefined
  if (kind.length !== 1) return undefined
  const kindChar = String.fromCharCode(kind[0])
  if (kindChar !== 'E' && kindChar !== 'G' && kindChar !== 'T') return undefined
  // Copy so callers never hold a view into the whole transaction buffer.
  return { kind: kindChar, payload: payload.slice() }
}

/** Sequential reader over raw transaction bytes; throws on any overrun. */
class ByteReader {
  private position = 0

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.position === this.bytes.length
  }

  take(length: number): Uint8Array {
    if (length < 0 || this.position + length > this.bytes.length) {
      throw new Error('Transaction hex ended unexpectedly.')
    }
    const slice = this.bytes.subarray(this.position, this.position + length)
    this.position += length
    return slice
  }

  varInt(): number {
    const first = this.take(1)[0]
    if (first < 0xfd) return first
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    const bytes = this.take(width)
    let value = 0
    for (let index = width - 1; index >= 0; index -= 1) value = value * 256 + bytes[index]
    if (!Number.isSafeInteger(value)) throw new Error('Transaction varint is out of range.')
    return value
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim()
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error('Transaction hex is not valid hexadecimal.')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

/**
 * Parses a raw (non-extended) transaction and returns the locking script of every output.
 * A private parser keeps decoding independent of how the SDK re-serializes odd scripts.
 */
function outputScripts(txHex: string): Uint8Array[] {
  const reader = new ByteReader(hexToBytes(txHex))
  reader.take(4) // version
  const inputCount = reader.varInt()
  for (let index = 0; index < inputCount; index += 1) {
    reader.take(36) // previous txid + vout
    reader.take(reader.varInt()) // unlocking script
    reader.take(4) // sequence
  }
  const outputCount = reader.varInt()
  const scripts: Uint8Array[] = []
  for (let index = 0; index < outputCount; index += 1) {
    reader.take(8) // satoshis
    scripts.push(reader.take(reader.varInt()))
  }
  reader.take(4) // lock time
  if (!reader.done) throw new Error('Transaction hex has trailing bytes.')
  return scripts
}

/**
 * Every A.R.G.U.S. record in a transaction, in output order, with its output index.
 * Foreign outputs are skipped; only unparseable transaction hex throws.
 */
export function decodeArgusRecords(txHex: string): DecodedArgusRecord[] {
  const records: DecodedArgusRecord[] = []
  outputScripts(txHex).forEach((script, vout) => {
    const record = decodeArgusRecordScript(script)
    if (record) records.push({ ...record, vout })
  })
  return records
}

/** The txid of raw transaction hex (double SHA-256, byte-reversed). Throws if the hex is malformed. */
export function computeTxid(txHex: string): string {
  const digest = Hash.hash256(Array.from(hexToBytes(txHex)))
  return Utils.toHex(digest.reverse())
}

/** True if the string is a base58check P2PKH address on BSV testnet (version byte 0x6f). */
export function isTestnetAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length === 0) return false
  try {
    const { prefix, data } = Utils.fromBase58Check(address)
    return Array.isArray(prefix) && prefix.length === 1 && prefix[0] === TESTNET_P2PKH_PREFIX && data.length === P2PKH_HASH_BYTES
  } catch {
    return false
  }
}

/** Throws a readable error unless the address is a BSV testnet P2PKH address. */
export function assertTestnetAddress(address: string, label = 'Address'): void {
  if (!isTestnetAddress(address)) {
    throw new Error(`${label} "${address}" is not a BSV testnet address. A.R.G.U.S. never uses mainnet.`)
  }
}
