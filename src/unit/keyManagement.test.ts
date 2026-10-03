import { describe, expect, it } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { GENESIS_CATALOG } from '../stage3/domain'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { joinByTicket } from '../test/joinByTicket'
import { createMasterDevice, restoreFromRecoveryFile, type UnlockedDevice } from './vault'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const GOLD_SHIRT = GENESIS_CATALOG.find(item => item.name === 'Gold PT Shirt')!.catalogId
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
type Device = { runtime: UnitRuntime; store: ReturnType<typeof storage>; ledger: MemoryLedgerStore }
const open = async (device: UnlockedDevice, chain: FakeChain, store: ReturnType<typeof storage>, ledger = new MemoryLedgerStore()): Promise<Device> => ({ runtime: await UnitRuntime.open(device, { api: chain, ledger, walletStore: new MemoryWalletStateStore(), storage: store }), store, ledger })
const sizesOf = async (device: Device, catalogId: string) => (await device.runtime.controller.project()).inventory.filter(item => item.catalogId === catalogId).map(item => item.variant).sort()

async function join(issuer: UnitRuntime, chain: FakeChain, name: string, role: Parameters<UnitRuntime['issueTicket']>[1]): Promise<Device> {
  const { runtime, store, ledger } = await joinByTicket(issuer, chain, name, role)
  return { runtime, store, ledger }
}
async function unit() {
  const chain = new FakeChain(), store = storage()
  const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, store)
  chain.fund(masterDevice.record.walletAddress, 400_000, { confirmed: true })
  const a = await open(masterDevice, chain, store)
  const b = await join(a.runtime, chain, 'Officer B', 'SUPPLY_OFFICER')
  const c = await join(a.runtime, chain, 'Assistant C', 'SUPPLY_ASSISTANT')
  await a.runtime.syncNow(); chain.mine()
  for (const device of [b, c]) await device.runtime.syncNow()
  return { chain, a, b, c }
}
const syncAll = async (chain: FakeChain, ...devices: Device[]) => { for (const device of devices) await device.runtime.syncNow(); chain.mine(); for (const device of devices) await device.runtime.syncNow() }

