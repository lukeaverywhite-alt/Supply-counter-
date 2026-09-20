import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelay } from '../../relay/server.mjs'
import { canonicalize } from '../distributed/canonical'
import type { SignedArgusEvent } from '../distributed/types'
import { MockIdentityProvider } from '../identity/identity'
import { decryptEvent, encryptEvent } from './crypto'
import { DevelopmentPersistentEpochKeyDistribution } from './keys'
import { RemotePrivateHistoryProvider } from './remote'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
const storage = () => { const map=new Map<string,string>();return { getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value)} } }

describe('real HTTP two-client encrypted synchronization', () => {
  it('moves inventory and cadet events as ciphertext between independently enrolled clients', async () => {
    const directory=await mkdtemp(join(tmpdir(),'argus-sync-')),database=join(directory,'relay.json'),token='development-token-123456789',organizationId='org-integration-001'
    const relay=createRelay({ database, organizations:{[organizationId]:token}, allowedOrigins:[] })
    await new Promise<void>(resolve=>relay.server.listen(0,'127.0.0.1',resolve));cleanups.push(async()=>{await new Promise<void>(resolve=>relay.server.close(()=>resolve()));await rm(directory,{recursive:true,force:true})})
    const address=relay.server.address();if(!address||typeof address==='string')throw new Error('Relay did not bind.')
    const endpoint=`http://127.0.0.1:${address.port}`,aIdentity=new MockIdentityProvider('client-a'),bIdentity=new MockIdentityProvider('client-b')
    const aKeys=new DevelopmentPersistentEpochKeyDistribution(organizationId,storage());await aKeys.rotateEpoch([aIdentity.publicIdentity,bIdentity.publicIdentity])
    const bKeys=new DevelopmentPersistentEpochKeyDistribution(organizationId,storage());bKeys.importEnrollment(aKeys.exportEnrollment())
    const aProvider=new RemotePrivateHistoryProvider({endpoint,organizationId,accessToken:()=>token}),bProvider=new RemotePrivateHistoryProvider({endpoint,organizationId,accessToken:()=>token})
    const make=async(eventId:string,eventType:SignedArgusEvent['eventType'],entityId:string,payload:Record<string,unknown>)=>{const unsigned={protocol:'ARGUS' as const,protocolVersion:1 as const,organizationId,eventVersion:1 as const,eventId,eventType,entityId,actorPublicIdentity:aIdentity.publicIdentity,timestamp:'2026-09-12T00:00:00.000Z',payload};return {...unsigned,signature:await aIdentity.sign(canonicalize(unsigned))}}
    const events=[await make('inventory-event-001','INVENTORY_ITEM_CREATED','inventory-item-001',{name:'Navy PT Shirt',category:'PT',variant:'Medium',niin:'REF-1',onHand:12,issued:0,countIncrement:1,active:true}),await make('cadet-event-0001','CADET_CREATED','cadet-record-001',{fullName:'Fictional Cadet',gender:'Male',nsLevel:'NS1',status:'ACTIVE',sizes:{}})]
    const envelopes=[]
    for(const event of events) { const envelope=await encryptEvent(event,aIdentity,aKeys);envelopes.push(envelope);await aProvider.publish(envelope) }
    const persisted=JSON.parse(await readFile(database,'utf8')) as {events:Array<{envelope:{ciphertext:string}}>};expect(JSON.stringify(persisted)).not.toContain('Fictional Cadet');expect(persisted.events.every(row=>row.envelope.ciphertext.length>0)).toBe(true)
    const page=await bProvider.getSince('0'),received=[] as SignedArgusEvent[]
    for(const envelope of page.envelopes)received.push(await decryptEvent(envelope,bIdentity.publicIdentity,bIdentity,bKeys))
    expect(received.map(event=>event.eventId)).toEqual(events.map(event=>event.eventId));expect(page.cursor).toBe('2')
    await aProvider.publish(envelopes[0]);expect((await bProvider.getSince('2')).envelopes).toHaveLength(0)
  })
})
