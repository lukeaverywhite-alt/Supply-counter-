import type { BlockchainProvider, AuditSubmission, SignedAuditCommitment, Signer } from './types'
import { hashEvent } from '../audit/integrity'

export class MockBlockchainProvider implements BlockchainProvider {
  private readonly submissions = new Map<string, AuditSubmission & { commitment: SignedAuditCommitment }>()
  constructor(private readonly signer: Signer, private failuresRemaining = 0) {}

  getNetwork() { return 'MOCK' as const }
  getPublicSignerIdentity() { return this.signer.getPublicIdentity() }

  async submitAuditEvent(commitment: SignedAuditCommitment): Promise<AuditSubmission> {
    const existing = this.submissions.get(commitment.event.eventId)
    if (existing) return existing
    if (this.failuresRemaining-- > 0) throw new Error('Mock audit submission failed.')
    if (commitment.eventHash !== await hashEvent(commitment.event) || !(await this.signer.verify(commitment.eventHash, commitment.signature))) {
      throw new Error('Audit commitment signature is invalid.')
    }
    const submission = { eventId: commitment.event.eventId, eventHash: commitment.eventHash, network: 'MOCK' as const, status: 'CONFIRMED' as const, transactionId: `MOCK_TX_${commitment.eventHash.slice(0, 32)}`, commitment }
    this.submissions.set(commitment.event.eventId, submission)
    return submission
  }

  async getTransactionStatus(eventId: string) { return this.submissions.get(eventId) }

  async verifyAuditEvent(commitment: SignedAuditCommitment, transactionId: string) {
    const stored = this.submissions.get(commitment.event.eventId)
    return Boolean(stored && stored.transactionId === transactionId && stored.eventHash === commitment.eventHash && commitment.eventHash === await hashEvent(commitment.event) && await this.signer.verify(commitment.eventHash, commitment.signature))
  }
}
