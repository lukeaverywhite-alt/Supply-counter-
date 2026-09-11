import type { AuditEvent, AuditStatus, BlockchainNetwork } from '../types'

export type SignedAuditCommitment = { event: AuditEvent; eventHash: string; signature: string; publicIdentity: string }
export type AuditSubmission = { eventId: string; eventHash: string; network: BlockchainNetwork; status: AuditStatus; transactionId?: string; error?: string }

export interface Signer {
  sign(data: string): Promise<string>
  verify(data: string, signature: string): Promise<boolean>
  getPublicIdentity(): Promise<string>
}

export interface BlockchainProvider {
  submitAuditEvent(commitment: SignedAuditCommitment): Promise<AuditSubmission>
  getTransactionStatus(eventId: string): Promise<AuditSubmission | undefined>
  verifyAuditEvent(commitment: SignedAuditCommitment, transactionId: string): Promise<boolean>
  getNetwork(): BlockchainNetwork
  getPublicSignerIdentity(): Promise<string>
}
