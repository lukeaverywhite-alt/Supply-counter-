import { canonicalize } from '../distributed/canonical'
import type { ArgusRepository } from '../storage/repository'
import type { SignedAuditCommitment } from './types'
import type { BlockchainAuditJob } from './BlockchainJobTypes'

export class AuditJobCollisionError extends Error { readonly code = 'AUDIT_JOB_COLLISION' }

export class AuditOutbox {
  constructor(private readonly repository: ArgusRepository, private readonly now = () => new Date()) {}

  async enqueue(organizationId: string, commitment: SignedAuditCommitment): Promise<BlockchainAuditJob> {
    let result!: BlockchainAuditJob
    await this.repository.transaction(state => {
      const existing = state.auditJobs.find(job => job.organizationId === organizationId && job.eventId === commitment.event.eventId)
      if (existing) {
        if (existing.eventHash !== commitment.eventHash || canonicalize(existing.commitment) !== canonicalize(commitment)) throw new AuditJobCollisionError('Audit event identity was reused with different canonical content.')
        result = structuredClone(existing); return
      }
      const timestamp = this.now().toISOString()
      result = { jobId: `audit:${organizationId}:${commitment.event.eventId}`, organizationId, eventId: commitment.event.eventId, eventHash: commitment.eventHash, commitment: structuredClone(commitment), state: 'QUEUED', attempts: 0, createdAt: timestamp, updatedAt: timestamp }
      state.auditJobs.push(result)
      const event = state.events.find(record => record.event.eventId === commitment.event.eventId && record.event.organizationId === organizationId)
      if (event) event.auditStatus = 'PENDING'
    })
    return structuredClone(result)
  }
}
