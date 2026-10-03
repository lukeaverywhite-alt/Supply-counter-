import { describe, expect, it } from 'vitest'
import { unitAnchorAddress } from '../blockchain/anchor'
import { FakeChain } from '../chain/fakeChain'
import { DeviceWallet } from '../chain/wallet'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { canonicalize } from '../distributed/canonical'
import type { SignedArgusEvent } from '../distributed/types'
import { MockIdentityProvider } from '../identity/identity'
import { importChannelKey, newChannelKey, sealEnvelope, sealToChannel, serializeChannelEnvelope, serializeEnvelope } from './envelope'
import { MemoryLedgerStore, type StoredEnvelope } from './ledgerStore'
import { ChainTransport } from './transport'

async function unitEnvelope(key: CryptoKey) {
  const identity = new MockIdentityProvider('officer')
  const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'unit-a', eventVersion: 1 as const, eventId: 'e-1', eventType: 'INVENTORY_RECEIVED' as const, entityId: 'item_1', actorPublicIdentity: await identity.getPublicIdentity(), timestamp: '2026-10-03T12:00:00.000Z', clock: 1, payload: { quantity: 3 } }
  return sealEnvelope({ unitId: 'unit-a', epochId: 'e1', key, plaintext: { event: { ...unsigned, signature: await identity.sign(canonicalize(unsigned)) } as SignedArgusEvent } })
}

describe('the unit transport and cadet channel records (kind C)', () => {
  it('skips a channel record it finds at the unit address and still takes the unit record beside it', async () => {
    const chain = new FakeChain(), wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(wallet.address, 100_000, { confirmed: true })
    const epochKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const channelKey = await importChannelKey(newChannelKey())
    const channelRecord = serializeChannelEnvelope(await sealToChannel({ channelId: 'some-channel', key: channelKey, kind: 'view', plaintext: { version: 1 } }))
    const unitRecord = await unitEnvelope(epochKey)
    // Someone pays the unit anchor with a channel record alone, and with a channel record beside a unit record.
    await wallet.prepareRecords([{ kind: 'C', payload: channelRecord }], unitAnchorAddress('unit-a'), ['c-only'])
    await wallet.prepareRecords([{ kind: 'C', payload: channelRecord }, { kind: 'E', payload: serializeEnvelope(unitRecord) }], unitAnchorAddress('unit-a'), ['mixed'])
    expect((await wallet.flush()).broadcast).toHaveLength(2)
    const store = new MemoryLedgerStore(), received: StoredEnvelope[] = []
    const transport = new ChainTransport({ unitId: 'unit-a', api: chain, wallet: DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore()), store, onRemoteEnvelopes: async records => { received.push(...records) } })
    await transport.scanOnce()
    expect(received.map(record => record.eventId)).toEqual(['e-1'])
    expect((await store.envelopes()).map(record => canonicalize(record.envelope))).toEqual([canonicalize(unitRecord)])
    expect(transport.status().lastError).toBeUndefined()
  })
})
