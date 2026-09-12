import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential, issueRevocation } from '../auth/authorization'
import { MockIdentityProvider } from '../identity/identity'
import { canonicalize } from './canonical'
import { IndexedDbRepository, MemoryRepository } from '../storage/repository'
import { MockSyncProvider } from '../sync/mock'
import { ArgusReplica } from './replica'

const at = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
async function authority() {
  const root = new MockIdentityProvider('root'), verifier = new MockIdentityProvider('verifier')
  const auth = new AuthorizationService(await root.getPublicIdentity(), verifier)
  return { root, auth }
}
async function grant(auth: AuthorizationService, root: MockIdentityProvider, user: MockIdentityProvider, role: 'MASTER' | 'SUPPLY_OFFICER' | 'SUPPLY_ASSISTANT', issuedAt = at(1)) {
  const credential = await issueCredential(root, { subjectPublicIdentity: await user.getPublicIdentity(), role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt })
  await auth.acceptCredential(credential); return credential
}

describe('Stage 2 identity and authorization', () => {
  it('creates independent mock identities and signs/verifies deterministically', async () => {
    const a = new MockIdentityProvider('a'), b = new MockIdentityProvider('b'), signature = await a.sign('payload')
    expect(await a.getPublicIdentity()).toBe('mock:a'); expect(await b.getPublicIdentity()).not.toBe(await a.getPublicIdentity())
    expect(await b.verify('payload', signature, 'mock:a')).toBe(true)
    expect(await b.verify('altered', signature, 'mock:a')).toBe(false)
  })
  it('maps permissions, verifies root credentials, and rejects tampering/expiry', async () => {
    const { root, auth } = await authority(), user = new MockIdentityProvider('officer')
    const credential = await grant(auth, root, user, 'SUPPLY_OFFICER')
    expect(() => auth.require('mock:officer', 'inventory.issue', at(2))).not.toThrow()
    await expect(auth.acceptCredential({ ...credential, role: 'MASTER' })).rejects.toThrow(/signature/)
    const expired = await issueCredential(root, { subjectPublicIdentity: 'mock:expired', role: 'SUPPLY_ASSISTANT', permissions: [...ROLE_PERMISSIONS.SUPPLY_ASSISTANT], issuedAt: at(1), expiresAt: at(2) })
    await auth.acceptCredential(expired); expect(() => auth.require('mock:expired', 'inventory.issue', at(3))).toThrow(/Unauthorized/)
  })
  it('rejects an insufficiently authorized domain action', async () => {
    const { root, auth } = await authority(), user = new MockIdentityProvider('reader')
    const credential = await issueCredential(root, { subjectPublicIdentity: 'mock:reader', role: 'SUPPLY_ASSISTANT', permissions: ['inventory.read'], issuedAt: at(1) }); await auth.acceptCredential(credential)
    const replica = new ArgusReplica(new MemoryRepository(), user, auth, new MockSyncProvider()); await replica.initialize([{ entityId: 'jacket', name: 'Jacket', onHand: 1, version: 0 }])
    await expect(replica.issue('jacket', 1, { timestamp: at(2) })).rejects.toThrow(/inventory.issue/)
  })
  it('applies revocation prospectively while retaining historical events', async () => {
    const { root, auth } = await authority(), user = new MockIdentityProvider('officer'), credential = await grant(auth, root, user, 'SUPPLY_OFFICER')
    const replica = new ArgusReplica(new MemoryRepository(), user, auth, new MockSyncProvider()); await replica.initialize([{ entityId: 'jacket', name: 'Jacket', onHand: 2, version: 0 }]); await replica.issue('jacket', 1, { timestamp: at(2) })
    await auth.acceptRevocation(await issueRevocation(root, credential, at(3)))
    await expect(replica.issue('jacket', 1, { timestamp: at(4) })).rejects.toThrow(/Unauthorized/)
    expect((await replica.snapshot()).events).toHaveLength(1)
  })
  it('verifies delegated Master chains and rejects credentials issued after delegation revocation', async () => {
    const { root, auth } = await authority(), master = new MockIdentityProvider('master-b'), assistant = new MockIdentityProvider('assistant-c')
    const delegation = await grant(auth, root, master, 'MASTER', at(1))
    const child = await issueCredential(master, { subjectPublicIdentity: 'mock:assistant-c', role: 'SUPPLY_ASSISTANT', permissions: [...ROLE_PERMISSIONS.SUPPLY_ASSISTANT], issuedAt: at(2) }); await auth.acceptCredential(child)
    const assistantIdentity = await assistant.getPublicIdentity()
    expect(() => auth.require(assistantIdentity, 'inventory.issue', at(3))).not.toThrow()
    await auth.acceptRevocation(await issueRevocation(root, delegation, at(4)))
    const late = await issueCredential(master, { subjectPublicIdentity: 'mock:late', role: 'SUPPLY_ASSISTANT', permissions: [...ROLE_PERMISSIONS.SUPPLY_ASSISTANT], issuedAt: at(5) })
    await expect(auth.acceptCredential(late)).rejects.toThrow(/issuer/)
  })
})