describe('unit key management over a (fake) BSV testnet chain', { timeout: 180_000 }, () => {
  it('removing a member hands a new unit key to everyone else, so the removed member cannot read anything written afterwards', async () => {
    const { chain, a, b, c } = await unit()
    const before = c.runtime.status().currentEpoch
    const removed = await a.runtime.revoke(c.runtime.device.record.signingIdentity)
    expect(removed.rotation.recipients).toBe(2)
    expect(removed.rotation.missing).toEqual([])
    await syncAll(chain, a, b, c)
    expect(b.runtime.status().currentEpoch).toBe(removed.rotation.epochId)
    expect(c.runtime.status().currentEpoch).toBe(before)
    expect(c.runtime.status().revoked).toBe(true)

    // Written under the new key: A and B see it, C cannot open it.
    await b.runtime.controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
    await syncAll(chain, b, a, c)
    expect(await sizesOf(a, PT_SHORTS)).toEqual(['M', 'S'])
    expect(await sizesOf(c, PT_SHORTS)).toEqual([])
    expect(c.runtime.status().unreadable).toBeGreaterThan(0)
    // And C's device refuses to record new work for C.
    await expect(c.runtime.controller.addCatalogSizes(GOLD_SHIRT, ['L'])).rejects.toThrow()

    // A device of a remaining member that rebuilds from chain alone ends in the same state.
    const rebuilt = await open(b.runtime.device, chain, b.store)
    await rebuilt.runtime.syncNow()
    const view = await rebuilt.runtime.controller.project()
    expect(view.members.find(member => member.displayName === 'Assistant C')?.status).toBe('REVOKED')
    expect(await sizesOf(rebuilt, PT_SHORTS)).toEqual(['M', 'S'])
    expect(view.keyEpochs.map(epoch => epoch.epochId)).toEqual([removed.rotation.epochId])
  })

  it('work a removed member did after removal is rejected on every device, even one that reads the removal before the member’s credential', async () => {
    const { chain, a, b, c } = await unit()
    // C is offline and does not know yet: C's device still records a count session after the removal.
    await a.runtime.revoke(c.runtime.device.record.signingIdentity)
    await new Promise(resolve => setTimeout(resolve, 5))
    await c.runtime.controller.createCountSession({ sessionId: 'after-removal', scope: 'Shelf C' })
    await syncAll(chain, a, c, b)
    for (const device of [a, b]) {
      const view = await device.runtime.controller.project()
      expect(view.countSessions.map(session => session.sessionId)).not.toContain('after-removal')
      expect(view.rejected.map(record => record.eventType)).toContain('COUNT_SESSION_CREATED')
    }
    // Replay B's ledger with the removal first: history is not delivered in causal order.
    const records = await b.ledger.envelopes(), removal = (await b.runtime.controller.project()).events.find(stored => stored.event.eventType === 'AUTHORITY_REVOKED')!.event.eventId
    const reordered = new MemoryLedgerStore()
    for (const record of [...records.filter(entry => entry.eventId === removal), ...records.filter(entry => entry.eventId !== removal).reverse()]) await reordered.addEnvelope(record)
    const replay = await open(b.runtime.device, chain, b.store, reordered)
    const view = await replay.runtime.controller.project()
    expect(view.countSessions.map(session => session.sessionId)).not.toContain('after-removal')
    expect(view.members.find(member => member.displayName === 'Assistant C')?.status).toBe('REVOKED')
  })

  it('the Master can delegate Master authority: the delegate admits and removes people, but cannot remove the original Master', async () => {
    const { chain, a, b, c } = await unit()
    await a.runtime.changeRole(b.runtime.device.record.signingIdentity, 'MASTER')
    await syncAll(chain, a, b, c)
    expect(b.runtime.device.record.role).toBe('MASTER')
    expect((await c.runtime.controller.project()).members.find(member => member.displayName === 'Officer B')?.role).toBe('MASTER')

    // B makes D's ticket with B's own key (B never holds the unit authority key).
    expect(b.runtime.status().holdsAuthority).toBe(false)
    chain.fund(b.runtime.device.record.walletAddress, 50_000, { confirmed: true })
    const d = await join(b.runtime, chain, 'Assistant D', 'SUPPLY_ASSISTANT')
    await syncAll(chain, b, d)
    await d.runtime.controller.createCountSession({ sessionId: 'd-count', scope: 'Shelf D' })
    await syncAll(chain, d, a, c)
    for (const device of [a, c]) expect((await device.runtime.controller.project()).countSessions.map(session => session.sessionId)).toContain('d-count')

    // Only the unit authority makes or removes Masters.
    await expect(b.runtime.revoke(a.runtime.device.record.signingIdentity)).rejects.toThrow(/unit authority/)
    await expect(b.runtime.changeRole(c.runtime.device.record.signingIdentity, 'MASTER')).rejects.toThrow(/unit authority/)

    // B removes C; everyone still in the unit (including D, admitted by B) gets B's new key.
    const removed = await b.runtime.revoke(c.runtime.device.record.signingIdentity)
    expect(removed.rotation.recipients).toBe(3)
    await syncAll(chain, b, a, d, c)
    for (const device of [a, d]) expect(device.runtime.status().currentEpoch).toBe(removed.rotation.epochId)
    expect(c.runtime.status().revoked).toBe(true)
  })

  it('a role change reaches the person’s own device: a demoted officer can no longer finalize a count', async () => {
    const { chain, a, b, c } = await unit()
    await a.runtime.changeRole(b.runtime.device.record.signingIdentity, 'SUPPLY_ASSISTANT')
    await syncAll(chain, a, b, c)
    expect(b.runtime.device.record.role).toBe('SUPPLY_ASSISTANT')
    const member = (await c.runtime.controller.project()).members.find(entry => entry.displayName === 'Officer B')!
    expect(member).toMatchObject({ role: 'SUPPLY_ASSISTANT', status: 'ACTIVE' })
    await b.runtime.controller.createCountSession({ sessionId: 'after-demotion', scope: 'Shelf B' })
    await expect(b.runtime.controller.finalizeCountSession('after-demotion')).rejects.toThrow(/Unauthorized/)
  })

  it('a recovery file restores Master authority on a new device, including key generations created after the file was made', async () => {
    const { chain, a, b, c } = await unit()
    const fileText = await a.runtime.exportRecovery('recovery phrase 2026')
    expect(fileText).toMatch(/^ARGUS-RECOVERY-1:/)
    expect(fileText).not.toContain('Bethel')
    await syncAll(chain, a, b, c)
    // After the file exists: a member is removed (new key) and B writes under the new key.
    await a.runtime.revoke(c.runtime.device.record.signingIdentity)
    await syncAll(chain, a, b)
    await b.runtime.controller.addCatalogSizes(PT_SHORTS, ['L'])
    await syncAll(chain, b, a)

    await expect(restoreFromRecoveryFile({ fileText, recoveryPassphrase: 'wrong phrase 2026', passphrase: 'new device pass 1', displayName: 'Chief' }, storage())).rejects.toThrow(/not correct/)
    const store = storage()
    const restoredDevice = await restoreFromRecoveryFile({ fileText, recoveryPassphrase: 'recovery phrase 2026', passphrase: 'new device pass 1', displayName: 'Chief (new phone)' }, store)
    chain.fund(restoredDevice.record.walletAddress, 100_000, { confirmed: true })
    const r = await open(restoredDevice, chain, store)
    await r.runtime.syncNow()
    expect(await sizesOf(r, PT_SHORTS)).toEqual(['L'])
    expect(r.runtime.status().holdsAuthority).toBe(true)

    // The recovered Master removes the lost device; B follows the new key, the old Master device is out.
    const removed = await r.runtime.revoke(a.runtime.device.record.signingIdentity)
    await syncAll(chain, r, b, a)
    expect(b.runtime.status().currentEpoch).toBe(removed.rotation.epochId)
    expect(a.runtime.status().revoked).toBe(true)
    expect((await b.runtime.controller.project()).members.filter(member => member.status === 'ACTIVE').map(member => member.displayName).sort()).toEqual(['Chief (new phone)', 'Officer B'])
  })
})
