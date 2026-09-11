import { describe, expect, it } from 'vitest'
import { resolveBlockchainMode } from './config'

describe('blockchain network configuration', () => {
  it('defaults to mock and accepts explicit development modes', () => {
    expect(resolveBlockchainMode(undefined)).toBe('mock')
    expect(resolveBlockchainMode('mock')).toBe('mock')
    expect(resolveBlockchainMode('testnet')).toBe('testnet')
  })

  it('hard-stops mainnet and malformed selections', () => {
    expect(() => resolveBlockchainMode('mainnet')).toThrow('BSV mainnet integration is disabled')
    expect(() => resolveBlockchainMode('production')).toThrow('Unsupported')
  })
})
