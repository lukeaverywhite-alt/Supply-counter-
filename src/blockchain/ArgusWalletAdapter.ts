import type { SignedArgusEvent } from '../distributed/types'

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
  receivingAddress?: string; balanceSatoshis?: number
  recentTransactions: Array<{ transactionId: string; status: WalletTransactionStatus }>; error?: string; requiresSetup?: boolean; requiresUnlock?: boolean
}

/** Read-only status boundary. It intentionally exposes no signing or key-export operation. */
export interface TestnetWalletStatusProvider { getStatus(): Promise<TestnetWalletStatus>; create?(password: string): Promise<TestnetWalletStatus>; unlock?(password: string): Promise<TestnetWalletStatus>; lock?(): void }

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
