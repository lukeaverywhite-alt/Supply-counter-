import { describe, expect, it } from 'vitest'
import { createDomainEvent } from '../audit/events'
import { MemoryRepository } from '../storage/repository'
import { AuditOutbox } from './AuditOutbox'
import { BlockchainTransactionCoordinator, type AuditTransactionExecutor } from './BlockchainTransactionCoordinator'
import { UtxoReservationStore } from './UtxoReservationStore'
import type { SignedAuditCommitment } from './types'

const commitment = (eventId = 'event-001', eventHash = 'a'.repeat(64)): SignedAuditCommitment => ({ event: { ...createDomainEvent({ type: 'ITEM_ISSUED', entityId: 'item-001', summary: 'audit', data: { quantity: 1 } }), eventId, timestamp: '2026-09-12T00:00:00.000Z' }, eventHash, signature: `signature:${eventHash}`, publicIdentity: 'test-public-identity' })

class Executor implements AuditTransactionExecutor {
  readonly network: 'TESTNET'|'MOCK'
  constructor(network: 'TESTNET'|'MOCK' = 'MOCK') { this.network = network }
  prepares = 0; broadcasts = 0; lookups = 0; accepted = new Set<string>(); loseResponse = false
  async prepare(job: { eventHash: string }) { this.prepares++; return { candidateTransactionId: `MOCK_CANDIDATE_${job.eventHash.slice(0, 12)}`, signedTransaction: `mock-raw:${job.eventHash}` } }
  async broadcast(value: { candidateTransactionId: string }) { this.broadcasts++; this.accepted.add(value.candidateTransactionId); if (this.loseResponse) { this.loseResponse = false; throw new Error('response lost') } return { transactionId: value.candidateTransactionId } }
  async lookup(id: string): Promise<'UNKNOWN'|'BROADCAST'|'CONFIRMED'|'PROOF_VERIFIED'> { this.lookups++; return this.accepted.has(id) ? 'BROADCAST' : 'UNKNOWN' }
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

  it('reclaims broadcast jobs on later runs until their proof is verified', async () => {
    const repository = new MemoryRepository(); await new AuditOutbox(repository).enqueue('org-001', commitment())
    let status: 'BROADCAST'|'CONFIRMED'|'PROOF_VERIFIED' = 'BROADCAST'
    const executor = new Executor(); executor.lookup = async () => { executor.lookups++; return status }
    const coordinator = new BlockchainTransactionCoordinator(repository, executor, 'worker-a')
    await coordinator.process()
    expect((await repository.snapshot()).auditJobs[0].state).toBe('BROADCAST')
    status = 'CONFIRMED'; await coordinator.process()
    expect((await repository.snapshot()).auditJobs[0].state).toBe('CONFIRMED')
    status = 'PROOF_VERIFIED'; await coordinator.process()
    expect((await repository.snapshot()).auditJobs[0].state).toBe('PROOF_VERIFIED')
    expect(executor.lookups).toBe(2)
  })

  it('marks the matching UTXO spent in the transaction that completes a broadcast', async () => {
    const repository = new MemoryRepository(); await new AuditOutbox(repository).enqueue('org-001', commitment())
    const store = new UtxoReservationStore(repository); await store.addAvailable({ txid: 'funding', vout: 0, satoshis: 1000 })
    const executor = new Executor('TESTNET')
    await new BlockchainTransactionCoordinator(repository, executor, 'worker-a').process()
    const state = await repository.snapshot()
    expect(state.auditJobs[0]).toMatchObject({ state: 'BROADCAST', reservationId: state.utxos[0].reservationId })
    expect(state.utxos[0]).toMatchObject({ status: 'SPENT', reservedByJobId: state.auditJobs[0].jobId, leaseExpiresAt: undefined })
  })

  it('does not steal live UTXO leases and reclaims expired reservations', async () => {
    let time = new Date('2026-09-12T00:00:00Z'); const repository = new MemoryRepository(), store = new UtxoReservationStore(repository, () => time)
    await store.addAvailable({ txid: 'funding', vout: 0, satoshis: 1000 })
    expect((await store.reserve('job-a', 1000))?.reservedByJobId).toBe('job-a')
    expect(await store.reserve('job-b', 1000)).toBeUndefined()
    time = new Date('2026-09-12T00:00:02Z')
    expect((await store.reserve('job-b', 1000))?.reservedByJobId).toBe('job-b')
  })

  it('does not let stale cleanup release a replacement worker reservation', async () => {
    let time = new Date('2026-09-12T00:00:00Z'); const repository = new MemoryRepository(), store = new UtxoReservationStore(repository, () => time)
    await store.addAvailable({ txid: 'funding', vout: 0, satoshis: 1000 })
    const stale = (await store.reserve('shared-job', 1000))!
    time = new Date('2026-09-12T00:00:02Z')
    const replacement = (await store.reserve('shared-job', 1000))!
    await store.release('shared-job', stale.reservationId!)
    expect((await repository.snapshot()).utxos[0]).toMatchObject({ status: 'RESERVED', reservationId: replacement.reservationId })
  })
})
