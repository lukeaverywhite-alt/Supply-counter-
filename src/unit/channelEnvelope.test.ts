import { describe, expect, it } from 'vitest'
import { channelAddress } from '../blockchain/anchor'
import { MockIdentityProvider } from '../identity/identity'
import { canonicalize } from '../distributed/canonical'
import type { SignedArgusEvent } from '../distributed/types'
import { PUBLIC_CHANNEL_ENVELOPE_FIELDS, bytesToBase64, deserializeChannelEnvelope, importChannelKey, newChannelKey, openEnvelope, openFromChannel, sealEnvelope, sealToChannel, serializeChannelEnvelope } from './envelope'

const view = { cadetId: 'cadet_1', cadetCode: 'C-4F7K', fullName: 'Jordan Rivera', sizes: { 'PT Shorts': 'M' }, have: [{ itemId: 'item_1', label: 'PT Shorts', size: 'M', quantity: 2, issuedAt: '2026-09-01T10:00:00.000Z' }], stillNeeded: [{ label: 'Combination Cover', size: '7 1/4', quantity: 1 }], version: 5, updatedAt: '2026-09-03T00:00:00.000Z' }
const epochKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
async function channel() { const hex = newChannelKey(); return { hex, key: await importChannelKey(hex), address: channelAddress(hex) } }

describe('sealing to a cadet channel (envelope v3, ADR 013)', () => {
  it('makes a fresh 32-byte channel key each time, as 64 hex characters', () => {
    const [a, b] = [newChannelKey(), newChannelKey()]
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(b).toMatch(/^[0-9a-f]{64}$/); expect(a).not.toBe(b)
  })

  it('round-trips a cadet record under the channel key, with only the v3 header in the clear', async () => {
    const mine = await channel()
    const envelope = await sealToChannel({ channelId: mine.address, key: mine.key, kind: 'view', plaintext: view })
    expect(Object.keys(envelope).sort()).toEqual([...PUBLIC_CHANNEL_ENVELOPE_FIELDS].sort())
    expect(envelope).toMatchObject({ v: 3, ch: mine.address, kind: 'view' })
    const wire = new TextDecoder().decode(serializeChannelEnvelope(envelope))
    for (const secret of ['Jordan', 'Rivera', 'C-4F7K', 'cadet_1', 'PT Shorts', 'Combination']) expect(wire).not.toContain(secret)
    const opened = await openFromChannel(deserializeChannelEnvelope(serializeChannelEnvelope(envelope)), mine.key, mine.address)
    expect(opened).toEqual({ kind: 'view', plaintext: view })
  })

  it('cannot be opened under another cadet’s key or under a unit epoch key', async () => {
    const [mine, theirs] = [await channel(), await channel()]
    const envelope = await sealToChannel({ channelId: mine.address, key: mine.key, kind: 'view', plaintext: view })
    await expect(openFromChannel(envelope, theirs.key)).rejects.toThrow(/authentication failed/)
    await expect(openFromChannel(envelope, await epochKey())).rejects.toThrow(/authentication failed/)
  })

  it('binds the header: a record moved to another channel, relabelled or with a changed flag does not open', async () => {
    const mine = await channel(), other = await channel()
    const envelope = await sealToChannel({ channelId: mine.address, key: mine.key, kind: 'notice', plaintext: { text: 'Bring your SDBs Friday' } })
    await expect(openFromChannel({ ...envelope, ch: other.address }, mine.key)).rejects.toThrow(/authentication failed/)
    await expect(openFromChannel({ ...envelope, kind: 'view' }, mine.key)).rejects.toThrow(/authentication failed/)
    await expect(openFromChannel({ ...envelope, z: envelope.z ? 0 : 1 }, mine.key)).rejects.toThrow(/authentication failed/)
    await expect(openFromChannel(envelope, mine.key, other.address)).rejects.toThrow(/another channel/)
  })

  it('refuses a payload that would not fit the 60 KB record cap', async () => {
    const mine = await channel(), noise = bytesToBase64(crypto.getRandomValues(new Uint8Array(48 * 1024)))
    await expect(sealToChannel({ channelId: mine.address, key: mine.key, kind: 'view', plaintext: { noise } })).rejects.toThrow(/too large/)
  })

  it('reads only well-formed v3 envelopes', async () => {
    const mine = await channel()
    const envelope = await sealToChannel({ channelId: mine.address, key: mine.key, kind: 'view', plaintext: view })
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
    expect(() => deserializeChannelEnvelope(bytes({ ...envelope, v: 2 }))).toThrow(/Unsupported/)
    expect(() => deserializeChannelEnvelope(bytes({ ...envelope, kind: 'event' }))).toThrow(/kind/)
    expect(() => deserializeChannelEnvelope(bytes({ ...envelope, ch: '' }))).toThrow(/ch/)
    expect(() => deserializeChannelEnvelope(bytes({ ...envelope, extra: 1 }))).toThrow(/Unsupported/)
    await expect(sealToChannel({ channelId: '', key: mine.key, kind: 'view', plaintext: view })).rejects.toThrow(/channel/)
  })

  it('leaves the unit envelope (v2) as it was: one sealed under the epoch key still opens', async () => {
    const key = await epochKey(), identity = new MockIdentityProvider('officer')
    const unsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: 'unit-a', eventVersion: 1 as const, eventId: 'e-1', eventType: 'INVENTORY_RECEIVED' as const, entityId: 'item_1', actorPublicIdentity: await identity.getPublicIdentity(), timestamp: '2026-10-03T12:00:00.000Z', clock: 1, payload: { quantity: 3 } }
    const event = { ...unsigned, signature: await identity.sign(canonicalize(unsigned)) } as SignedArgusEvent
    const envelope = await sealEnvelope({ unitId: 'unit-a', epochId: 'e1', key, plaintext: { event } })
    expect(envelope.v).toBe(2)
    expect((await openEnvelope(envelope, async () => key)).event).toEqual(event)
    // A channel key cannot open a unit record either.
    await expect(openEnvelope(envelope, async () => (await channel()).key)).rejects.toThrow(/authentication failed/)
  })
})
