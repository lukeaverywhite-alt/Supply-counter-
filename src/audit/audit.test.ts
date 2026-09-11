import { describe, expect, it } from 'vitest'
import { createDomainEvent } from './events'
import { canonicalizeEvent, hashEvent, toAuditCommitment } from './integrity'
import { submitEventForAudit } from './service'
import { MockBlockchainProvider } from '../blockchain/MockBlockchainProvider'
import { MockSigner } from '../blockchain/MockSigner'

function issuedEvent() {
  return createDomainEvent({ type: 'ITEM_ISSUED', entityId: 'shirt-pt-m', summary: 'Private display text', data: { itemId: 'shirt-pt-m', quantity: 1, cadetName: 'Private Person', cadetId: 'C-48291' } })
}

describe('audit integrity and mock round trip', () => {
  it('canonicalizes and hashes equivalent events deterministically', async () => {
    const event = issuedEvent()
    const reordered = { ...event, data: { quantity: 1, itemId: 'shirt-pt-m', cadetId: 'different private value' } }
    expect(canonicalizeEvent(reordered)).toBe(canonicalizeEvent(event))
    expect(await hashEvent(reordered)).toBe(await hashEvent(event))
  })

  it('changes the hash when meaningful audit data changes', async () => {
    const event = issuedEvent()
    expect(await hashEvent({ ...event, data: { ...event.data, quantity: 2 } })).not.toBe(await hashEvent(event))
  })

  it('removes private and unapproved fields from the commitment', () => {
    const commitment = toAuditCommitment(issuedEvent())
    expect(commitment.data).toEqual({ itemId: 'shirt-pt-m', quantity: 1 })
    expect(JSON.stringify(commitment)).not.toContain('Private Person')
    expect(JSON.stringify(commitment)).not.toContain('C-48291')
  })

  it('signs, submits, confirms, verifies, and prevents duplicate mock transactions', async () => {
    const signer = new MockSigner()
    const provider = new MockBlockchainProvider(signer)
    const audited = await submitEventForAudit(issuedEvent(), provider, signer)
    expect(audited.audit).toMatchObject({ status: 'CONFIRMED', network: 'MOCK', publicIdentity: signer.identity })
    expect(audited.audit.transactionId).toMatch(/^MOCK_TX_/)
    const commitment = { event: audited, eventHash: audited.audit.eventHash!, signature: audited.audit.signature!, publicIdentity: audited.audit.publicIdentity! }
    expect(await provider.verifyAuditEvent(commitment, audited.audit.transactionId!)).toBe(true)
    expect((await provider.submitAuditEvent(commitment)).transactionId).toBe(audited.audit.transactionId)
    expect(await provider.verifyAuditEvent({ ...commitment, event: { ...audited, data: { ...audited.data, quantity: 99 } } }, audited.audit.transactionId!)).toBe(false)
  })

  it('records failure and allows a controlled retry using the same event ID', async () => {
    const signer = new MockSigner()
    const provider = new MockBlockchainProvider(signer, 1)
    const failed = await submitEventForAudit(issuedEvent(), provider, signer)
    expect(failed.audit.status).toBe('FAILED')
    const retried = await submitEventForAudit({ ...failed, audit: { ...failed.audit, status: 'QUEUED_FOR_AUDIT' } }, provider, signer)
    expect(retried.eventId).toBe(failed.eventId)
    expect(retried.audit.status).toBe('CONFIRMED')
  })

  it('rejects invalid signatures', async () => {
    const signer = new MockSigner()
    const provider = new MockBlockchainProvider(signer)
    const event = issuedEvent()
    const eventHash = await hashEvent(event)
    await expect(provider.submitAuditEvent({ event, eventHash, signature: 'invalid', publicIdentity: signer.identity })).rejects.toThrow(/signature/i)
  })
})
