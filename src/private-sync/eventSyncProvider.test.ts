import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../auth/authorization'
import { DistributedAppController } from '../distributed/appIntegration'
import { WebCryptoIdentityProvider } from '../identity/identity'
import { MemoryRepository } from '../storage/repository'
import { DurableEncryptedEventSyncProvider } from './eventSyncProvider'
import { MockEpochKeyDistribution } from './keys'
import { MockPrivateHistoryProvider } from './provider'

const storage = () => { const values = new Map<string,string>(); return { getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>void values.set(key,value) } }

describe('normal-runtime encrypted shared counting', () => {
  it('converges independent enrolled clients to six through ciphertext-only history', async () => {
    const organizationId='org-live-test',root=await WebCryptoIdentityProvider.create(),a=await WebCryptoIdentityProvider.create(),b=await WebCryptoIdentityProvider.create()
    const authorization=new AuthorizationService(await root.getPublicIdentity(),root)
    for(const identity of [a,b])await authorization.acceptCredential(await issueCredential(root,{subjectPublicIdentity:await identity.getPublicIdentity(),role:'SUPPLY_OFFICER',permissions:[...ROLE_PERMISSIONS.SUPPLY_OFFICER],issuedAt:'2026-01-01T00:00:00.000Z'}))
    const keys=new MockEpochKeyDistribution(organizationId);await keys.rotateEpoch([await a.getPublicIdentity(),await b.getPublicIdentity()])
    const relay=new MockPrivateHistoryProvider('shared-relay'),repositories=[new MemoryRepository(),new MemoryRepository()]
    const providers=[a,b].map((identity,index)=>new DurableEncryptedEventSyncProvider('relay',repositories[index],relay,identity,keys,organizationId))
    const clients=[a,b].map((identity,index)=>new DistributedAppController(repositories[index],{identity,authorization,provider:providers[index],organizationId}))
    for(const client of clients)await client.initialize(storage())
    const item=(await clients[0].project()).inventory[0]
    await clients[0].createCountSession({sessionId:'fall-shared',scope:'uniform room',assignments:[{assignmentId:'shelf-a',itemId:item.entityId,scope:'Shelf A'},{assignmentId:'shelf-b',itemId:item.entityId,scope:'Shelf B'}]})
    await clients[1].sync();clients[0].setOnline(false);clients[1].setOnline(false)
    await clients[0].contributeCount('fall-shared','shelf-a',3);await clients[1].contributeCount('fall-shared','shelf-b',3)
    clients[0].setOnline(true);clients[1].setOnline(true)
    await clients[0].sync();await clients[1].sync();await clients[0].sync()
    for(const client of clients)expect((await client.project()).countSessions[0].totals[item.entityId]).toBe(6)
    const raw=await relay.getSince();expect(JSON.stringify(raw.envelopes)).not.toContain('COUNT_CONTRIBUTED')
  })

  it('retains and reuses prepared ciphertext after an ambiguous publish failure', async () => {
    const organizationId='org-retry',identity=await WebCryptoIdentityProvider.create(),keys=new MockEpochKeyDistribution(organizationId)
    await keys.rotateEpoch([await identity.getPublicIdentity()])
    const repository=new MemoryRepository();await repository.initialize()
    const relay=new MockPrivateHistoryProvider('retry'),original=relay.publish.bind(relay);let lose=true
    relay.publish=async envelope=>{await original(envelope);if(lose){lose=false;throw new Error('ack lost')}return undefined}
    const provider=new DurableEncryptedEventSyncProvider('relay',repository,relay,identity,keys,organizationId)
    const event={protocol:'ARGUS' as const,protocolVersion:1 as const,organizationId,eventVersion:1 as const,eventId:'event-retry',eventType:'COUNT_CONTRIBUTED' as const,entityId:'session',actorPublicIdentity:await identity.getPublicIdentity(),timestamp:'2026-09-26T00:00:00.000Z',payload:{assignmentId:'a',itemId:'i',quantity:3},signature:'placeholder'}
    await expect(provider.publish(event)).resolves.toBeUndefined()
    const prepared=await relay.getByEventId(event.eventId)
    expect((await repository.snapshot()).privateSyncOutbox).toEqual([])
    await provider.publish(event)
    expect(await relay.getByEventId(event.eventId)).toEqual(prepared)
    expect((await repository.snapshot()).privateSyncOutbox).toEqual([])
    expect((await repository.snapshot()).privateSyncDeliveries[0].envelope).toEqual(prepared)
  })
})
