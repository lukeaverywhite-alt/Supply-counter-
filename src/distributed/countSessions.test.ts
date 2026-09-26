import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { MockIdentityProvider, WebCryptoIdentityProvider } from '../identity/identity'
import { MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { ArgusReplica } from './replica'

async function clients() {
  const root = new MockIdentityProvider('count-root'), verifier = new MockIdentityProvider('verifier')
  const authorization = new AuthorizationService(await root.getPublicIdentity(), verifier)
  const provider = new MockSyncProvider(), identities = [new MockIdentityProvider('counter-a'), new MockIdentityProvider('counter-b')]
  for (const identity of identities) await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
  const repositories = [new MemoryRepository(), new MemoryRepository()]
  const replicas = identities.map((identity, index) => new ArgusReplica(repositories[index], identity, authorization, provider, 'org-a'))
  for (const replica of replicas) await replica.initialize([{ entityId: 'shirt-m', name: 'Shirt', variant: 'M', onHand: 10, version: 0 }])
  await replicas[0].createCountSession({ sessionId: 'fall', scope: 'warehouse', assignments: [
    { assignmentId: 'bin-a', itemId: 'shirt-m', scope: 'Shelf A' },
    { assignmentId: 'bin-b', itemId: 'shirt-m', scope: 'Shelf B' },
  ] })
  await replicas[1].sync()
  return { replicas, repositories, provider, authorization, identities }
}

describe('first-class shared count sessions', () => {
  it('uses distinct real Web Crypto signatures and rejects forgery', async () => {
    const a = await WebCryptoIdentityProvider.create(), b = await WebCryptoIdentityProvider.create()
    const signature = await a.sign('count payload')
    expect(await a.getPublicIdentity()).not.toBe(await b.getPublicIdentity())
    expect(await b.verify('count payload', signature, await a.getPublicIdentity())).toBe(true)
    expect(await b.verify('altered payload', signature, await a.getPublicIdentity())).toBe(false)
  })
  it('commutes independent contributions, deduplicates retries, and corrects append-only', async () => {
    const { replicas, provider } = await clients()
    replicas[0].online = false; replicas[1].online = false
    const a = await replicas[0].contributeCount('fall', 'bin-a', 3, '', { eventId: 'contribution-a' })
    await replicas[1].contributeCount('fall', 'bin-b', 3, '', { eventId: 'contribution-b' })
    replicas[0].online = true; replicas[1].online = true
    provider.reorderDelivery = true
    await replicas[1].sync(); await replicas[0].sync(); await replicas[1].sync()
    for (const replica of replicas) expect((await replica.snapshot()).countSessions[0].totals['shirt-m']).toBe(6)
    await replicas[1].receive(a); await replicas[1].receive(a)
    expect((await replicas[1].snapshot()).countSessions[0].totals['shirt-m']).toBe(6)
    const correction = await replicas[0].correctCount('fall', 'contribution-a', 2, 'One item was in the adjacent bin.', { eventId: 'correction-a' })
    await replicas[1].sync(); await replicas[1].receive(correction)
    const state = await replicas[1].snapshot()
    expect(state.countSessions[0].totals['shirt-m']).toBe(5)
    expect(state.countSessions[0].observations.find(o => o.eventId === 'contribution-a')).toMatchObject({ quantity: 3, effectiveQuantity: 2, status: 'CORRECTED' })
  })

  it('recount supersedes a scope, flags late offline work, and reconciles observed stock exactly once', async () => {
    const { replicas } = await clients()
    await replicas[0].contributeCount('fall', 'bin-a', 3, '', { eventId: 'first-a' })
    await replicas[0].recount('fall', 'bin-a', 2, 'Supervisor recount', { eventId: 'recount-a' })
    expect((await replicas[0].snapshot()).countSessions[0].totals['shirt-m']).toBe(2)
    replicas[1].online = false
    await replicas[1].contributeCount('fall', 'bin-b', 3, '', { eventId: 'offline-b' })
    await replicas[0].submitCountSession('fall')
    replicas[1].online = true; await replicas[1].sync(); await replicas[0].sync()
    expect((await replicas[0].snapshot()).countSessions[0]).toMatchObject({ status: 'SUBMITTED', lateEventIds: ['offline-b'] })
    await expect(replicas[0].reconcileCountSession('fall')).rejects.toThrow(/late work/)
  })

  it('survives a repository restart and applies a submitted physical result rather than adding it to stock', async () => {
    const { replicas, repositories, provider, authorization, identities } = await clients()
    replicas[0].online = false
    await replicas[0].contributeCount('fall', 'bin-a', 3, '', { eventId: 'persisted-a' })
    const restarted = new ArgusReplica(repositories[0], identities[0], authorization, provider, 'org-a')
    await restarted.initialize()
    expect((await restarted.snapshot()).outbox.map(o => o.eventId)).toContain('persisted-a')
    await restarted.submitCountSession('fall'); await restarted.reconcileCountSession('fall')
    const state = await restarted.snapshot()
    expect(state.inventory[0].onHand).toBe(3)
    expect(state.countSessions[0]).toMatchObject({ status: 'RECONCILED', totals: { 'shirt-m': 3 } })
    await expect(restarted.reconcileCountSession('fall')).rejects.toThrow(/not ready/)
  })
})
