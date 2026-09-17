import { describe, expect, it } from 'vitest'
import { createDomainEvent } from '../audit/events'
import { MemoryRepository } from '../storage/repository'
import { AuditOutbox } from './AuditOutbox'
import { BlockchainTransactionCoordinator, type AuditTransactionExecutor } from './BlockchainTransactionCoordinator'
import { UtxoReservationStore } from './UtxoReservationStore'
import type { SignedAuditCommitment } from './types'

const commitment = (eventId = 'event-001', eventHash = 'a'.repeat(64)): SignedAuditCommitment => ({ event: { ...createDomainEvent({ type: 'ITEM_ISSUED', entityId: 'item-001', summary: 'audit', data: { quantity: 1 } }), eventId, timestamp: '2026-09-12T00:00:00.000Z' }, eventHash, signature: `signature:${eventHash}`, publicIdentity: 'test-public-identity' })

class Executor implements AuditTransactionExecutor {
  readonly network = 'MOCK' as const
  prepares = 0; broadcasts = 0; lookups = 0; accepted = new Set<string>(); loseResponse = false
  async prepare(job: { eventHash: string }) { this.prepares++; return { candidateTransactionId: `MOCK_CANDIDATE_${job.eventHash.slice(0, 12)}`, signedTransaction: `mock-raw:${job.eventHash}` } }
  async broadcast(value: { candidateTransactionId: string }) { this.broadcasts++; this.accepted.add(value.candidateTransactionId); if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost') } return { transactionId: value.candidateTransactionId } }
  async lookup(id: string) { this.lookups++; return this.accepted.has(id) ? 'BROADCAST' as const : 'UNKNOWN' as const }
}

describe('durable blockchain audit coordination', () => {
  it('deduplicates jobs and rejects canonical identity collisions', async () => {
    const repository = new MemoryRepository(); await repository.initialize(); const outbox = new AuditOutbox(repository)
    const first = await outbox.enqueue('org-001', commitment())
    expect((await outbox.enqueue('org-001', commitment())).jobId).toBe(first.jobId)
    await expect(outbox.enqueue('org-001', commitment('event-001', 'b'.repeat(64)))).rejects.toMatchObject({ code: 'AUDIT_JOB_COLLISION' })
    expect((await repository.snapshot()).auditJobs).toHaveLength(1)
  })

  it('uses one active runner and atomically prevents two workers claiming one job', async () => {
    const repository = new MemoryRepository(); const outbox = new AuditOutbox(repository); await outbox.enqueue('org-001', commitment())
    const executor = new Executor(), a = new BlockchainTransactionCoordinator(repository, executor, 'worker-a'), b = new BlockchainTransactionCoordinator(repository, executor, 'worker-b')
    const first = a.process(); expect(a.process()).toBe(first)
    await Promise.all([first, b.process()])
    expect(executor.prepares).toBe(1); expect(executor.broadcasts).toBe(1)
    expect((await repository.snapshot()).auditJobs[0]).toMatchObject({ state: 'BROADCAST', attempts: 1 })
  })

  it('reconciles a persisted candidate after a lost broadcast response without rebuilding', async () => {
    const repository = new MemoryRepository(); await new AuditOutbox(repository).enqueue('org-001', commitment()); const executor = new Executor(); executor.loseResponse = true
    const coordinator = new BlockchainTransactionCoordinator(repository, executor, 'worker-a')
    await coordinator.process(); expect((await repository.snapshot()).auditJobs[0].state).toBe('RETRYABLE_FAILURE')
    await coordinator.process()
    expect(executor.prepares).toBe(1); expect(executor.broadcasts).toBe(1); expect(executor.lookups).toBe(1)
    expect((await repository.snapshot()).auditJobs[0].state).toBe('BROADCAST')
  })

  it('does not steal live UTXO leases and reclaims expired reservations', async () => {
    let time = new Date('2026-09-12T00:00:00Z'); const repository = new MemoryRepository(), store = new UtxoReservationStore(repository, () => time)
    await store.addAvailable({ txid: 'funding', vout: 0, satoshis: 1000 })
    expect((await store.reserve('job-a', 1000))?.reservedByJobId).toBe('job-a')
    expect(await store.reserve('job-b', 1000)).toBeUndefined()
    time = new Date('2026-09-12T00:00:02Z')
    expect((await store.reserve('job-b', 1000))?.reservedByJobId).toBe('job-b')
  })
})
