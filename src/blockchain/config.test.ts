import { describe, expect, it } from 'vitest'
import { resolveBlockchainMode } from './config'

describe('blockchain network configuration', () => {
  it('defaults to unconfigured and accepts explicit testnet modes', () => {
    expect(resolveBlockchainMode(undefined)).toBe('unconfigured')
    expect(resolveBlockchainMode('embedded-testnet')).toBe('embedded-testnet')
    expect(resolveBlockchainMode('external-brc100-testnet')).toBe('external-brc100-testnet')
  })

  it('hard-stops mainnet and malformed selections', () => {
    expect(() => resolveBlockchainMode('mainnet')).toThrow('BSV mainnet integration is disabled')
    expect(() => resolveBlockchainMode('production')).toThrow('Unsupported')
  })
})
