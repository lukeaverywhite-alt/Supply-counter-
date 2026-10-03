import { LockingScript, P2PKH, PrivateKey, Transaction, UnlockingScript } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import {
  MAX_RECORD_PAYLOAD_BYTES,
  MAX_RECORDS_PER_TX,
  assertValidRecordBatch,
  computeTxid,
  decodeArgusRecords,
  encodeArgusRecordScript,
  isTestnetAddress,
} from './codec'
import type { ArgusRecord } from './types'

const ARGUS_HEX = '4152475553' // "ARGUS"
const PREFIX_HEX = `006a05${ARGUS_HEX}0102` // OP_FALSE OP_RETURN push("ARGUS") push(0x02)

/** A transaction with one dummy input and the given output scripts. */
function txWithScripts(scripts: LockingScript[]): string {
  const tx = new Transaction()
  tx.addInput({ sourceTXID: 'ab'.repeat(32), sourceOutputIndex: 0, unlockingScript: UnlockingScript.fromHex('51'), sequence: 0xffffffff })
  for (const lockingScript of scripts) tx.addOutput({ lockingScript, satoshis: 0 })
  return tx.toHex()
}

function bytes(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill)
}

describe('encodeArgusRecordScript', () => {
  it('writes OP_FALSE OP_RETURN and four explicit data pushes', () => {
    const script = encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(1, 2, 3) })
    expect(script.toHex()).toBe(`${PREFIX_HEX}0145${'03010203'}`)
  })

  it('pushes the format version as the byte 0x02, never as OP_2', () => {
    const hex = encodeArgusRecordScript({ kind: 'G', payload: Uint8Array.of(9) }).toHex()
    expect(hex.slice(16, 20)).toBe('0102')
    expect(hex).not.toContain(`${ARGUS_HEX}52`)
    expect(hex).toBe(`${PREFIX_HEX}0147${'0109'}`)
  })

  it.each([
    [0, '00'],
    [75, '4b'],
    [76, '4c4c'],
    [255, '4cff'],
    [256, '4d0001'],
    [65_535, '4dffff'],
    [65_536, '4e00000100'],
  ])('uses the right push opcode for a %i-byte payload and round-trips it', (length, pushPrefix) => {
    const payload = bytes(length, 0xaa)
    const script = encodeArgusRecordScript({ kind: 'E', payload })
    const hex = script.toHex()
    expect(hex.startsWith(`${PREFIX_HEX}0145${pushPrefix}`)).toBe(true)
    expect(hex.length).toBe((PREFIX_HEX.length + 4 + pushPrefix.length) + length * 2)

    const [decoded] = decodeArgusRecords(txWithScripts([script]))
    expect(decoded.kind).toBe('E')
    expect(decoded.payload).toEqual(payload)
  })

  it('accepts a payload from TextEncoder, whose Uint8Array comes from another realm under jsdom', () => {
    const payload = new TextEncoder().encode('x')
    const script = encodeArgusRecordScript({ kind: 'E', payload })
    expect(script.toHex()).toBe(`${PREFIX_HEX}0145${'0178'}`)
    const [decoded] = decodeArgusRecords(txWithScripts([script]))
    expect(Array.from(decoded.payload)).toEqual([0x78])
  })

  it('carries an admission ticket record under kind T and decodes it back', () => {
    const script = encodeArgusRecordScript({ kind: 'T', payload: Uint8Array.of(7, 8) })
    expect(script.toHex()).toBe(`${PREFIX_HEX}0154${'020708'}`)
    const [decoded] = decodeArgusRecords(txWithScripts([script]))
    expect(decoded).toMatchObject({ kind: 'T', vout: 0 })
    expect(Array.from(decoded.payload)).toEqual([7, 8])
  })

  it('carries a cadet channel record under kind C and decodes it back', () => {
    const script = encodeArgusRecordScript({ kind: 'C', payload: Uint8Array.of(3, 4) })
    expect(script.toHex()).toBe(`${PREFIX_HEX}0143${'020304'}`)
    const [decoded] = decodeArgusRecords(txWithScripts([script]))
    expect(decoded).toMatchObject({ kind: 'C', vout: 0 })
    expect(Array.from(decoded.payload)).toEqual([3, 4])
  })

  it('accepts a Node Buffer payload', () => {
    const script = encodeArgusRecordScript({ kind: 'G', payload: Buffer.from([1, 2]) })
    expect(script.toHex()).toBe(`${PREFIX_HEX}0147${'020102'}`)
  })

  it('rejects payloads over the limit, unknown kinds and non-byte payloads', () => {
    expect(MAX_RECORD_PAYLOAD_BYTES).toBe(64 * 1024)
    expect(() => encodeArgusRecordScript({ kind: 'E', payload: bytes(MAX_RECORD_PAYLOAD_BYTES + 1) })).toThrow(/limit/)
    expect(() => encodeArgusRecordScript({ kind: 'X' as ArgusRecord['kind'], payload: bytes(1) })).toThrow(/kind/)
    expect(() => encodeArgusRecordScript({ kind: 'E', payload: [1, 2] as unknown as Uint8Array })).toThrow(/Uint8Array/)
  })

  it('enforces 1..MAX_RECORDS_PER_TX records per batch', () => {
    const record: ArgusRecord = { kind: 'E', payload: bytes(4) }
    expect(MAX_RECORDS_PER_TX).toBe(25)
    expect(() => assertValidRecordBatch([])).toThrow(/At least one/)
    expect(() => assertValidRecordBatch(Array.from({ length: 26 }, () => record))).toThrow(/limit is 25/)
    expect(() => assertValidRecordBatch(Array.from({ length: 25 }, () => record))).not.toThrow()
  })
})

