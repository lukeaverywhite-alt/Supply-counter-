import type { SignedAuditCommitment } from './types'

export type BlockchainAuditJobState = 'QUEUED' | 'CLAIMED' | 'BUILDING' | 'SIGNING' | 'BROADCASTING' | 'BROADCAST' | 'CONFIRMED' | 'PROOF_VERIFIED' | 'RETRYABLE_FAILURE' | 'PERMANENT_FAILURE'

export type BlockchainAuditJob = {
  jobId: string
  eventId: string
  organizationId: string
  eventHash: string
  commitment: SignedAuditCommitment
  state: BlockchainAuditJobState
  attempts: number
  createdAt: string
  updatedAt: string
  leaseOwner?: string
  leaseExpiresAt?: string
  transactionId?: string
  candidateTransactionId?: string
  signedTransaction?: string
  lastError?: string
}

export type UtxoReservation = {
  txid: string
  vout: number
  satoshis: number
  status: 'AVAILABLE' | 'RESERVED' | 'SPENT'
  reservationId?: string
  reservedByJobId?: string
  reservedAt?: string
  leaseExpiresAt?: string
}
