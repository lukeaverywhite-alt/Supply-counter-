export type BlockchainMode = 'mock' | 'testnet' | 'mainnet'

export function resolveBlockchainMode(value: string | undefined): BlockchainMode {
  const mode = (value ?? 'mock').toLowerCase()
  if (mode === 'mainnet') throw new Error('BSV mainnet integration is disabled in this build.')
  if (mode !== 'mock' && mode !== 'testnet') throw new Error(`Unsupported A.R.G.U.S. blockchain mode: ${value}`)
  return mode
}
