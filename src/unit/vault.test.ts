import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { DEFAULT_WALLET_DB_NAME, IndexedDbWalletStateStore } from '../chain/walletStore'
import { IndexedDbLedgerStore } from './ledgerStore'
import type { SignedArgusEvent } from '../distributed/types'
import { canonicalize } from '../distributed/canonical'
import { PUBLIC_ENVELOPE_FIELDS, openEnvelope, sealEnvelope, serializeEnvelope } from './envelope'
import * as vault from './vault'
import { DEVICE_VAULT_STORAGE_KEY, createMasterDevice, forgetDevice, loadDeviceVault, unlockDevice } from './vault'

const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, values } }
const PASS = 'supply closet 42'

async function signedEvent(device: Awaited<ReturnType<typeof createMasterDevice>>, payload: Record<string, unknown>): Promise<SignedArgusEvent> {
  const event = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: device.record.unit!.unitId, eventVersion: 1 as const, eventId: crypto.randomUUID(), eventType: 'CADET_CREATED' as const, entityId: 'cadet_x', actorPublicIdentity: device.record.signingIdentity, timestamp: '2026-09-27T12:00:00.000Z', clock: 1, payload }
  return { ...event, signature: await device.identity.sign(canonicalize(event)) }
}

describe('device vault and admission', { timeout: 60_000 }, () => {
  it('creates a Master device holding its own keys, a unit, and a self-issued MASTER credential — all sealed under one passphrase', async () => {
    const storage = memoryStorage()
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, storage)
    expect(master.record.role).toBe('MASTER')
    expect(master.record.unit).toMatchObject({ unitName: 'Bethel NJROTC', currentEpoch: 'e1', epochs: ['e1'] })
    expect(master.record.walletAddress).toMatch(/^[mn]/)
    expect(master.unitKeys.get('e1')).toBeDefined()
    const stored = storage.values.get(DEVICE_VAULT_STORAGE_KEY)!
    // No WIF, JWK private component or raw unit key is ever stored in the clear.
    expect(stored).not.toContain(master.walletWif)
    expect(stored).not.toMatch(/"d":"/)
    await expect(unlockDevice(loadDeviceVault(storage)!, 'wrong passphrase 1')).rejects.toThrow(/not correct/)
    const again = await unlockDevice(loadDeviceVault(storage)!, PASS)
    expect(again.walletWif).toBe(master.walletWif)
    expect(await again.identity.getPublicIdentity()).toBe(master.record.signingIdentity)
  })

  it('has no join code or admission code any more: a new person joins only by a ticket (D7)', () => {
    for (const gone of ['acceptAdmission', 'admitMember', 'encodeJoinRequest', 'decodeJoinRequest']) expect(vault).not.toHaveProperty(gone)
  })
})

describe('encrypted envelope', { timeout: 60_000 }, () => {
  it('puts nothing but the declared public fields on chain; names, actor and event type stay inside ciphertext', async () => {
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, memoryStorage())
    const event = await signedEvent(master, { fullName: 'Private Cadet Name', gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', sizes: { 'PT Shorts': 'M' }, cadetCode: 'C-7K2Q' })
    const envelope = await sealEnvelope({ unitId: master.record.unit!.unitId, epochId: 'e1', key: master.unitKeys.get('e1')!, plaintext: { event } })
    const onChain = new TextDecoder().decode(serializeEnvelope(envelope))
    expect(Object.keys(JSON.parse(onChain)).sort()).toEqual([...PUBLIC_ENVELOPE_FIELDS].sort())
    for (const secret of ['Private Cadet Name', 'CADET_CREATED', 'C-7K2Q', master.record.signingIdentity, 'Female', 'PT Shorts', '2026-09-27']) expect(onChain).not.toContain(secret)
    // Tampering with the public header or ciphertext is detected.
    await expect(openEnvelope({ ...envelope, eventId: crypto.randomUUID() }, async () => master.unitKeys.get('e1'))).rejects.toThrow(/authentication failed/)
    await expect(openEnvelope({ ...envelope, epoch: 'e2' }, async () => undefined)).rejects.toThrow(/NO_EPOCH_KEY/)
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await expect(openEnvelope(envelope, async () => other)).rejects.toThrow(/authentication failed/)
  })

  it('"Erase this device" also deletes the local ledger and wallet databases (minor 9)', async () => {
    const storage = memoryStorage(), factory = new IDBFactory()
    const master = await createMasterDevice({ passphrase: PASS, displayName: 'Luke', unitName: 'Bethel NJROTC' }, storage)
    const unitId = master.record.unit!.unitId
    // Open connections, as a device that was just locked still has them.
    const ledger = new IndexedDbLedgerStore(unitId, factory)
    await ledger.addEnvelope({ eventId: 'a', envelope: { v: 2, unit: unitId, epoch: 'e1', eventId: 'a', z: 0, nonce: 'bm9uY2U=', ct: 'Y2lwaGVy' }, origin: 'local', status: 'QUEUED', addedAt: '2026-09-27T00:00:00.000Z' })
    await new IndexedDbWalletStateStore(DEFAULT_WALLET_DB_NAME, factory).save({ version: 1, address: master.record.walletAddress, coins: [], pending: [], recent: [] } as never)
    const names = async () => (await factory.databases()).map(database => database.name).sort()
    expect(await names()).toEqual([DEFAULT_WALLET_DB_NAME, IndexedDbLedgerStore.databaseName(unitId)].sort())

    await forgetDevice(storage, factory)
    expect(storage.values.has(DEVICE_VAULT_STORAGE_KEY)).toBe(false)
    expect(await names()).toEqual([])
    // Nothing of the erased unit comes back when a store is opened again.
    expect(await new IndexedDbLedgerStore(unitId, factory).envelopes()).toEqual([])
  })
})

describe('a cadet phone keeps its notices sealed (mw-kmgi38.6)', { timeout: 60_000 }, () => {
  const cadet = { cadetId: 'cad-1', displayName: 'Avery Private', unit: { unitId: 'u-1', unitName: 'Bethel NJROTC' }, channelKey: 'k', channelAddress: 'a', noticesKey: 'n', noticesAddress: 'na', joinedAt: '2026-10-03T00:00:00.000Z' }
  it('round-trips through a reload, is unreadable in storage, and a damaged entry reads as none', async () => {
    const storage = memoryStorage(), device = await vault.completeCadetRedemption(await vault.createCadetVault(PASS, storage), cadet, storage)
    expect(await vault.loadCadetNotices(device)).toEqual([])
    const notices = [{ noticeId: 'n1', text: 'Military ball: bring your SDBs', from: 'Chief', sentAt: '2026-10-03T12:00:00.000Z', readAt: '2026-10-03T13:00:00.000Z' }, { noticeId: 'n2', text: 'Thursday', from: 'Chief', sentAt: '2026-10-03T14:00:00.000Z' }]
    await vault.saveCadetNotices(device, notices, storage)
    expect(storage.getItem(vault.CADET_VAULT_STORAGE_KEY)).not.toContain('Military ball')
    const again = await vault.unlockCadetDevice(vault.loadCadetVault(storage)!, PASS)
    expect(await vault.loadCadetNotices(again)).toEqual(notices)
    expect(again.cadet).toEqual(cadet)
    // Sealed under another name (the redemption's), it does not open as notices.
    again.record = { ...again.record, secrets: { ...again.record.secrets, notices: again.record.secrets.cadet } }
    expect(await vault.loadCadetNotices(again)).toEqual([])
  })
})
