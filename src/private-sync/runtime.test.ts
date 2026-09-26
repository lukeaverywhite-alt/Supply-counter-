import { describe, expect, it } from 'vitest'
import { MockIdentityProvider } from '../identity/identity'
import { decryptEvent, encryptEvent } from './crypto'
import { SharedSecretEpochKeyDistribution } from './keys'
import { loadSyncEnrollment, saveSyncEnrollment, SYNC_ENROLLMENT_KEY } from './runtime'
import type { SignedArgusEvent } from '../distributed/types'
import { canonicalize } from '../distributed/canonical'

const memoryStorage = () => { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null, setItem:(key:string,value:string)=>{ values.set(key,value) } } }

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
})
