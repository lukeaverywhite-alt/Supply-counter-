import { describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS } from '../auth/authorization'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { canonicalize } from '../distributed/canonical'
import type { ArgusPermission, ArgusRole } from '../distributed/types'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice, restoreFromRecoveryFile, type UnlockedDevice } from './vault'

/** WhatsOnChain unreachable: a device opened now works from its own copy and publishes later. */
class UnreachableChain extends FakeChain {
  down = false
  private check() { if (this.down) throw new Error('Could not reach WhatsOnChain after 3 tries.') }
  override async unspent(...args: Parameters<FakeChain['unspent']>) { this.check(); return super.unspent(...args) }
  override async txHex(...args: Parameters<FakeChain['txHex']>) { this.check(); return super.txHex(...args) }
  override async confirmedHistory(...args: Parameters<FakeChain['confirmedHistory']>) { this.check(); return super.confirmedHistory(...args) }
  override async unconfirmedHistory(...args: Parameters<FakeChain['unconfirmedHistory']>) { this.check(); return super.unconfirmedHistory(...args) }
  override async broadcast(...args: Parameters<FakeChain['broadcast']>) { this.check(); return super.broadcast(...args) }
  override async tipHeight() { this.check(); return super.tipHeight() }
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** One device: what survives the app being closed and opened again (its record, its encrypted ledger, its wallet state). */
type Device = { device: UnlockedDevice; store: Store; ledger: MemoryLedgerStore; walletStore: MemoryWalletStateStore; runtime: UnitRuntime }
const open = async (device: UnlockedDevice, chain: FakeChain, store: Store, ledger = new MemoryLedgerStore(), walletStore = new MemoryWalletStateStore()): Promise<Device> =>
  ({ device, store, ledger, walletStore, runtime: await UnitRuntime.open(device, { api: chain, ledger, walletStore, storage: store }) })
/** The app is closed and opened again (after the update that brought the cadet epic). */
const reopen = (chain: FakeChain, device: Device) => open(device.device, chain, device.store, device.ledger, device.walletStore)
const syncAll = async (chain: FakeChain, ...devices: Device[]) => { for (const device of devices) await device.runtime.syncNow(); chain.mine(); for (const device of devices) await device.runtime.syncNow() }
const identity = (device: Device) => device.device.record.signingIdentity
const sorted = (role: ArgusRole) => [...ROLE_PERMISSIONS[role]].sort()
const roleChanges = async (device: Device) => (await device.runtime.controller.project()).events.filter(record => record.event.eventType === 'ROLE_CHANGED').length

const CADET_EPIC: readonly ArgusPermission[] = ['cadets.admit', 'notices.send']
/** Runs `work` with the role permissions as they were before the cadet epic (mw-kmgi38.1): no cadets.admit, no notices.send. */
async function beforeTheCadetEpic<T>(work: () => Promise<T>): Promise<T> {
  const current = { ...ROLE_PERMISSIONS }
  for (const role of Object.keys(current) as ArgusRole[]) ROLE_PERMISSIONS[role] = current[role].filter(permission => !CADET_EPIC.includes(permission))
  try { return await work() } finally { Object.assign(ROLE_PERMISSIONS, current) }
}

/**
 * A unit made before the cadet epic: the Master who made it (A), an officer made Instructor by a role change (B), an officer made
 * Supply Assistant by a role change (C), an Instructor admitted by ticket (D), one cadet, and, when asked, a second Master device
 * restored from a recovery file (R). Every credential was signed with the permission lists of the time.
 */
async function unitFromBeforeTheCadetEpic(options: { restoredMaster?: boolean } = {}) {
  const chain = new UnreachableChain()
  return beforeTheCadetEpic(async () => {
    const aStore = memoryStorage(), masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, aStore)
    chain.fund(masterDevice.record.walletAddress, 400_000, { confirmed: true })
    const a = await open(masterDevice, chain, aStore)
    const cadetId = (await a.runtime.controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Avery Private' })).cadets[0].cadetId
    await a.runtime.syncNow(); chain.mine()
    const joined = async (name: string, role: ArgusRole): Promise<Device> => { const { device, runtime, store, ledger } = await joinByTicket(a.runtime, chain, name, role); return { device, runtime, store, ledger, walletStore: new MemoryWalletStateStore() } }
    const b = await joined('Officer B', 'SUPPLY_OFFICER'), c = await joined('Officer C', 'SUPPLY_OFFICER'), d = await joined('Instructor D', 'INSTRUCTOR')
    await a.runtime.changeRole(identity(b), 'INSTRUCTOR')
    await a.runtime.changeRole(identity(c), 'SUPPLY_ASSISTANT')
    let r: Device | undefined
    if (options.restoredMaster) {
      const fileText = await a.runtime.exportRecovery('recovery phrase 2026'), rStore = memoryStorage()
      const restored = await restoreFromRecoveryFile({ fileText, recoveryPassphrase: 'recovery phrase 2026', passphrase: 'new device pass 1', displayName: 'Chief (second phone)' }, rStore)
      chain.fund(restored.record.walletAddress, 100_000, { confirmed: true })
      r = await open(restored, chain, rStore)
    }
    await syncAll(chain, a, b, c, d, ...(r ? [r] : []))
    await syncAll(chain, a, b, c, d, ...(r ? [r] : []))
    for (const device of [a, b, c, ...(r ? [r] : [])]) expect(device.device.record.credential!.permissions).not.toContain('cadets.admit')
    expect(b.device.record.role).toBe('INSTRUCTOR')
    expect(c.device.record.role).toBe('SUPPLY_ASSISTANT')
    return { chain, a, b, c, d, r, cadetId }
  })
}

describe('a unit made before the cadet epic gains the cadet permissions (mw-kmgi38.11)', { timeout: 240_000 }, () => {
  it('the Master re-issues its own credential on open, records it, and it verifies on another replica; cadet channels and the notices key then work', async () => {
    const { chain, a: before, b, cadetId } = await unitFromBeforeTheCadetEpic()
    const authority = before.device.record.unit!.authorityIdentity, old = before.device.record.credential!
    const a = await reopen(chain, before)
    const credential = a.device.record.credential!
    expect(credential).toMatchObject({ role: 'MASTER', subjectPublicIdentity: identity(a), issuedBy: authority, issuedAt: old.issuedAt })
    expect(credential.credentialId).not.toBe(old.credentialId)
    expect(credential.permissions).toEqual(sorted('MASTER'))
    // Recorded in the unit log: a role change to the same role, which replaces the old credential.
    const recorded = (await a.runtime.controller.project()).events.filter(record => record.event.eventType === 'ROLE_CHANGED' && record.event.entityId === identity(a))
    expect(recorded.map(record => canonicalize(record.event.payload.credential))).toEqual([canonicalize(credential)])
    expect(recorded[0].event.payload.revocation).toMatchObject({ credentialId: old.credentialId, issuedBy: authority })

    await a.runtime.controller.createCadetChannel(cadetId)
    await a.runtime.controller.createNoticesKey()
    await a.runtime.syncNow(); chain.mine()

    // Another replica, rebuilt from the chain alone, verifies the re-issue under authority -> device and accepts what it allowed.
    const replica = await UnitRuntime.open(b.device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    const seen = await replica.syncNow()
    expect(replica.authorization.hasCredential(credential.credentialId)).toBe(true)
    expect(seen.members.find(member => member.publicIdentity === identity(a))).toMatchObject({ role: 'MASTER', credentialId: credential.credentialId, status: 'ACTIVE' })
    expect(seen.rejected).toEqual([])
    const state = await replica.controller.technicalState()
    expect(state.cadetChannels.map(channel => channel.cadetId)).toEqual([cadetId])
    expect(state.noticesChannel?.createdBy).toBe(identity(a))
  })

  it('staff admitted or moved directly before the epic gain exactly their role’s current permissions; a ticket member’s record is brought up to date', async () => {
    const { chain, a: aBefore, b: bBefore, c: cBefore, d: dBefore, cadetId } = await unitFromBeforeTheCadetEpic()
    const a = await reopen(chain, aBefore)
    await syncAll(chain, a)
    const [b, c, d] = [await reopen(chain, bBefore), await reopen(chain, cBefore), await reopen(chain, dBefore)]
    await syncAll(chain, b, c, d)

    expect(b.device.record).toMatchObject({ role: 'INSTRUCTOR', credential: { role: 'INSTRUCTOR', permissions: sorted('INSTRUCTOR') } })
    expect(c.device.record).toMatchObject({ role: 'SUPPLY_ASSISTANT', credential: { role: 'SUPPLY_ASSISTANT', permissions: sorted('SUPPLY_ASSISTANT') } })
    expect(c.device.record.credential!.permissions).not.toContain('cadets.admit')
    await expect(c.runtime.controller.createCadetChannel(cadetId)).rejects.toThrow(/Unauthorized: cadets\.admit is required/)
    await expect(c.runtime.controller.createNoticesKey()).rejects.toThrow(/Unauthorized: notices\.send is required/)
    await b.runtime.controller.createCadetChannel(cadetId)

    // A ticket credential stands on its proof, so nobody re-issues it; the device's own copy is simply derived again.
    expect(d.device.record.credential!.permissions).toEqual(sorted('INSTRUCTOR'))
    expect((await a.runtime.controller.project()).events.some(record => record.event.eventType === 'ROLE_CHANGED' && record.event.entityId === identity(d))).toBe(false)
    // So a fresh device checking a ticket D makes accepts D's chain (it used to compare D's old copy with its proof and refuse).
    const e = await joinByTicket(d.runtime, chain, 'Assistant E', 'SUPPLY_ASSISTANT', { satoshis: 500 })
    expect(e.device.record.role).toBe('SUPPLY_ASSISTANT')

    await syncAll(chain, a, b, c, d)
    for (const device of [a, b, c, d]) {
      const projection = await device.runtime.controller.project()
      expect(projection.rejected).toEqual([])
      expect(projection.members.filter(member => member.status === 'ACTIVE').map(member => `${member.displayName}:${member.role}`).sort()).toEqual(['Assistant E:SUPPLY_ASSISTANT', 'Chief:MASTER', 'Instructor D:INSTRUCTOR', 'Officer B:INSTRUCTOR', 'Officer C:SUPPLY_ASSISTANT'])
    }
  })

  it('opening again records no second re-issue', async () => {
    const { chain, a: before } = await unitFromBeforeTheCadetEpic()
    const changesBefore = await roleChanges(before)
    let a = await reopen(chain, before)
    await syncAll(chain, a)
    // The Master's own credential and B's (a Supply Assistant's list did not change, so C's stands).
    const once = await roleChanges(a)
    expect(once).toBe(changesBefore + 2)
    const credential = a.device.record.credential
    for (let time = 0; time < 2; time++) { a = await reopen(chain, a); await syncAll(chain, a) }
    expect(await roleChanges(a)).toBe(once)
    expect(a.device.record.credential).toEqual(credential)
  })

  it('two Master devices re-issuing at once while offline converge on one replacement per credential', async () => {
    const { chain, a: aBefore, r: rBefore, b: bBefore, c: cBefore, cadetId } = await unitFromBeforeTheCadetEpic({ restoredMaster: true })
    const changesBefore = await roleChanges(aBefore)
    chain.down = true
    const a = await reopen(chain, aBefore), r = await reopen(chain, rBefore!)
    // Each re-issued A, R and B on its own, unseen by the other.
    expect(await roleChanges(a)).toBe(changesBefore + 3)
    expect(await roleChanges(r)).toBe(changesBefore + 3)
    chain.down = false
    const b = await reopen(chain, bBefore), c = await reopen(chain, cBefore)
    await syncAll(chain, a, r, b, c)
    await syncAll(chain, a, r, b, c)

    const projections = await Promise.all([a, r, b, c].map(device => device.runtime.controller.project()))
    for (const projection of projections) {
      expect(projection.rejected).toEqual([])
      expect(canonicalize(projection.members)).toBe(canonicalize(projections[0].members))
    }
    // Both made the same replacement of each credential: the second copy of each changes nothing.
    expect(await roleChanges(a)).toBe(changesBefore + 6)
    for (const [device, role] of [[a, 'MASTER'], [r, 'MASTER'], [b, 'INSTRUCTOR'], [c, 'SUPPLY_ASSISTANT']] as const) {
      const member = projections[0].members.find(entry => entry.publicIdentity === identity(device))!
      expect(device.device.record.credential).toMatchObject({ credentialId: member.credentialId, permissions: sorted(role) })
      for (const other of [a, r, b, c]) expect(other.runtime.authorization.credentialFor(identity(device), new Date().toISOString())?.permissions).toEqual(sorted(role))
    }
    await r.runtime.controller.createCadetChannel(cadetId)
    await a.runtime.controller.createNoticesKey()
    await syncAll(chain, a, r, b, c)
    for (const device of [a, r, b, c]) {
      const state = await device.runtime.controller.technicalState()
      expect([state.cadetChannels.length, Boolean(state.noticesChannel)]).toEqual([1, true])
      expect((await device.runtime.controller.project()).rejected).toEqual([])
    }
  })
})
