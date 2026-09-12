import { describe, expect, it } from 'vitest'
import { MockIdentityProvider } from '../identity/identity'
import { canonicalize } from '../distributed/canonical'
import type { SignedArgusEvent } from '../distributed/types'
import { decryptEvent, encryptEvent } from './crypto'
import { MockEpochKeyDistribution } from './keys'
import { MockPrivateHistoryProvider, MultiPrivateHistoryProvider } from './provider'
import { parseEncryptedEnvelope } from './schema'
import { PrivateSyncEngine } from './engine'
import { MemoryRepository } from '../storage/repository'

async function fixture() {
  const sender = new MockIdentityProvider('officer'), recipient = new MockIdentityProvider('recipient'), revoked = new MockIdentityProvider('revoked'), keys = new MockEpochKeyDistribution('org-opaque-test')
  await keys.rotateEpoch([await sender.getPublicIdentity(), await recipient.getPublicIdentity(), await revoked.getPublicIdentity()])
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'org-opaque-test', eventVersion: 1 as const, eventId: 'event-test-001', eventType: 'ITEM_ISSUED' as const, entityId: 'item-test-001', actorPublicIdentity: await sender.getPublicIdentity(), timestamp: '2026-09-11T00:00:00.000Z', baseVersion: 0, payload: { quantity: 1 } }
  const event: SignedArgusEvent = { ...unsigned, signature: await sender.sign(canonicalize(unsigned)) }
  return { sender, recipient, revoked, keys, event }
}

describe('Stage 2.5 encrypted private history', () => {
  it('encrypts with authenticated AES-GCM and decrypts for an authorized identity', async () => { const { sender, recipient, keys, event } = await fixture(); const envelope = await encryptEvent(event, sender, keys); expect(envelope.ciphertext).not.toContain('ITEM_ISSUED'); expect(await decryptEvent(envelope, await recipient.getPublicIdentity(), recipient, keys)).toEqual(event) })
  it('rejects altered ciphertext and malformed/future envelopes', async () => { const { sender, recipient, keys, event } = await fixture(); const envelope = await encryptEvent(event, sender, keys); await expect(decryptEvent({ ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}AA` }, await recipient.getPublicIdentity(), recipient, keys)).rejects.toThrow(/hash|decryption/); expect(() => parseEncryptedEnvelope({ ...envelope, protocolVersion: 2 })).toThrow(/Unsupported/) })
  it('rotates epochs and denies a revoked identity future keys without claiming old-key erasure', async () => { const { sender, recipient, revoked, keys, event } = await fixture(); const oldEnvelope = await encryptEvent(event, sender, keys); expect(await decryptEvent(oldEnvelope, await revoked.getPublicIdentity(), revoked, keys)).toEqual(event); keys.revoke(await revoked.getPublicIdentity()); await keys.rotateEpoch([await sender.getPublicIdentity(), await recipient.getPublicIdentity()]); const next = await encryptEvent({ ...event, eventId: 'event-test-002' }, sender, keys); await expect(decryptEvent(next, await revoked.getPublicIdentity(), revoked, keys)).rejects.toThrow(/decryption failed/); expect((await decryptEvent(next, await recipient.getPublicIdentity(), recipient, keys)).eventId).toBe('event-test-002') })
  it('replicates to two untrusted providers, deduplicates, and recovers when provider A disappears', async () => { const { sender, recipient, keys, event } = await fixture(); const a = new MockPrivateHistoryProvider('A'), b = new MockPrivateHistoryProvider('B'), multi = new MultiPrivateHistoryProvider([a, b]), envelope = await encryptEvent(event, sender, keys); await multi.publish(envelope); a.unavailable = true; b.duplicateDelivery = true; const page = await multi.getSince(); expect(page.envelopes).toHaveLength(1); expect((await decryptEvent(page.envelopes[0], await recipient.getPublicIdentity(), recipient, keys)).eventId).toBe(event.eventId) })
  it('keeps a valid envelope queued conceptually when every provider is unavailable', async () => { const { sender, keys, event } = await fixture(); const a = new MockPrivateHistoryProvider('A'), b = new MockPrivateHistoryProvider('B'); a.unavailable = b.unavailable = true; await expect(new MultiPrivateHistoryProvider([a, b]).publish(await encryptEvent(event, sender, keys))).rejects.toThrow(/All/) })
  it('single-flights sync and does not delete an outbox event created during publish', async () => {
    const { sender, keys, event } = await fixture(), repository = new MemoryRepository(), provider = new MockPrivateHistoryProvider('delayed')
    await repository.transaction(state => { state.events.push({ event, syncStatus:'QUEUED', auditStatus:'PENDING', receivedAt:event.timestamp }); state.outbox.push({ eventId:event.eventId, attempts:0, status:'QUEUED' }) })
    const original = provider.publish.bind(provider); let release!:()=>void, started!:()=>void, publishes=0
    const publishing = new Promise<void>(resolve=>{started=resolve}), gate = new Promise<void>(resolve=>{release=resolve})
    provider.publish = async envelope => { publishes++;started();await gate;return original(envelope) }
    const engine = new PrivateSyncEngine({ providerId:'test', repository, provider, identity:sender, keys, organizationId:event.organizationId, validateAndApply:()=>undefined })
    const first=engine.sync();expect(engine.sync()).toBe(first)
    await publishing
    await repository.transaction(state=>state.outbox.push({eventId:'new-during-sync',attempts:0,status:'QUEUED'}));release();await first
    expect(publishes).toBe(1);expect((await repository.snapshot()).outbox.map(value=>value.eventId)).toEqual(['new-during-sync'])
  })
})
