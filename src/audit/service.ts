import { hashEvent } from './integrity'
import type { AuditEvent } from '../types'
import type { BlockchainProvider, SignedAuditCommitment, Signer } from '../blockchain/types'

export async function submitEventForAudit(event: AuditEvent, provider: BlockchainProvider, signer: Signer): Promise<AuditEvent> {
  try {
    const eventHash = await hashEvent(event)
    const signature = await signer.sign(eventHash)
    const publicIdentity = await signer.getPublicIdentity()
    const pending = { ...event, audit: { ...event.audit, status: 'SUBMITTING' as const, eventHash, signature, publicIdentity } }
    const commitment: SignedAuditCommitment = { event: pending, eventHash, signature, publicIdentity }
    const result = await provider.submitAuditEvent(commitment)
    if (result.network !== event.audit.targetNetwork) throw new Error('Audit provider submitted to an unexpected network.')
    return { ...pending, audit: { ...pending.audit, status: result.status, submittedNetwork: result.network, transactionId: result.transactionId } }
  } catch (error) {
    return { ...event, audit: { ...event.audit, status: 'FAILED', error: error instanceof Error ? error.message : 'Audit submission failed.' } }
  }
}
