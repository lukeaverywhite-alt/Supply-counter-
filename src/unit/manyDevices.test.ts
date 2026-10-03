import { describe, expect, it } from 'vitest'
import { FakeChain, type FakeChainRequestCounts } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import { WhatsOnChainApi } from '../chain/woc'
import { canonicalize } from '../distributed/canonical'
import type { ArgusAppProjection } from '../distributed/appIntegration'
import { GENESIS_CATALOG } from '../stage3/domain'
import { fakeWocFetch } from '../test/fakeWoc'
import { joinByTicket, memoryStorage } from '../test/joinByTicket'
import { MemoryLedgerStore } from './ledgerStore'
import { UnitRuntime } from './runtime'
import { createMasterDevice } from './vault'

const catalogId = (name: string) => GENESIS_CATALOG.find(item => item.name === name)!.catalogId
const PT_SHORTS = catalogId('PT Shorts'), PT_SHIRT = catalogId('Gold PT Shirt')

const DEVICES = 20, COMMANDS_PER_DEVICE = 5, CADETS = 10
/** Measured, see docs/concurrency.md: a sync with nothing new anywhere costs a device 2 chain requests (confirmed history, mempool history); one that also publishes a command costs 5 (the broadcast and two scans). */
const REQUESTS_PER_IDLE_SCAN = 2, REQUESTS_PER_PUBLISHING_SYNC = 5, REQUESTS_PER_COMMAND = 25

/** A deterministic shuffle so a failing order can be replayed. */
const shuffle = <T,>(values: T[], seed: number) => { const copy = [...values]; let state = seed; for (let i = copy.length - 1; i > 0; i--) { state = (state * 1103515245 + 12345) % 2 ** 31; const j = state % (i + 1); [copy[i], copy[j]] = [copy[j], copy[i]] } return copy }

/** What every device must agree on: shared state, without per-device delivery bookkeeping. */
const shared = (projection: ArgusAppProjection) => canonicalize({
  inventory: projection.inventory.map(({ entityId, onHand, issued }) => ({ entityId, onHand, issued })),
  cadets: projection.cadets.map(cadet => ({ cadetId: cadet.cadetId, property: cadet.currentProperty.map(line => line.propertyId).sort() })),
  transactions: projection.transactions.map(transaction => transaction.transactionId).sort(),
  conflicts: projection.conflicts.map(({ id, status, eventIds }) => ({ id, status, eventIds })),
  members: projection.members.map(member => member.displayName).sort(),
  events: projection.events.map(record => record.event.eventId).sort(),
})

