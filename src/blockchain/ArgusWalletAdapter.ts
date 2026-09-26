import type { SignedArgusEvent } from '../distributed/types'
import { PublicKey, WalletClient, type WalletInterface } from '@bsv/sdk'

export type TestnetVerificationLevel = 'SIGNATURE_VERIFIED' | 'TX_BROADCAST' | 'TX_CONFIRMED' | 'MERKLE_PROOF_VERIFIED'
export type TestnetAuditResult = { network: 'TESTNET'; transactionId: string; verificationLevel: TestnetVerificationLevel; beef?: number[] }
export interface PublicAuditCommitmentV1 { protocol: 'ARGUS_AUDIT'; protocolVersion: 1; organizationOpaqueId: string; eventId: string; eventType: string; opaqueEntityId: string; eventHash: string; timestamp: string; signerPublicReference: string }

export interface ArgusWalletAdapter {
  getPublicIdentity(): Promise<string>
  signCanonicalEvent(event: SignedArgusEvent): Promise<string>
  createTestnetAuditTransaction(commitment: PublicAuditCommitmentV1): Promise<TestnetAuditResult>
}

export type WalletConnectionState = 'DISCONNECTED' | 'CONNECTED' | 'ERROR'
export type WalletTransactionStatus = 'BROADCAST' | 'CONFIRMED' | 'PROOF_VERIFIED' | 'UNKNOWN'
export type TestnetWalletStatus = {
  network: 'TESTNET'; connection: WalletConnectionState; mode: 'LIVE' | 'EMBEDDED' | 'MOCK' | 'UNCONFIGURED'
  receivingAddress?: string; balanceSatoshis?: number; unconfirmedBalanceSatoshis?: number
  recentTransactions: Array<{ transactionId: string; status: WalletTransactionStatus; timestamp?: string }>; error?: string; requiresSetup?: boolean; requiresUnlock?: boolean
}

/** Wallet lifecycle/status boundary. It intentionally exposes no key-export operation. */
export interface TestnetWalletStatusProvider { getStatus(): Promise<TestnetWalletStatus>; create?(password: string): Promise<TestnetWalletStatus>; unlock?(password: string): Promise<TestnetWalletStatus>; lock?(): void; exportBackup?(password: string): Promise<string>; inspectBackup?(serialized: string, password: string): Promise<{address:string;currentAddress?:string;rollbackWarning:boolean}>; recoverBackup?(serialized:string,password:string,confirmation:{address:string;replaceExisting?:boolean;currentWalletBackedUp?:boolean;allowRollback?:boolean}):Promise<TestnetWalletStatus> }

/**
 * Connects A.R.G.U.S. to a user-controlled BRC-100 wallet (MetaNet Client,
 * compatible extension, or another WalletClient substrate). The application
 * receives capabilities only: private keys and recovery material never cross
 * this boundary.
 */
export class Brc100TestnetWalletProvider implements TestnetWalletStatusProvider {
  constructor(private readonly wallet: Pick<WalletInterface, 'getNetwork'|'getPublicKey'|'listActions'|'isAuthenticated'|'createAction'> = new WalletClient('auto')) {}

  getWallet() { return this.wallet }

  async getStatus(): Promise<TestnetWalletStatus> {
    try {
      const authenticated = await this.wallet.isAuthenticated({})
      if (!authenticated.authenticated) return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'LIVE', recentTransactions: [], error: 'Unlock or authorize your BRC-100 wallet, then try again.' }
      const { network } = await this.wallet.getNetwork({})
      assertTestnetOnly(network.toUpperCase())
      const { publicKey } = await this.wallet.getPublicKey({ identityKey: true })
      const receivingAddress = PublicKey.fromString(publicKey).toAddress('testnet')
      const history = await this.wallet.listActions({ labels: ['argus-encrypted-history'], limit: 10, seekPermission: true })
      return {
        network: 'TESTNET', connection: 'CONNECTED', mode: 'LIVE', receivingAddress,
        recentTransactions: history.actions.map(action => ({ transactionId: action.txid, status: action.status === 'completed' ? 'CONFIRMED' : action.status === 'unproven' ? 'BROADCAST' : 'UNKNOWN' })),
      }
    } catch (error) {
      return { network: 'TESTNET', connection: 'ERROR', mode: 'LIVE', recentTransactions: [], error: walletError(error) }
    }
  }
}

function walletError(error: unknown) {
  const message = error instanceof Error ? error.message : 'The BRC-100 wallet could not be reached.'
  if (/mainnet/i.test(message)) return 'This wallet is on mainnet. Switch it to BSV testnet; A.R.G.U.S. will not spend mainnet funds.'
  return message
}

export class UnconfiguredTestnetWalletStatusProvider implements TestnetWalletStatusProvider {
  async getStatus(): Promise<TestnetWalletStatus> { return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'UNCONFIGURED', recentTransactions: [] } }
}

/** Deterministic UI/test fixture. Never select this provider for publication. */
export class MockTestnetWalletStatusProvider implements TestnetWalletStatusProvider {
  constructor(private readonly status: Partial<Omit<TestnetWalletStatus, 'network'|'mode'>> = {}) {}
  async getStatus(): Promise<TestnetWalletStatus> { return { network: 'TESTNET', connection: 'CONNECTED', mode: 'MOCK', receivingAddress: 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn', balanceSatoshis: 125_000, recentTransactions: [], ...this.status } }
}

// Deliberately non-operational until an externally controlled, funded BRC-100 test wallet is supplied.
export class UnconfiguredTestnetWalletAdapter implements ArgusWalletAdapter {
  async getPublicIdentity(): Promise<string> { throw new Error('External BRC-100 TESTNET wallet is not configured.') }
  async signCanonicalEvent(event: SignedArgusEvent): Promise<string> { void event; throw new Error('External BRC-100 TESTNET wallet is not configured.') }
  async createTestnetAuditTransaction(commitment: PublicAuditCommitmentV1): Promise<TestnetAuditResult> { void commitment; throw new Error('Real TESTNET broadcast not configured; no TXID was created.') }
}

export function assertTestnetOnly(network: string): asserts network is 'TESTNET' { if (network !== 'TESTNET') throw new Error('Only BSV TESTNET is permitted; mainnet is disabled and has no adapter.') }
