/**
 * LIVE BSV TESTNET proof of the owner's acceptance scenario, end to end, with no server:
 *
 *   1. A Master creates a unit (fresh unit ID ⇒ fresh anchor address) with a faucet-funded wallet.
 *   2. The Master makes a ticket for Officer B and for Assistant C, each funded with starter
 *      satoshis from its own wallet; their devices redeem the tickets from the chain alone —
 *      each person has their own key; nothing secret is shared.
 *   3. A adds sizes to PT Shorts and opens a shared count; everything is encrypted and written
 *      to testnet; B and C discover it by walking the anchor address history on WhatsOnChain.
 *   4. A counts 3 PT Shorts (M) and B counts 3 PT Shorts (M) → every device shows 6.
 *   5. A finalizes → on-hand 6 on every device.
 *   6. A brand-new device with an empty local ledger rebuilds the same state from chain alone.
 *
 * Run: npm run testnet:keys (once; fund the printed address) then npm run test:testnet
 * Dry run (no network, in-memory chain funded with exactly 1,000 satoshis): ARGUS_TESTNET_DRY_RUN=1 npm run test:testnet
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WhatsOnChainApi } from '../src/chain/woc'
import { FakeChain } from '../src/chain/fakeChain'
import type { ChainApi } from '../src/chain/types'
import { DeviceWallet } from '../src/chain/wallet'
import { MemoryWalletStateStore } from '../src/chain/walletStore'
import { GENESIS_CATALOG } from '../src/stage3/domain'
import { MemoryLedgerStore } from '../src/unit/ledgerStore'
import { UnitRuntime } from '../src/unit/runtime'
import { TicketRefusal, redeemTicket } from '../src/unit/ticketRedemption'
import { createJoiningDevice, createMasterDevice } from '../src/unit/vault'

const KEY_FILE = process.env.ARGUS_TESTNET_KEYS ?? join(homedir(), '.config', 'argus', 'testnet-keys.json')
const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
// Each record costs ~2–5 satoshis at 1 sat/kB; the whole run needs well under 1,000.
const MIN_MASTER_SATOSHIS = 600
const MEMBER_TOP_UP_SATOSHIS = 150
const storage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
const DRY_RUN = process.env.ARGUS_TESTNET_DRY_RUN === '1'
const POLL_MS = DRY_RUN ? 20 : 6_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const log = (line: string) => process.stdout.write(`${new Date().toISOString()}  ${line}\n`)

/** WhatsOnChain indexes mempool transactions within seconds, but not instantly: poll until a condition holds. */
async function until<T>(label: string, read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 4 * 60_000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (ok(value)) { log(`✓ ${label} (${Math.round((Date.now() - started) / 1000)} s)`); return value }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for: ${label}`)
    await sleep(POLL_MS)
  }
}

const keys = DRY_RUN ? { master: { wif: DeviceWallet.generateWif(), address: '' } } : existsSync(KEY_FILE) ? JSON.parse(readFileSync(KEY_FILE, 'utf8')) as { master: { wif: string; address: string } } : undefined

describe.skipIf(!keys)('LIVE BSV TESTNET: shared count across three devices', () => {
  it('A counts 3 + B counts 3 = 6 on every device, finalizes to on-hand 6, and a fresh device rebuilds it from chain', async () => {
    let api: ChainApi = new WhatsOnChainApi()
    if (DRY_RUN) { const chain = new FakeChain(); chain.fund(DeviceWallet.fromWif(keys!.master.wif, chain, new MemoryWalletStateStore()).address, 1_000, { confirmed: true }); api = chain; log('DRY RUN: in-memory chain, master funded with 1,000 satoshis') }
    const funded = await DeviceWallet.fromWif(keys!.master.wif, api, new MemoryWalletStateStore()).refresh()
    log(`Master wallet ${funded.address}: ${funded.spendable} spendable satoshis (${funded.confirmed} confirmed)`)
    if (funded.spendable < MIN_MASTER_SATOSHIS) throw new Error(`Fund ${funded.address} with at least ${MIN_MASTER_SATOSHIS} testnet satoshis from a BSV testnet faucet, then rerun.`)

    const masterDevice = await createMasterDevice({ passphrase: 'live testnet check 1', displayName: 'Master A', unitName: `ARGUS live check ${new Date().toISOString().slice(0, 16)}`, walletWif: keys!.master.wif }, storage())
    const open = (device: typeof masterDevice) => UnitRuntime.open(device, { api, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() })
    const a = await open(masterDevice)
    log(`Unit ${masterDevice.record.unit!.unitId} · anchor ${a.transport.anchorAddress}`)
    const members: UnitRuntime[] = [], topUps: string[] = []
    for (const [name, role] of [['Officer B', 'SUPPLY_OFFICER'], ['Assistant C', 'SUPPLY_ASSISTANT']] as const) {
      const ticket = await a.issueTicket(name, role, { satoshis: MEMBER_TOP_UP_SATOSHIS })
      await a.syncNow()
      log(`Ticket for ${name}: funding tx ${ticket.funding.txid}`)
      topUps.push(ticket.funding.txid)
      const options = { api, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: storage() }
      const pending = await createJoiningDevice({ passphrase: 'live testnet check 2', displayName: name }, options.storage)
      // The new device needs only the code; until the ticket is visible on the network it is told so.
      const redeemed = await until(`${name} redeems the ticket from the chain`, async () => {
        try { return await redeemTicket(pending, ticket.code, options) } catch (error) { if (error instanceof TicketRefusal && error.reason === 'NOT_ON_NETWORK') return undefined; throw error }
      }, value => Boolean(value))
      if (redeemed?.status !== 'ACTIVE') throw new Error(`${name}'s ticket was not accepted by the network.`)
      members.push(await open(redeemed.device))
    }
    const [b, c] = members

    await a.controller.addCatalogSizes(PT_SHORTS, ['S', 'M', 'L'])
    const projection = await a.controller.createCountSession({ sessionId: `count_${crypto.randomUUID()}`, scope: 'Live testnet count' })
    const sessionId = projection.countSessions[0].sessionId
    const medium = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'M')!.entityId
    await a.syncNow()
    log(`A published setup: ${JSON.stringify(a.status())}`)
    await until('B sees the count session', () => b.syncNow(), view => view.countSessions.some(session => session.sessionId === sessionId))

    await a.controller.contributeCount(sessionId, { itemId: medium }, 3, 'Shelf A')
    await b.controller.contributeCount(sessionId, { itemId: medium }, 3, 'Shelf B')
    await a.syncNow(); await b.syncNow()
    const totalOf = (view: typeof projection) => view.countSessions.find(session => session.sessionId === sessionId)?.totals[medium]
    for (const [name, runtime] of [['A', a], ['B', b], ['C', c]] as const) await until(`${name} shows a shared total of 6`, () => runtime.syncNow(), view => totalOf(view) === 6)

    await a.controller.finalizeCountSession(sessionId)
    await a.syncNow()
    for (const [name, runtime] of [['A', a], ['B', b], ['C', c]] as const) await until(`${name} shows on-hand 6 after finalization`, () => runtime.syncNow(), view => view.inventory.find(item => item.entityId === medium)?.onHand === 6)

    const fresh = await open(b.device)
    const rebuilt = await until('a brand-new device rebuilds on-hand 6 from chain alone', () => fresh.syncNow(), view => view.inventory.find(item => item.entityId === medium)?.onHand === 6)
    expect(totalOf(rebuilt)).toBe(6)
    expect(rebuilt.members.map(member => member.displayName).sort()).toEqual(['Assistant C', 'Master A', 'Officer B'])

    // Every unit transaction, whoever published it: each device links every change to the transaction that carried it.
    const perDevice = (await Promise.all([a, b, c].map(runtime => runtime.controller.project()))).map(view => [...new Set(view.events.flatMap(record => record.transactionId ? [record.transactionId] : []))].sort())
    const txids = [...new Set(perDevice.flat())].sort()
    for (const seen of perDevice) expect(seen).toEqual(txids)
    const link = (txid: string) => `https://test.whatsonchain.com/tx/${txid}`
    const report = { at: new Date().toISOString(), unitId: masterDevice.record.unit!.unitId, anchor: a.transport.anchorAddress, anchorExplorer: `https://test.whatsonchain.com/address/${a.transport.anchorAddress}`, transactions: txids.map(link), memberTicketFundings: topUps.map(link), masterBalanceAfter: (await a.balance()).spendable }
    if (!DRY_RUN) writeFileSync(join(process.cwd(), 'testnet', 'last-run.json'), JSON.stringify(report, null, 2))
    log(`${DRY_RUN ? 'Dry-run report (not saved)' : 'Report written to testnet/last-run.json'}\n${JSON.stringify(report, null, 2)}`)
    expect(txids.length).toBeGreaterThan(0)
  })
})
