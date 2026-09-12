import type { ArgusRepository, RepositoryState } from '../storage/repository'
import type { BlockchainAuditJob } from './BlockchainJobTypes'
import { UtxoReservationStore } from './UtxoReservationStore'

export type PreparedAuditTransaction = { candidateTransactionId: string; signedTransaction: string }
export interface AuditTransactionExecutor {
  readonly network: 'TESTNET' | 'MOCK'
  prepare(job: BlockchainAuditJob): Promise<PreparedAuditTransaction>
  broadcast(transaction: PreparedAuditTransaction): Promise<{ transactionId: string }>
  lookup(transactionId: string): Promise<'UNKNOWN'|'BROADCAST'|'CONFIRMED'|'PROOF_VERIFIED'>
}

const eligible = (job: BlockchainAuditJob, now: number) => ['QUEUED','RETRYABLE_FAILURE'].includes(job.state) || (['CLAIMED','BUILDING','SIGNING','BROADCASTING'].includes(job.state) && Boolean(job.leaseExpiresAt) && Date.parse(job.leaseExpiresAt!) <= now)

export class BlockchainTransactionCoordinator {
  private running?: Promise<void>
  constructor(private readonly repository: ArgusRepository, private readonly executor: AuditTransactionExecutor, private readonly workerId: string = crypto.randomUUID(), private readonly leaseMs = 30_000, private readonly now = () => new Date(), private readonly reservations = new UtxoReservationStore(repository, now), private readonly lockScope = 'default') {}

  process(): Promise<void> { return this.running ?? (this.running = this.withBrowserLock(() => this.processQueue()).finally(() => { this.running = undefined })) }

  private async withBrowserLock(run: () => Promise<void>) {
    const locks = (globalThis.navigator as Navigator & { locks?: { request<T>(name: string, callback: () => Promise<T>): Promise<T> } } | undefined)?.locks
    return locks ? locks.request(`argus:blockchain:${this.lockScope}`, run) : run()
  }

  private async claim(): Promise<BlockchainAuditJob | undefined> {
    let claimed: BlockchainAuditJob | undefined
    await this.repository.transaction(state => {
      const now = this.now(), job = state.auditJobs.find(value => eligible(value, now.getTime()))
      if (!job) return
      Object.assign(job, { state: 'CLAIMED', leaseOwner: this.workerId, leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(), updatedAt: now.toISOString(), attempts: job.attempts + 1, lastError: undefined })
      claimed = structuredClone(job)
    })
    return claimed
  }

  private update(jobId: string, change: (job: BlockchainAuditJob, state: RepositoryState) => void) { return this.repository.transaction(state => { const job = state.auditJobs.find(value => value.jobId === jobId && value.leaseOwner === this.workerId); if (!job) throw new Error('Audit job lease was lost.'); change(job, state); job.updatedAt = this.now().toISOString() }) }

  private async processQueue() {
    for (;;) { const job = await this.claim(); if (!job) return; if (!(await this.processJob(job))) return }
  }

  private async processJob(job: BlockchainAuditJob) {
    try {
      let prepared: PreparedAuditTransaction | undefined
      if (job.candidateTransactionId && job.signedTransaction) {
        const status = await this.executor.lookup(job.candidateTransactionId)
        if (status !== 'UNKNOWN') { await this.finish(job.jobId, job.candidateTransactionId, status); return true }
        prepared = { candidateTransactionId: job.candidateTransactionId, signedTransaction: job.signedTransaction }
      } else {
        await this.update(job.jobId, value => { value.state = 'BUILDING' })
        const reservation = await this.reservations.reserve(job.jobId, this.leaseMs)
        if (!reservation && this.executor.network !== 'MOCK') throw new Error('No unreserved TESTNET UTXO is available.')
        prepared = await this.executor.prepare(job)
        if (!prepared.candidateTransactionId || !prepared.signedTransaction) throw new Error('Provider did not return a recoverable candidate transaction.')
        await this.update(job.jobId, value => { value.state = 'BROADCASTING'; value.candidateTransactionId = prepared!.candidateTransactionId; value.signedTransaction = prepared!.signedTransaction })
      }
      const result = await this.executor.broadcast(prepared)
      if (result.transactionId !== prepared.candidateTransactionId) throw new Error('Broadcast transaction ID differs from the persisted candidate transaction ID.')
      await this.finish(job.jobId, result.transactionId, 'BROADCAST')
      return true
    } catch (error) {
      await this.repository.transaction(state => { const value = state.auditJobs.find(candidate => candidate.jobId === job.jobId && candidate.leaseOwner === this.workerId); if (value) Object.assign(value, { state: 'RETRYABLE_FAILURE', lastError: error instanceof Error ? error.message : 'Blockchain audit processing failed.', leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: this.now().toISOString() }) })
      // Keep reservations for a persisted candidate: it may already have spent the input.
      const current = (await this.repository.snapshot()).auditJobs.find(value => value.jobId === job.jobId)
      if (!current?.candidateTransactionId) await this.reservations.release(job.jobId)
      return false
    }
  }

  private async finish(jobId: string, transactionId: string, status: 'BROADCAST'|'CONFIRMED'|'PROOF_VERIFIED') {
    await this.update(jobId, (job, state) => {
      Object.assign(job, { state: status, transactionId, candidateTransactionId: transactionId, leaseOwner: undefined, leaseExpiresAt: undefined })
      const event = state.events.find(record => record.event.eventId === job.eventId && record.event.organizationId === job.organizationId)
      if (event) event.auditStatus = status
    })
    await this.reservations.consume(jobId)
  }
}
