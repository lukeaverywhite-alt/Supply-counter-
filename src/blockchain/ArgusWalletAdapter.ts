import type { SignedArgusEvent } from '../distributed/types'

export type TestnetVerificationLevel = 'SIGNATURE_VERIFIED' | 'TX_BROADCAST' | 'TX_CONFIRMED' | 'MERKLE_PROOF_VERIFIED'
export type TestnetAuditResult = { network: 'TESTNET'; transactionId: string; verificationLevel: TestnetVerificationLevel; beef?: number[] }
export interface PublicAuditCommitmentV1 { protocol: 'ARGUS_AUDIT'; protocolVersion: 1; organizationOpaqueId: string; eventId: string; eventType: string; opaqueEntityId: string; eventHash: string; timestamp: string; signerPublicReference: string }

export interface ArgusWalletAdapter {
  getPublicIdentity(): Promise<string>
  signCanonicalEvent(event: SignedArgusEvent): Promise<string>
  createTestnetAuditTransaction(commitment: PublicAuditCommitmentV1): Promise<TestnetAuditResult>
}

// Deliberately non-operational until an externally controlled, funded BRC-100 test wallet is supplied.
export class UnconfiguredTestnetWalletAdapter implements ArgusWalletAdapter {
  async getPublicIdentity(): Promise<string> { throw new Error('External BRC-100 TESTNET wallet is not configured.') }
  async signCanonicalEvent(event: SignedArgusEvent): Promise<string> { void event; throw new Error('External BRC-100 TESTNET wallet is not configured.') }
  async createTestnetAuditTransaction(commitment: PublicAuditCommitmentV1): Promise<TestnetAuditResult> { void commitment; throw new Error('Real TESTNET broadcast not configured; no TXID was created.') }
}

export function assertTestnetOnly(network: string): asserts network is 'TESTNET' { if (network !== 'TESTNET') throw new Error('Only BSV TESTNET is permitted; mainnet is disabled and has no adapter.') }
