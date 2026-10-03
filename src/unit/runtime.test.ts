import { describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { GENESIS_CATALOG } from '../stage3/domain'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { joinByTicket } from '../test/joinByTicket'
import { createMasterDevice, type UnlockedDevice } from './vault'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } } }
const open = (device: UnlockedDevice, chain: FakeChain, ledger = new MemoryLedgerStore()) => UnitRuntime.open(device, { api: chain, ledger, walletStore: new MemoryWalletStateStore(), storage: storage() })

async function unitWithMembers(chain: FakeChain) {
  const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, storage())
  chain.fund(masterDevice.record.walletAddress, 200_000, { confirmed: true })
  const master = await open(masterDevice, chain)
  const joiners = [] as UnitRuntime[]
  for (const name of ['Officer B', 'Assistant C']) joiners.push((await joinByTicket(master, chain, name, name.startsWith('Officer') ? 'SUPPLY_OFFICER' : 'SUPPLY_ASSISTANT')).runtime)
  await master.syncNow(); chain.mine()
  return { master, joiners, masterDevice }
}

describe('unit runtime over a (fake) BSV testnet chain', { timeout: 120_000 }, () => {
  it('A counts 3 PT Shorts, B counts 3 PT Shorts: every device — including one that only reads the chain — shows 6, and finalizing sets on-hand to 6', async () => {
    const chain = new FakeChain()
    const { master: a, joiners: [b, c] } = await unitWithMembers(chain)
    // Every member learns every other member from the chain.
    await b.syncNow(); await c.syncNow()
    expect((await b.controller.project()).members.map(member => member.displayName).sort()).toEqual(['Assistant C', 'Chief', 'Officer B'])

    // The officer sets up sizes and opens a shared count; everyone sees it.
    await a.controller.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'])
    let projection = await a.controller.createCountSession({ sessionId: 'fall-2026', scope: 'Fall inventory' })
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
    await a.syncNow(); chain.mine(); await b.syncNow()

    // A and B count at the same time.
    await a.controller.contributeCount('fall-2026', { itemId: medium }, 3, 'Shelf A')
    await b.controller.contributeCount('fall-2026', { itemId: medium }, 3, 'Shelf B')
    await a.syncNow(); await b.syncNow() // both publish; mempool-only, not yet mined
    await a.syncNow(); await b.syncNow() // each discovers the other's transaction on the anchor history
    for (const runtime of [a, b]) expect((await runtime.controller.project()).countSessions[0].totals[medium]).toBe(6)

    // C only ever reads the chain.
    await c.syncNow()
    expect((await c.controller.project()).countSessions[0].totals[medium]).toBe(6)

    // Officer finalizes; on-hand becomes 6 on every device.
    await a.controller.finalizeCountSession('fall-2026')
    await a.syncNow(); chain.mine()
    for (const runtime of [b, c]) await runtime.syncNow()
    for (const runtime of [a, b, c]) {
      projection = await runtime.controller.project()
      expect(projection.inventory.find(item => item.entityId === medium)?.onHand).toBe(6)
      expect(projection.countSessions[0].status).toBe('RECONCILED')
      expect(projection.events.filter(record => record.syncStatus !== 'SYNCHRONIZED')).toEqual([])
      // Every change links to the transaction that carried it, including other people's changes.
      expect(projection.events.filter(record => !record.transactionId).map(record => record.event.eventType)).toEqual([])
    }
    const countTxids = (records: typeof projection.events) => records.filter(record => record.event.eventType === 'COUNT_CONTRIBUTED').map(record => record.transactionId).sort()
    expect(countTxids((await a.controller.project()).events)).toEqual(countTxids((await b.controller.project()).events))
    // An assistant may count but may not finalize.
    await expect(c.controller.finalizeCountSession('fall-2026')).rejects.toThrow()
  })

  it('a brand-new device of an existing member rebuilds the full unit state from the chain alone', async () => {
    const chain = new FakeChain()
    const { master: a, joiners: [b] } = await unitWithMembers(chain)
    await a.controller.addCatalogSizes(PT_SHORTS, ['M'])
    const medium = (await a.controller.project()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await a.controller.receiveStock(medium, 12, 'Shipment')
    const cadet = (await a.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Name Kept Private' })).cadets[0]
    await a.controller.issueTransaction({ transactionId: 'tx-1', cadetId: cadet.cadetId, lines: [{ lineId: 'l1', itemId: medium, quantity: 2 }] })
    await a.syncNow(); chain.mine()
    const expected = await a.controller.project()
    // B's device opens with an empty local ledger: everything comes from the chain.
    const fresh = await UnitRuntime.open(b.device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() })
    const rebuilt = await fresh.syncNow()
    expect(rebuilt.inventory.find(item => item.entityId === medium)).toMatchObject({ onHand: 10, issued: 2 })
    expect(rebuilt.cadets.map(entry => ({ code: entry.cadetCode, name: entry.fullName, property: entry.propertyCount }))).toEqual(expected.cadets.map(entry => ({ code: entry.cadetCode, name: entry.fullName, property: entry.propertyCount })))
    // Nothing on chain reveals the cadet's name, code, or the item.
    const onChain = chain.transactions().map(tx => tx.hex).join('')
    for (const secret of ['Name Kept Private', cadet.cadetCode!, 'PT Shorts', 'Shipment'].map(text => Buffer.from(text).toString('hex'))) expect(onChain).not.toContain(secret)
  })

  it('reports that a device needs testnet coins instead of losing work, and publishes once funded', async () => {
    const chain = new FakeChain()
    const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    const master = await open(masterDevice, chain)
    await master.controller.receiveStock((await master.controller.project()).inventory[0].entityId, 3)
    await master.syncNow() // first chain scan: the Master then introduces itself (after the scan, so it never duplicates one already on chain)
    await master.syncNow()
    expect(master.status().needsFunding?.address).toBe(masterDevice.record.walletAddress)
    expect(master.status().queued).toBe(2) // the stock receipt and the Master introducing itself
    chain.fund(masterDevice.record.walletAddress, 10_000)
    await master.syncNow()
    expect(master.status()).toMatchObject({ queued: 0, needsFunding: undefined })
  })
})

describe('chain hygiene', { timeout: 120_000 }, () => {
  it('ignores forged records that reuse a real event ID (even when mined first) and foreign payments to the anchor', async () => {
    const { DeviceWallet } = await import('../chain/wallet')
    const { serializeEnvelope } = await import('./envelope')
    const chain = new FakeChain()
    const { master: a, joiners: [b] } = await unitWithMembers(chain)
    await a.controller.addCatalogSizes(PT_SHORTS, ['M'])
    await a.syncNow(); chain.mine()
    const medium = (await a.controller.project()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    // A's broadcast is lost in transit (ambiguous): the real record waits in A's wallet.
    chain.failNextBroadcasts('ambiguous', 50)
    const received = await a.controller.receiveStock(medium, 7)
    await a.syncNow()
    const realEvent = received.events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    // An outsider (no unit key) sees the public event ID and gets a garbage envelope with that ID mined FIRST.
    const outsider = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(outsider.address, 10_000, { confirmed: true })
    chain.clearInjectedFailures()
    expect((await a.wallet.pending()).length).toBeGreaterThan(0)
    const forged = { v: 2 as const, unit: a.device.record.unit!.unitId, epoch: 'e1', eventId: realEvent.eventId, z: 0 as const, nonce: 'AAAAAAAAAAAAAAAA', ct: btoa('forged forged forged') }
    await outsider.prepareRecords([{ kind: 'E', payload: serializeEnvelope(forged) }], a.transport.anchorAddress, ['forged'])
    await outsider.prepareTransfer(a.transport.anchorAddress, 5) // a plain payment to the anchor, no records at all
    const outsiderFlush = await outsider.flush()
    expect(outsiderFlush.stillPending).toEqual([]) // the injected failures were consumed by A; the outsider's txs are on chain
    const forgedHeight = chain.mine()
    // A's rebroadcast now succeeds, in a later block.
    await a.syncNow()
    const realHeight = chain.mine()
    expect(realHeight).toBeGreaterThan(forgedHeight)
    await b.syncNow()
    const view = await b.controller.project()
    expect(view.inventory.find(item => item.entityId === medium)?.onHand).toBe(7)
    expect(view.rejected).toEqual([])
  })

  it('a member cannot suppress another member’s record by publishing a different record under its event ID', async () => {
    const { canonicalize } = await import('../distributed/canonical')
    const { sealEnvelope, serializeEnvelope } = await import('./envelope')
    const chain = new FakeChain()
    const { master: a, joiners: [b, c] } = await unitWithMembers(chain)
    await a.controller.addCatalogSizes(PT_SHORTS, ['M'])
    await a.syncNow(); chain.mine(); await b.syncNow(); await c.syncNow()
    const medium = (await a.controller.project()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    chain.failNextBroadcasts('ambiguous', 50)
    const received = await a.controller.receiveStock(medium, 7)
    await a.syncNow()
    const real = received.events.find(record => record.event.eventType === 'INVENTORY_RECEIVED')!.event
    chain.clearInjectedFailures()
    // Assistant C holds the unit key, signs its own record and seals it under A's public event ID; it is mined first.
    const unit = c.device.record.unit!
    const forgedUnsigned = { protocol: 'ARGUS' as const, protocolVersion: 1 as const, organizationId: unit.unitId, eventVersion: 1 as const, eventId: real.eventId, eventType: 'INVENTORY_RECEIVED' as const, entityId: medium, actorPublicIdentity: await c.device.identity.getPublicIdentity(), timestamp: new Date().toISOString(), clock: real.clock, payload: { quantity: 1 } }
    const forged = { ...forgedUnsigned, signature: await c.device.identity.sign(canonicalize(forgedUnsigned)) }
    const envelope = await sealEnvelope({ unitId: unit.unitId, epochId: unit.currentEpoch, key: c.device.unitKeys.get(unit.currentEpoch)!, plaintext: { event: forged, credential: c.device.record.credential } })
    await c.wallet.prepareRecords([{ kind: 'E', payload: serializeEnvelope(envelope) }], c.transport.anchorAddress, [real.eventId])
    expect((await c.wallet.flush()).broadcast).toHaveLength(1)
    chain.mine()
    await a.syncNow(); chain.mine() // A's real record lands one block later
    await b.syncNow()
    const view = await b.controller.project()
    expect(view.inventory.find(item => item.entityId === medium)?.onHand).toBe(7)
    expect(view.events.find(record => record.event.eventId === real.eventId)?.event.actorPublicIdentity).toBe(real.actorPublicIdentity)
  })

  it('refuses a record too large to ever publish before it changes anything, and later commands are unaffected', async () => {
    const chain = new FakeChain()
    const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Unit' }, storage())
    chain.fund(masterDevice.record.walletAddress, 50_000, { confirmed: true })
    const master = await open(masterDevice, chain)
    await master.syncNow(); chain.mine()
    const sizes = Object.fromEntries(GENESIS_CATALOG.slice(0, 12).map(item => [item.catalogId, 'XL']))
    // Random names do not compress, so this roster cannot fit in one record.
    const rows = Array.from({ length: 200 }, () => ({ gender: 'Male' as const, nsLevel: 'NS1' as const, fullName: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => String.fromCharCode(97 + (byte % 26))).join(''), sizes }))
    await expect(master.controller.importCadets(rows)).rejects.toThrow(/too large/)
    expect((await master.controller.project()).cadets).toHaveLength(0)
    const belt = (await master.controller.project()).inventory.find(item => item.name === 'Black Belt')!.entityId
    await expect(master.controller.receiveStock(belt, 3)).resolves.toBeDefined()
    expect((await master.controller.project()).inventory.find(item => item.entityId === belt)?.onHand).toBe(3)
  })

  it('catches up with everyone else the moment the app is back on screen, without waiting for the next poll', async () => {
    const chain = new FakeChain()
    const { master: a, joiners: [b] } = await unitWithMembers(chain)
    await b.syncNow()
    a.start(3_600_000) // the poll never fires during this test
    await a.syncNow()
    await b.controller.addCatalogSizes(PT_SHORTS, ['S'])
    await b.syncNow()
    const hasSmall = async () => (await a.controller.project()).inventory.some(item => item.catalogId === PT_SHORTS && item.variant === 'S')
    expect(await hasSmall()).toBe(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(async () => expect(await hasSmall()).toBe(true))
    a.stop()
  })
})