describe('twenty staff phones on one chain', { timeout: 120_000 }, () => {
  it('issue and return at the same time: every device ends with the same projection, no command is lost, and a race for the last item shows as a conflict everywhere', async () => {
    const chain = new FakeChain()
    const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(masterDevice.record.walletAddress, 2_000_000, { confirmed: true })
    const master = await UnitRuntime.open(masterDevice, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    const devices = [master]
    for (let index = 1; index < DEVICES; index++) devices.push((await joinByTicket(master, chain, `Staff ${index}`, 'SUPPLY_OFFICER', { passphrase: `staff pass ${index}` })).runtime)

    // The Master stocks the closet and enrolls ten cadets; then everyone catches up.
    await master.controller.addCatalogSizes(PT_SHORTS, ['M']); await master.controller.addCatalogSizes(PT_SHIRT, ['L'])
    const setup = await master.controller.project()
    const shorts = setup.inventory.find(item => item.catalogId === PT_SHORTS)!.entityId, lastShirt = setup.inventory.find(item => item.catalogId === PT_SHIRT)!.entityId
    await master.controller.receiveStock(shorts, 300); await master.controller.receiveStock(lastShirt, 1)
    for (let cadet = 0; cadet < CADETS; cadet++) await master.controller.createCadet({ gender: cadet % 2 ? 'Female' : 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    await master.syncNow(); chain.mine()
    for (const device of devices) await device.syncNow()
    chain.mine()
    const cadetIds = (await devices[DEVICES - 1].controller.project()).cadets.map(cadet => cadet.cadetId)
    expect(cadetIds).toHaveLength(CADETS)
    expect((await devices[DEVICES - 1].controller.project()).inventory.find(item => item.entityId === lastShirt)?.onHand).toBe(1)

    // Five commands each. Everyone issues, then returns, shorts to cadets; devices 0 and 1 end by issuing the one shirt left, each to a different cadet.
    const heldBy = async (device: UnitRuntime, transactionId: string) => (await device.controller.project()).cadets.flatMap(cadet => cadet.currentProperty).find(line => line.issueTransactionId === transactionId)!.propertyId
    const command = async (device: number, step: number) => {
      const runtime = devices[device], cadetId = (offset: number) => cadetIds[(device + offset) % CADETS], id = (n: number) => `t-${device}-${n}`
      const issue = (n: number, offset: number, itemId = shorts) => runtime.controller.issueTransaction({ transactionId: id(n), cadetId: cadetId(offset), lines: [{ lineId: 'l', itemId, quantity: 1 }] })
      const giveBack = async (n: number) => runtime.controller.returnTransaction({ transactionId: `r-${device}-${n}`, cadetId: cadetId(n), lines: [{ lineId: 'l', propertyId: await heldBy(runtime, id(n)), quantity: 1 }] })
      const raceForShirt = device < 2
      if (step === 0) await issue(0, 0)
      else if (step === 1) await issue(1, 1)
      else if (step === 2) await giveBack(0)
      else if (step === 3) { if (raceForShirt) await giveBack(1); else await issue(3, 3) }
      else if (raceForShirt) await issue(4, device, lastShirt)
      else await giveBack(3)
    }
    const beforeCommands = chain.requestSnapshot(), transactionsBeforeCommands = chain.transactions().length
    let round = 0
    for (let step = 0; step < COMMANDS_PER_DEVICE; step++) {
      for (const device of shuffle([...devices.keys()], ++round)) await command(device, step)
      // Some devices sync after each step, in another order; the rest keep working offline from each other.
      for (const device of shuffle([...devices.keys()], ++round).slice(0, 7)) await devices[device].syncNow()
      chain.mine()
    }
    // Everything settles: everyone publishes, then everyone reads, twice, in shuffled orders.
    for (let pass = 0; pass < 3; pass++) { for (const device of shuffle([...devices.keys()], ++round)) await devices[device].syncNow(); chain.mine() }

    const projections = await Promise.all(devices.map(device => device.controller.project()))
    // No command lost: all 100 issues and returns are on every device, and every one reached the chain.
    const applied = (projection: ArgusAppProjection) => projection.events.filter(record => record.event.eventType === 'ITEM_ISSUED' || record.event.eventType === 'ITEM_RETURNED').length
    for (const projection of projections) expect(applied(projection)).toBe(DEVICES * COMMANDS_PER_DEVICE)
    expect(devices.map(device => device.status().queued)).toEqual(devices.map(() => 0))
    // Delivered everywhere; the one record that lost the race is marked as a conflict, not as undelivered.
    expect(projections.flatMap(projection => projection.events).filter(record => record.syncStatus !== 'SYNCHRONIZED' && record.syncStatus !== 'CONFLICT').map(record => record.syncStatus)).toEqual([])
    // The same projection everywhere.
    const reference = shared(projections[0])
    projections.forEach((projection, index) => expect(shared(projection), `device ${index}`).toBe(reference))
    // The race: one shirt, two issues. One is applied and the other is an open conflict, the same one on every device; stock is never negative.
    for (const projection of projections) {
      const open = projection.conflicts.filter(conflict => conflict.status === 'OPEN')
      expect(open).toHaveLength(1)
      expect(open[0].inventoryItemIds ?? []).toContain(lastShirt)
      expect(projection.inventory.find(item => item.entityId === lastShirt)).toMatchObject({ onHand: 0, issued: 1 })
      expect(projection.inventory.every(item => item.onHand >= 0)).toBe(true)
      // 18 devices issue 3 and return 2 (net 1 held); the two shirt racers issue 2 and return 2
      expect(projection.inventory.find(item => item.entityId === shorts)).toMatchObject({ onHand: 282, issued: 18 })
    }

    // The busy phase's cost: each new transaction is fetched once by every other device that reads it.
    const busy = chain.requestsSince(beforeCommands), newTransactions = chain.transactions().length - transactionsBeforeCommands
    expect(newTransactions).toBe(DEVICES * COMMANDS_PER_DEVICE) // measured: every command went out in a transaction of its own
    expect(busy.txHex).toBeLessThanOrEqual(newTransactions * (DEVICES - 1)) // measured: exactly 19 fetches per transaction, none twice
    expect(busy.total / newTransactions, JSON.stringify(busy)).toBeLessThanOrEqual(REQUESTS_PER_COMMAND) // measured 23.9: 19 fetches, about 2 scans per device
    // Steady state: with nothing new anywhere, one more sync costs each device at most REQUESTS_PER_IDLE_SCAN requests.
    const costs: number[] = [], worst: Partial<FakeChainRequestCounts> = {}
    for (const device of devices) {
      const before = chain.requestSnapshot()
      await device.syncNow()
      const spent = chain.requestsSince(before)
      costs.push(spent.total)
      for (const kind of Object.keys(spent) as Array<keyof FakeChainRequestCounts>) worst[kind] = Math.max(worst[kind] ?? 0, spent[kind])
    }
    expect(Math.max(...costs), JSON.stringify(worst)).toBeLessThanOrEqual(REQUESTS_PER_IDLE_SCAN)
    expect(worst).toMatchObject({ confirmedHistory: 1, unconfirmedHistory: 1, txHex: 0, broadcast: 0 })

    // A sync that also publishes one new command: the broadcast, the wallet's look at its coins, and the scan.
    await devices[5].controller.issueTransaction({ transactionId: 'one-more', cadetId: cadetIds[0], lines: [{ lineId: 'l', itemId: shorts, quantity: 1 }] })
    const beforePublish = chain.requestSnapshot()
    await devices[5].syncNow()
    const publishing = chain.requestsSince(beforePublish)
    expect(publishing.total, JSON.stringify(publishing)).toBeLessThanOrEqual(REQUESTS_PER_PUBLISHING_SYNC)
  })
})

describe('the chain client under a rate limit', { timeout: 120_000 }, () => {
  it('waits with growing, jittered delays on 429, resumes, and does not re-send or lose anything it had already published', async () => {
    const chain = new FakeChain()
    const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(masterDevice.record.walletAddress, 200_000, { confirmed: true })
    const master = await UnitRuntime.open(masterDevice, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    const joined = await joinByTicket(master, chain, 'Officer B', 'SUPPLY_OFFICER')
    await master.controller.addCatalogSizes(PT_SHORTS, ['M'])
    const shorts = (await master.controller.project()).inventory.find(item => item.catalogId === PT_SHORTS)!.entityId
    await master.controller.receiveStock(shorts, 5)
    await master.syncNow(); chain.mine()

    // B's phone talks to the chain through the real client, and the chain answers 429 to the first 3 history requests.
    let limited = 0
    const { fetcher, paths } = fakeWocFetch(chain, { rateLimit: path => path.includes('/confirmed/history') && limited < 3 && ++limited > 0 })
    const sleeps: number[] = []
    let clock = 0, jitter = 0
    const api = new WhatsOnChainApi({ fetcher, minSpacingMs: 0, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms }, random: () => (jitter += 0.2) % 1 })
    const phone = await UnitRuntime.open(joined.device, { api, ledger: joined.ledger, walletStore: new MemoryWalletStateStore(), storage: joined.store })
    await phone.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE' })
    const broadcastsBefore = chain.requestCount.broadcast

    const projection = await phone.syncNow()
    expect(limited).toBe(3)
    expect(paths.filter(path => path.includes('/confirmed/history')).length).toBeGreaterThanOrEqual(4) // three 429s, then the answer (the phone's own publish makes it scan once more)
    // Three waits, each longer than the last (doubling) and each with its jitter on top.
    expect(sleeps).toHaveLength(3)
    expect(sleeps[0]).toBeGreaterThanOrEqual(500); expect(sleeps[0]).toBeLessThan(1000)
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000); expect(sleeps[1]).toBeLessThan(2000)
    expect(sleeps[2]).toBeGreaterThanOrEqual(2000); expect(sleeps[2]).toBeLessThan(4000)
    expect(new Set(sleeps.map((ms, index) => ms / 500 / 2 ** index)).size).toBe(3) // the jitter differs from wait to wait
    // The scan then succeeded: the phone is in sync, sees the Master's stock, and its own cadet was published once.
    expect(phone.status()).toMatchObject({ state: 'synced', queued: 0 })
    expect(phone.status().lastError).toBeUndefined()
    expect(projection.inventory.find(item => item.entityId === shorts)?.onHand).toBe(5)
    expect(chain.requestCount.broadcast - broadcastsBefore).toBe(1)
    await phone.syncNow(); chain.mine(); await phone.syncNow()
    expect(chain.requestCount.broadcast - broadcastsBefore).toBe(1)
    await master.syncNow()
    expect((await master.controller.project()).cadets).toHaveLength(1)
  })
})
