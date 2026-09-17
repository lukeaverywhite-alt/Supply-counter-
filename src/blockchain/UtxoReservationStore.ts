import type { ArgusRepository } from '../storage/repository'
import type { UtxoReservation } from './BlockchainJobTypes'

export class UtxoReservationStore {
  constructor(private readonly repository: ArgusRepository, private readonly now = () => new Date()) {}
  async addAvailable(input: Pick<UtxoReservation, 'txid'|'vout'|'satoshis'>) { await this.repository.transaction(state => { if (!state.utxos.some(value => value.txid === input.txid && value.vout === input.vout)) state.utxos.push({ ...input, status: 'AVAILABLE' }) }) }
  async reserve(jobId: string, leaseMs: number): Promise<UtxoReservation | undefined> {
    let reserved: UtxoReservation | undefined
    await this.repository.transaction(state => {
      const now = this.now(), available = state.utxos.find(value => value.status === 'AVAILABLE' || (value.status === 'RESERVED' && value.leaseExpiresAt !== undefined && Date.parse(value.leaseExpiresAt) <= now.getTime()))
      if (!available) return
      Object.assign(available, { status: 'RESERVED', reservationId: crypto.randomUUID(), reservedByJobId: jobId, reservedAt: now.toISOString(), leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() })
      reserved = structuredClone(available)
    })
    return reserved
  }
  async release(jobId: string) { await this.repository.transaction(state => { for (const value of state.utxos) if (value.status === 'RESERVED' && value.reservedByJobId === jobId) Object.assign(value, { status: 'AVAILABLE', reservationId: undefined, reservedByJobId: undefined, reservedAt: undefined, leaseExpiresAt: undefined }) }) }
  async consume(jobId: string) { await this.repository.transaction(state => { for (const value of state.utxos) if (value.status === 'RESERVED' && value.reservedByJobId === jobId) Object.assign(value, { status: 'SPENT', leaseExpiresAt: undefined }) }) }
}
