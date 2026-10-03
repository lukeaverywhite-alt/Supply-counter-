import { describe, expect, it } from 'vitest'
import { anchorLockingScript, channelAddress, keyGrantAnchorAddress, unitAnchorAddress } from './anchor'

describe('unit anchor address derivation', () => {
  it('derives a fixed testnet address for a fixed organizationId', () => {
    const address = unitAnchorAddress('org-njrotc-1')
    expect(address).toBe(unitAnchorAddress('org-njrotc-1'))
    expect(address).toMatch(/^[mn]/)
  })

  it('derives different addresses for different organizations', () => {
    expect(unitAnchorAddress('org-a')).not.toBe(unitAnchorAddress('org-b'))
  })

  it('refuses mainnet', () => {
    expect(() => unitAnchorAddress('org-njrotc-1', 'mainnet')).toThrow(/testnet/i)
  })

  it('builds a P2PKH locking script for the anchor address', () => {
    const address = unitAnchorAddress('org-njrotc-1')
    const script = anchorLockingScript(address)
    expect(script.toASM()).toMatch(/^OP_DUP OP_HASH160 [0-9a-f]{40} OP_EQUALVERIFY OP_CHECKSIG$/)
  })
})

describe('cadet channel address derivation (ADR 013)', () => {
  const key = '0f'.repeat(32)

  it('derives one fixed testnet address from a channel key', () => {
    expect(channelAddress(key)).toBe(channelAddress(key))
    expect(channelAddress(key)).toMatch(/^[mn]/)
    expect(channelAddress(key.toUpperCase())).toBe(channelAddress(key))
    expect(channelAddress('1e'.repeat(32))).not.toBe(channelAddress(key))
  })

  it('is domain-separated from the unit and key-grant anchors, even for the same string', () => {
    expect(channelAddress(key)).not.toBe(unitAnchorAddress(key))
    expect(channelAddress(key)).not.toBe(keyGrantAnchorAddress(key))
  })

  it('takes only a 32-byte key in hex and refuses mainnet', () => {
    expect(() => channelAddress('0f'.repeat(16))).toThrow(/32 bytes/)
    expect(() => channelAddress('zz'.repeat(32))).toThrow(/32 bytes/)
    expect(() => channelAddress(key, 'mainnet')).toThrow(/testnet/i)
  })
})
