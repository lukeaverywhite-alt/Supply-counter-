import { Brc100TestnetWalletProvider, MockTestnetWalletStatusProvider, UnconfiguredTestnetWalletStatusProvider, type TestnetWalletStatusProvider } from './ArgusWalletAdapter'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'
import { resolveBlockchainMode, type BlockchainMode } from './config'

export type WalletRuntime = { mode: BlockchainMode; wallet: TestnetWalletStatusProvider; transactionWallet?: EmbeddedTestnetWallet }

/** Single composition root: status and transaction services receive this exact provider object. */
export function createWalletRuntime(value: string | undefined, dependencies: { storage?: Storage; fetcher?: typeof fetch } = {}): WalletRuntime {
  const mode = resolveBlockchainMode(value)
  if (mode === 'embedded-testnet') {
    const wallet = new EmbeddedTestnetWallet(dependencies.storage, dependencies.fetcher)
    return { mode, wallet, transactionWallet: wallet }
  }
  if (mode === 'external-brc100-testnet') return { mode, wallet: new Brc100TestnetWalletProvider() }
  if (mode === 'mock-development') return { mode, wallet: new MockTestnetWalletStatusProvider() }
  return { mode, wallet: new UnconfiguredTestnetWalletStatusProvider() }
}