describe('Stage 2 event store, outbox and replicas', () => {
  it('provides isolated memory storage and fails without destructively falling back when IndexedDB is unavailable', async () => {
    const one = new MemoryRepository(), two = new MemoryRepository(); await one.initialize(); await two.initialize()
    await one.transaction(state => state.conflicts.push({ id: 'c', entityId: 'i', eventIds: [], status: 'OPEN', reason: 'test' }))
    expect((await one.snapshot()).conflicts).toHaveLength(1); expect((await two.snapshot()).conflicts).toHaveLength(0)
    await expect(new IndexedDbRepository('test-unavailable').initialize()).rejects.toThrow(/unavailable/)
  })
  it('canonicalizes equivalent values and distinguishes meaningful changes', () => {
    expect(canonicalize({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalize({ a: { c: 3, d: 4 }, b: 2 }))
    expect(canonicalize({ quantity: 1 })).not.toBe(canonicalize({ quantity: 2 }))
  })
  it('persists signed local events/outbox offline, retries the same ID, and converges three independent replicas', async () => {
    const { root, auth } = await authority(), provider = new MockSyncProvider(), identities = [new MockIdentityProvider('a'), new MockIdentityProvider('b'), new MockIdentityProvider('c')]
    for (const identity of identities) await grant(auth, root, identity, 'SUPPLY_OFFICER')
    const clients = identities.map(identity => new ArgusReplica(new MemoryRepository(), identity, auth, provider)); for (const client of clients) await client.initialize([{ entityId: 'item', name: 'Item', onHand: 10, version: 0 }])
    clients[0].online = false; const event = await clients[0].issue('item', 1, { timestamp: at(2) }); const state = await clients[0].snapshot()
    expect(state.inventory[0].onHand).toBe(9); expect(state.outbox[0].eventId).toBe(event.eventId); expect(state.events[0].syncStatus).toBe('QUEUED')
    clients[0].online = true; await clients[0].sync(); await clients[1].sync(); await clients[2].sync()
    expect(await Promise.all(clients.map(async c => (await c.snapshot()).inventory[0].onHand))).toEqual([9, 9, 9])
    expect((await clients[0].snapshot()).events[0].event.eventId).toBe(event.eventId)
  })
  it('survives provider failure and reconnect without losing valid local work', async () => {
    const { root, auth } = await authority(), user = new MockIdentityProvider('a'), provider = new MockSyncProvider(); await grant(auth, root, user, 'SUPPLY_OFFICER')
    const replica = new ArgusReplica(new MemoryRepository(), user, auth, provider); await replica.initialize([{ entityId: 'item', name: 'Item', onHand: 2, version: 0 }]); replica.online = false; const event = await replica.issue('item', 1, { timestamp: at(2) })
    provider.unavailable = true; replica.online = true; await expect(replica.sync()).rejects.toThrow(/unavailable/); expect((await replica.snapshot()).outbox[0]).toMatchObject({ eventId: event.eventId, status: 'FAILED' })
    provider.unavailable = false; await replica.sync(); expect((await replica.snapshot()).outbox).toHaveLength(0)
  })
  it('deduplicates duplicate and retried deliveries', async () => {
    const { root, auth } = await authority(), a = new MockIdentityProvider('a'), b = new MockIdentityProvider('b'), provider = new MockSyncProvider(); await grant(auth, root, a, 'SUPPLY_OFFICER'); await grant(auth, root, b, 'SUPPLY_OFFICER')
    const one = new ArgusReplica(new MemoryRepository(), a, auth, provider), two = new ArgusReplica(new MemoryRepository(), b, auth, provider); await one.initialize([{ entityId: 'item', name: 'Item', onHand: 3, version: 0 }]); await two.initialize([{ entityId: 'item', name: 'Item', onHand: 3, version: 0 }]); await one.issue('item', 1, { timestamp: at(2) }); provider.duplicateDelivery = true; await two.sync(); await two.sync()
    expect((await two.snapshot()).inventory[0]).toMatchObject({ onHand: 2, version: 1 }); expect((await two.snapshot()).events).toHaveLength(1)
  })
  it('rejects invalid signatures and corrupted authoritative events', async () => {
    const { root, auth } = await authority(), a = new MockIdentityProvider('a'), b = new MockIdentityProvider('b'), provider = new MockSyncProvider(); await grant(auth, root, a, 'SUPPLY_OFFICER'); await grant(auth, root, b, 'SUPPLY_OFFICER')
    const one = new ArgusReplica(new MemoryRepository(), a, auth, provider), two = new ArgusReplica(new MemoryRepository(), b, auth, provider); await one.initialize([{ entityId: 'item', name: 'Item', onHand: 3, version: 0 }]); await two.initialize([{ entityId: 'item', name: 'Item', onHand: 3, version: 0 }]); const event = await one.issue('item', 1, { timestamp: at(2) })
    await expect(two.receive({ ...event, payload: { quantity: 2 } })).rejects.toThrow(/signature/)
    await expect(two.receive({ ...event, signature: 'bad' })).rejects.toThrow(/signature/)
  })
  it('detects two offline issues of the final unit without negative inventory or silent winner', async () => {
    const { root, auth } = await authority(), a = new MockIdentityProvider('a'), b = new MockIdentityProvider('b'), provider = new MockSyncProvider(); await grant(auth, root, a, 'SUPPLY_OFFICER'); await grant(auth, root, b, 'SUPPLY_OFFICER')
    const clients = [new ArgusReplica(new MemoryRepository(), a, auth, provider), new ArgusReplica(new MemoryRepository(), b, auth, provider)]; for (const c of clients) { await c.initialize([{ entityId: 'jacket-m', name: 'Medium SDB Jacket', onHand: 1, version: 7 }]); c.online = false }
    await clients[0].issue('jacket-m', 1, { timestamp: at(2) }); await clients[1].issue('jacket-m', 1, { timestamp: at(2) }); for (const c of clients) { c.online = true; await c.sync() }; await clients[0].sync()
    for (const c of clients) { const state = await c.snapshot(); expect(state.inventory[0].onHand).toBe(0); expect(state.events).toHaveLength(2); expect(state.conflicts[0]).toMatchObject({ status: 'OPEN', entityId: 'jacket-m' }) }
    await clients[0].resolve((await clients[0].snapshot()).conflicts[0].id, 'Verified physical stock; second issue requires replacement.')
    expect((await clients[0].snapshot()).conflicts[0].status).toBe('RESOLVED')
  })
  it('retains an original event and an append-only correction', async () => {
    const { root, auth } = await authority(), user = new MockIdentityProvider('a'), provider = new MockSyncProvider(); await grant(auth, root, user, 'SUPPLY_OFFICER'); const replica = new ArgusReplica(new MemoryRepository(), user, auth, provider); await replica.initialize([{ entityId: 'trousers', name: 'Black Trousers', onHand: 2, version: 0 }]); replica.online = false
    const original = await replica.issue('trousers', 1, { timestamp: at(2) }); const correction = await replica.correct(original.eventId, 'trousers', 'size', '32R', 'Incorrect size recorded'); const state = await replica.snapshot()
    expect(state.events.map(e => e.event.eventId)).toEqual([original.eventId, correction.eventId]); expect(correction.payload).toMatchObject({ originalEventId: original.eventId, value: '32R' })
  })
  it('handles deliberately reordered delivery while retaining all events', async () => {
    const { root, auth } = await authority(), a = new MockIdentityProvider('a'), b = new MockIdentityProvider('b'), provider = new MockSyncProvider(); await grant(auth, root, a, 'SUPPLY_OFFICER'); await grant(auth, root, b, 'SUPPLY_OFFICER'); const one = new ArgusReplica(new MemoryRepository(), a, auth, provider), two = new ArgusReplica(new MemoryRepository(), b, auth, provider); await one.initialize([{ entityId: 'item', name: 'Item', onHand: 4, version: 0 }]); await two.initialize([{ entityId: 'item', name: 'Item', onHand: 4, version: 0 }]); await one.issue('item', 1, { timestamp: at(2) }); await one.issue('item', 1, { timestamp: at(3) }); provider.reorderDelivery = true; await two.sync(); expect((await two.snapshot()).events).toHaveLength(2)
  })
})
