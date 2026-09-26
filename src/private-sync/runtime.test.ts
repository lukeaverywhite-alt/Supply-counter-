import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { MockIdentityProvider } from '../identity/identity'
import { decryptEvent, encryptEvent } from './crypto'
import { SharedSecretEpochKeyDistribution } from './keys'
import { loadSyncEnrollment, saveSyncEnrollment, SYNC_ENROLLMENT_KEY } from './runtime'
import { createRuntimeController } from './runtime'
import { IndexedDbRepository } from '../storage/repository'
import type { SignedArgusEvent } from '../distributed/types'
import { canonicalize } from '../distributed/canonical'

const memoryStorage = () => { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>{ values.set(key,value) } } }

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request=indexedDB.deleteDatabase('argus-operational-v2')
    request.onsuccess=()=>resolve(); request.onerror=()=>reject(request.error); request.onblocked=()=>reject(new Error('test database is still open'))
  })
})

describe('runtime shared synchronization enrollment', () => {
  it('persists valid runtime enrollment without build-time secrets', () => {
    const storage=memoryStorage(),value={endpoint:'https://relay.example.test',organizationId:'org_runtime_001',accessToken:'a-strong-runtime-secret'}
    saveSyncEnrollment(value,storage)
    expect(loadSyncEnrollment(storage)).toEqual(value)
    expect(storage.getItem(SYNC_ENROLLMENT_KEY)).not.toBeNull()
  })

  it('allows separately initialized devices with the same enrollment to decrypt history', async () => {
    const identity=new MockIdentityProvider('supply-officer-development'),organizationId='org_runtime_001',secret='a-strong-runtime-secret'
    const unsigned={protocol:'ARGUS' as const,protocolVersion:1 as const,organizationId,eventVersion:1 as const,eventId:'event_runtime_001',eventType:'INVENTORY_ITEM_UPDATED' as const,entityId:'item-001',actorPublicIdentity:identity.publicIdentity,timestamp:'2026-09-26T00:00:00.000Z',payload:{name:'Shared value'}}
    const event:SignedArgusEvent={...unsigned,signature:await identity.sign(canonicalize(unsigned))}
    const deviceA=new SharedSecretEpochKeyDistribution(organizationId,()=>secret),deviceB=new SharedSecretEpochKeyDistribution(organizationId,()=>secret)
    expect(await decryptEvent(await encryptEvent(event,identity,deviceA),identity.publicIdentity,identity,deviceB)).toEqual(event)
  })

  it('binds enrollment once and preserves signed events, delivery state, and prepared ciphertext on restart', async () => {
    const storage=memoryStorage(), enrollment={endpoint:'https://relay.example.test',organizationId:'org_runtime_restart',accessToken:'a-strong-runtime-secret'}
    saveSyncEnrollment(enrollment,storage)
    const first=await createRuntimeController(storage), before=await first.technicalState()
    expect(before.enrollmentMigration?.organizationId).toBe(enrollment.organizationId)

    const identity=new MockIdentityProvider('supply-officer-development')
    const unsigned={protocol:'ARGUS' as const,protocolVersion:1 as const,organizationId:enrollment.organizationId,eventVersion:1 as const,eventId:'event_restart_001',eventType:'INVENTORY_ITEM_UPDATED' as const,entityId:'item-001',actorPublicIdentity:identity.publicIdentity,timestamp:'2026-09-26T00:00:00.000Z',payload:{name:'Immutable event'}}
    const event:SignedArgusEvent={...unsigned,signature:await identity.sign(canonicalize(unsigned))}
    const envelope=await encryptEvent(event,identity,new SharedSecretEpochKeyDistribution(enrollment.organizationId,()=>enrollment.accessToken))
    await first.repository.transaction(state=>{
      state.events.push({event,syncStatus:'FAILED',auditStatus:'PENDING',receivedAt:'2026-09-26T00:00:01.000Z'})
      state.outbox.push({eventId:event.eventId,attempts:1,status:'FAILED',lastError:'acknowledgement lost'})
      state.privateSyncOutbox.push({providerId:'encrypted-relay-v1',eventId:event.eventId,envelope})
    })
    ;(first.repository as IndexedDbRepository).close()

    const reopened=await createRuntimeController(storage), after=await reopened.technicalState()
    expect(after.events.find(record=>record.event.eventId===event.eventId)?.event).toEqual(event)
    expect(after.outbox.find(record=>record.eventId===event.eventId)).toMatchObject({attempts:1,status:'FAILED'})
    expect(after.privateSyncOutbox.find(record=>record.eventId===event.eventId)?.envelope).toEqual(envelope)
    expect(after.enrollmentMigration).toEqual(before.enrollmentMigration)
    ;(reopened.repository as IndexedDbRepository).close()
  })

  it('rejects accidental reuse of an enrolled repository for another organization', async () => {
    const storage=memoryStorage()
    saveSyncEnrollment({endpoint:'https://relay.example.test',organizationId:'org_runtime_original',accessToken:'a-strong-runtime-secret'},storage)
    const first=await createRuntimeController(storage); (first.repository as IndexedDbRepository).close()
    saveSyncEnrollment({endpoint:'https://relay.example.test',organizationId:'org_runtime_changed',accessToken:'a-strong-runtime-secret'},storage)
    await expect(createRuntimeController(storage)).rejects.toThrow('already bound to another organization')
    const repository=new IndexedDbRepository('argus-operational-v2'); await repository.initialize(); repository.close()
  })
})
