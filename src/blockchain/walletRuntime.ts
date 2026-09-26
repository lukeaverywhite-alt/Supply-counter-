import { Brc100TestnetWalletProvider, MockTestnetWalletStatusProvider, UnconfiguredTestnetWalletStatusProvider, type TestnetWalletStatusProvider } from './ArgusWalletAdapter'
import { EmbeddedTestnetWallet } from './EmbeddedTestnetWallet'
import { resolveBlockchainMode, type BlockchainMode } from './config'
import { EncryptedEventTestnetAdapter, type ArgusOverlayClient, type Brc100TestnetWallet } from './EncryptedEventTestnet'

export type WalletRuntime = {
  mode: BlockchainMode
  wallet: TestnetWalletStatusProvider
  transactionWallet?: Brc100TestnetWallet
  createEncryptedEventPublisher(overlay: ArgusOverlayClient, organizationId: string): EncryptedEventTestnetAdapter
}

function runtime(mode: BlockchainMode, wallet: TestnetWalletStatusProvider, transactionWallet?: Brc100TestnetWallet): WalletRuntime {
  return {
    mode,
    wallet,
    transactionWallet,
    createEncryptedEventPublisher(overlay, organizationId) {
      if (!transactionWallet) throw new Error('Configure an embedded-testnet or external-brc100-testnet wallet before publishing audit history.')
      return new EncryptedEventTestnetAdapter(transactionWallet, overlay, organizationId)
    },
  }
}

/** Single composition root: status and transaction services share one wallet/client instance. */
export function createWalletRuntime(value: string | undefined, dependencies: { storage?: Storage; fetcher?: typeof fetch } = {}): WalletRuntime {
  const mode = resolveBlockchainMode(value)
  if (mode === 'embedded-testnet') {
    const wallet = new EmbeddedTestnetWallet(dependencies.storage, dependencies.fetcher)
    return runtime(mode, wallet, wallet)
  }
  if (mode === 'external-brc100-testnet') {
    const wallet = new Brc100TestnetWalletProvider()
    const client = wallet.getWallet()
    const transactionWallet: Brc100TestnetWallet = {
      async getNetwork() { const { network } = await client.getNetwork({}); return { network } },
      createAction: args => client.createAction(args),
    }
    return runtime(mode, wallet, transactionWallet)
  }
  if (mode === 'mock-development') return runtime(mode, new MockTestnetWalletStatusProvider())
  return runtime(mode, new UnconfiguredTestnetWalletStatusProvider())
}
