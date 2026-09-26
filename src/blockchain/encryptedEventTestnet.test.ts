import { describe, expect, it } from 'vitest'
import { MockIdentityProvider } from '../identity/identity'
import { MockEpochKeyDistribution } from '../private-sync/keys'
import { encryptEvent } from '../private-sync/crypto'
import type { SignedArgusEvent } from '../distributed/types'
import { EncryptedEventTestnetAdapter, decodeEventOutput, encodeEventOutput, type ArgusOverlayClient, type Brc100TestnetWallet } from './EncryptedEventTestnet'

async function envelope() {
  const identity = new MockIdentityProvider('chain-user'), keys = new MockEpochKeyDistribution('org-a')
  await keys.rotateEpoch([await identity.getPublicIdentity()])
  const unsigned = { protocol:'ARGUS' as const,protocolVersion:1 as const,organizationId:'org-a',eventVersion:1 as const,eventId:'event-a',eventType:'COUNT_CONTRIBUTED' as const,entityId:'session-a',actorPublicIdentity:await identity.getPublicIdentity(),timestamp:'2026-09-26T00:00:00.000Z',payload:{assignmentId:'bin-a',itemId:'shirt',quantity:3} }
  const event = { ...unsigned, signature: await identity.sign(JSON.stringify(unsigned)) } as SignedArgusEvent
  return encryptEvent(event, identity, keys)
}

describe('encrypted BSV testnet event adapter', () => {
  it('round-trips the complete ciphertext envelope through an OP_FALSE OP_RETURN output', async () => {
    const encrypted = await envelope(), decoded = decodeEventOutput(encodeEventOutput(encrypted))
    expect(decoded).toEqual(encrypted)
    expect(decoded.ciphertext).not.toContain('COUNT_CONTRIBUTED')
  })
  it('uses the current BRC-100 createAction boundary and resolves ambiguous retries by event ID', async () => {
    const encrypted = await envelope(), calls: unknown[] = []
    const wallet: Brc100TestnetWallet = { getNetwork: async()=>({network:'testnet'}), createAction:async args=>{calls.push(args);return{txid:'a'.repeat(64),tx:[1,2,3]}} }
    const state: { known?: string } = {}
    const overlay: ArgusOverlayClient = { event:async()=>state.known?{transactionId:state.known,lockingScript:encodeEventOutput(encrypted)}:undefined,history:async()=>({records:[],complete:true}) }
    const adapter = new EncryptedEventTestnetAdapter(wallet,overlay,'org-a')
    expect(await adapter.publish(encrypted)).toMatchObject({transactionId:'a'.repeat(64),duplicate:false,state:'BROADCAST'})
    state.known='b'.repeat(64)
    expect(await adapter.publish(encrypted)).toMatchObject({transactionId:'b'.repeat(64),duplicate:true})
    expect(calls).toHaveLength(1)
  })
  it('fails closed on mainnet and exposes incomplete overlay enumeration', async () => {
    const encrypted=await envelope()
    const wallet: Brc100TestnetWallet={getNetwork:async()=>({network:'mainnet'}),createAction:async()=>({txid:'a'.repeat(64)})}
    const overlay: ArgusOverlayClient={event:async()=>undefined,history:async()=>({records:[{transactionId:'a'.repeat(64),lockingScript:encodeEventOutput(encrypted)}],complete:false})}
    await expect(new EncryptedEventTestnetAdapter(wallet,overlay,'org-a').publish(encrypted)).rejects.toThrow(/TESTNET/)
    const testnet={...wallet,getNetwork:async()=>({network:'testnet' as const})}
    expect((await new EncryptedEventTestnetAdapter(testnet,overlay,'org-a').retrieve()).complete).toBe(false)
  })
  it('does not interpret an unavailable index as permission to publish again', async () => {
    const encrypted=await envelope(), wallet:Brc100TestnetWallet={getNetwork:async()=>({network:'testnet'}),createAction:async()=>({txid:'a'.repeat(64)})}
    const overlay:ArgusOverlayClient={event:async()=>{throw new Error('index timed out')},history:async()=>({records:[],complete:false})}
    await expect(new EncryptedEventTestnetAdapter(wallet,overlay,'org-a').publish(encrypted)).rejects.toThrow('index timed out')
  })
  it('rejects an event-ID collision whose indexed envelope differs', async () => {
    const encrypted=await envelope(), changed={...encrypted,ciphertext:encrypted.ciphertext.replace(/.$/,'A')}
    const wallet:Brc100TestnetWallet={getNetwork:async()=>({network:'testnet'}),createAction:async()=>({txid:'a'.repeat(64)})}
    const overlay:ArgusOverlayClient={event:async()=>({transactionId:'b'.repeat(64),lockingScript:encodeEventOutput(changed)}),history:async()=>({records:[],complete:true})}
    await expect(new EncryptedEventTestnetAdapter(wallet,overlay,'org-a').publish(encrypted)).rejects.toThrow(/collision/)
  })
})