describe('decodeArgusRecords', () => {
  const address = PrivateKey.fromRandom().toAddress('testnet')

  it('returns every record in output order with its vout, skipping foreign outputs', () => {
    const hex = txWithScripts([
      new P2PKH().lock(address),
      encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(1) }),
      LockingScript.fromHex(`006a05${'4152475554'}0102014501ff`), // tag "ARGUT"
      encodeArgusRecordScript({ kind: 'G', payload: Uint8Array.of(2, 2) }),
      LockingScript.fromHex('006a0b68656c6c6f20776f726c64'), // a foreign "hello world" data output
    ])
    expect(decodeArgusRecords(hex)).toEqual([
      { kind: 'E', payload: Uint8Array.of(1), vout: 1 },
      { kind: 'G', payload: Uint8Array.of(2, 2), vout: 3 },
    ])
  })

  it.each([
    ['OP_2 instead of a version push', `006a05${ARGUS_HEX}52014501ff`],
    ['version 1', `006a05${ARGUS_HEX}0101014501ff`],
    ['unknown kind', `006a05${ARGUS_HEX}0102015801ff`],
    ['two-byte kind', `006a05${ARGUS_HEX}010202454501ff`],
    ['missing payload', `006a05${ARGUS_HEX}01020145`],
    ['extra push', `006a05${ARGUS_HEX}0102014501ff01ff`],
    ['truncated push', `006a05${ARGUS_HEX}010201450501`],
    ['truncated PUSHDATA2 length', `006a05${ARGUS_HEX}010201454d01`],
    ['non-push opcode', `006a05${ARGUS_HEX}0102014501ff76`],
    ['OP_RETURN without OP_FALSE', `6a05${ARGUS_HEX}0102014501ff`],
    ['bare OP_FALSE', '00'],
    ['empty script', ''],
  ])('never throws on a foreign or malformed output (%s)', (_label, scriptHex) => {
    const hex = txWithScripts([LockingScript.fromHex(scriptHex)])
    expect(decodeArgusRecords(hex)).toEqual([])
  })

  it('returns [] for a transaction without A.R.G.U.S. outputs', () => {
    expect(decodeArgusRecords(txWithScripts([new P2PKH().lock(address)]))).toEqual([])
  })

  it('throws only when the transaction hex itself is unparseable', () => {
    const valid = txWithScripts([encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(1) })])
    expect(() => decodeArgusRecords('zz')).toThrow()
    expect(() => decodeArgusRecords('')).toThrow()
    expect(() => decodeArgusRecords(valid.slice(0, -2))).toThrow()
    expect(() => decodeArgusRecords(`${valid}00`)).toThrow(/trailing/)
  })

  it('returns payload copies, not views into the transaction bytes', () => {
    const [record] = decodeArgusRecords(txWithScripts([encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(5, 6) })]))
    expect(record.payload.byteOffset).toBe(0)
    expect(record.payload.buffer.byteLength).toBe(2)
  })
})

describe('helpers', () => {
  it('recognizes only testnet P2PKH addresses', () => {
    const key = PrivateKey.fromRandom()
    expect(isTestnetAddress(key.toAddress('testnet'))).toBe(true)
    expect(isTestnetAddress(key.toAddress('mainnet'))).toBe(false)
    expect(isTestnetAddress('not an address')).toBe(false)
    expect(isTestnetAddress('')).toBe(false)
  })

  it('computes the same txid as the SDK', () => {
    const hex = txWithScripts([encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(1) })])
    expect(computeTxid(hex)).toBe(Transaction.fromHex(hex).id('hex'))
  })
})
