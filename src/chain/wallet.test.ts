import { PrivateKey, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeArgusRecords, isTestnetAddress } from './codec'
import { FakeChain, fakeAddress, type FakeChainOptions } from './fakeChain'
import type { ArgusRecord, WalletState } from './types'
import { DeviceWallet, InsufficientFundsError } from './wallet'
import { MemoryWalletStateStore } from './walletStore'

const ANCHOR = fakeAddress()

function record(seed: number, kind: ArgusRecord['kind'] = 'E'): ArgusRecord {
  return { kind, payload: new Uint8Array(48).fill(seed) }
}

function setup(chainOptions: FakeChainOptions = {}) {
  const chain = new FakeChain(chainOptions)
  const store = new MemoryWalletStateStore()
  const wif = DeviceWallet.generateWif()
  const wallet = DeviceWallet.fromWif(wif, chain, store)
  return { chain, store, wif, wallet }
}

async function storedState(store: MemoryWalletStateStore, address: string): Promise<WalletState> {
  const state = await store.load(address)
  if (!state) throw new Error('no stored state')
  return state
}

/** Input outpoints of a raw transaction, as "txid:vout". */
function inputsOf(hex: string): string[] {
  return Transaction.fromHex(hex).inputs.map((input) => `${input.sourceTXID}:${input.sourceOutputIndex}`)
}

function feeOf(chain: FakeChain, hex: string): number {
  const tx = Transaction.fromHex(hex)
  const inputs = tx.inputs.reduce((total, input) => {
    const source = Transaction.fromHex(chain.get(input.sourceTXID ?? '')?.hex ?? '')
    return total + (source.outputs[input.sourceOutputIndex].satoshis ?? 0)
  }, 0)
  return inputs - tx.outputs.reduce((total, output) => total + (output.satoshis ?? 0), 0)
}

describe('keys', () => {
  it('generates testnet WIFs and testnet addresses', () => {
    const wif = DeviceWallet.generateWif()
    expect(wif.startsWith('c')).toBe(true)
    const wallet = DeviceWallet.fromWif(wif, new FakeChain(), new MemoryWalletStateStore())
    expect(isTestnetAddress(wallet.address)).toBe(true)
    expect(wallet.address).toBe(PrivateKey.fromWif(wif).toAddress('testnet'))
    expect(wallet.network).toBe('testnet')
  })

  it('rejects a mainnet WIF and garbage', () => {
    const mainnetWif = PrivateKey.fromRandom().toWif()
    expect(() => DeviceWallet.fromWif(mainnetWif, new FakeChain(), new MemoryWalletStateStore())).toThrow(/MAINNET/)
    expect(() => DeviceWallet.fromWif('not-a-key', new FakeChain(), new MemoryWalletStateStore())).toThrow(/WIF/)
  })

  it('refuses a non-testnet chain API', () => {
    const api = new FakeChain()
    Object.defineProperty(api, 'network', { value: 'mainnet' })
    expect(() => DeviceWallet.fromWif(DeviceWallet.generateWif(), api, new MemoryWalletStateStore())).toThrow(/Mainnet/)
  })
})

describe('publishing records', () => {
  it('funds, prepares, flushes and settles', async () => {
    const { chain, store, wallet } = setup()
    const funding = chain.fund(wallet.address, 10_000, { confirmed: true })
    expect(await wallet.refresh()).toEqual({ address: wallet.address, confirmed: 10_000, unconfirmed: 0, spendable: 10_000, pendingBroadcasts: 0 })

    const savesBefore = store.saveCount
    const pending = await wallet.prepareRecords([record(1), record(2, 'G')], ANCHOR, ['event-1', 'grant-1'])
    expect(store.saveCount - savesBefore).toBe(1) // inputs, change and pending tx land in ONE save
    expect(chain.requestCount.broadcast).toBe(0) // prepare never broadcasts
    expect(pending).toMatchObject({ purpose: 'records', correlationIds: ['event-1', 'grant-1'], status: 'pending', attempts: 0, feeSatPerKb: 1 })

    // Layout: data outputs, then exactly one 1-sat anchor output, then change.
    const tx = Transaction.fromHex(pending.hex)
    expect(tx.id('hex')).toBe(pending.txid)
    expect(decodeArgusRecords(pending.hex)).toEqual([
      { ...record(1), vout: 0 },
      { ...record(2, 'G'), vout: 1 },
    ])
    expect(tx.outputs.map((output) => output.satoshis)).toEqual([0, 0, 1, expect.any(Number)])
    expect(inputsOf(pending.hex)).toEqual([`${funding}:0`])

    const change = tx.outputs[3].satoshis ?? 0
    expect(await wallet.balance()).toEqual({ address: wallet.address, confirmed: 0, unconfirmed: change, spendable: change, pendingBroadcasts: 1 })

    await expect(wallet.flush()).resolves.toEqual({ broadcast: [pending.txid], rolledBack: [], stillPending: [] })
    expect(feeOf(chain, pending.hex)).toBe(Math.ceil(pending.hex.length / 2 / 1000))
    expect(await chain.unconfirmedHistory(ANCHOR)).toEqual([pending.txid])
    expect(await wallet.pending()).toEqual([])
    expect(await wallet.ownTxHex(pending.txid)).toBe(pending.hex)
    expect((await storedState(store, wallet.address)).recent[0].txid).toBe(pending.txid)

    const height = chain.mine()
    expect((await chain.confirmedHistory(ANCHOR)).items).toEqual([{ txid: pending.txid, height }])
    expect(await wallet.refresh()).toMatchObject({ confirmed: change, unconfirmed: 0, pendingBroadcasts: 0 })
    expect(await wallet.flush()).toEqual({ broadcast: [], rolledBack: [], stillPending: [] })
  })

  it('chains three prepares off one coin before any broadcast or block, despite index lag', async () => {
    const { chain, wallet } = setup()
    const funding = chain.fund(wallet.address, 20_000, { confirmed: true })
    await wallet.refresh()
    chain.unspentLag = true

    const first = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    const second = await wallet.prepareRecords([record(2)], ANCHOR, ['e2'])
    const third = await wallet.prepareRecords([record(3)], ANCHOR, ['e3'])
    // Each spends the previous transaction's change.
    expect(inputsOf(first.hex)).toEqual([`${funding}:0`])
    expect(inputsOf(second.hex)).toEqual([`${first.txid}:2`])
    expect(inputsOf(third.hex)).toEqual([`${second.txid}:2`])
    expect(chain.requestCount.broadcast).toBe(0)

    expect(await wallet.flush()).toEqual({ broadcast: [first.txid, second.txid, third.txid], rolledBack: [], stillPending: [] })
    expect(chain.mempool()).toEqual([first.txid, second.txid, third.txid])

    // The lagging index still lists the spent funding coin and none of the new change.
    const lastChange = Transaction.fromHex(third.hex).outputs[2].satoshis ?? 0
    expect(await wallet.refresh()).toMatchObject({ spendable: lastChange, pendingBroadcasts: 0 })

    const fourth = await wallet.prepareRecords([record(4)], ANCHOR, ['e4'])
    expect(inputsOf(fourth.hex)).toEqual([`${third.txid}:2`])
    expect((await wallet.flush()).broadcast).toEqual([fourth.txid])

    chain.mine()
    const finalChange = Transaction.fromHex(fourth.hex).outputs[2].satoshis ?? 0
    expect(await wallet.refresh()).toMatchObject({ confirmed: finalChange, unconfirmed: 0, spendable: finalChange })
    expect(chain.balanceOf(wallet.address)).toBe(finalChange)
  })

  it('publishes TextEncoder payloads (a foreign-realm Uint8Array under jsdom)', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    const payload = new TextEncoder().encode('{"event":"x"}')
    const pending = await wallet.prepareRecords([{ kind: 'E', payload }], ANCHOR, ['e1'])
    const [decoded] = decodeArgusRecords(pending.hex)
    expect(new TextDecoder().decode(decoded.payload)).toBe('{"event":"x"}')
  })

  it('serializes concurrent prepares', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 20_000, { confirmed: true })
    await wallet.refresh()
    const prepared = await Promise.all([1, 2, 3].map((seed) => wallet.prepareRecords([record(seed)], ANCHOR, [`e${seed}`])))
    expect(new Set(prepared.map((tx) => tx.txid)).size).toBe(3)
    expect((await wallet.flush()).broadcast).toEqual(prepared.map((tx) => tx.txid))
  })

  it('counts a duplicated unspent listing once', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    chain.fund(wallet.address, 3000)
    chain.duplicateUnspent = true
    expect(await wallet.refresh()).toMatchObject({ confirmed: 5000, unconfirmed: 3000, spendable: 8000 })
    expect(await wallet.refresh()).toMatchObject({ confirmed: 5000, unconfirmed: 3000, spendable: 8000 })

    const pending = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    expect(inputsOf(pending.hex)).toHaveLength(1)
    expect((await wallet.flush()).broadcast).toEqual([pending.txid])
  })

  it('refreshes automatically when the local view cannot cover a prepare', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000)
    const pending = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    expect(chain.requestCount.unspent).toBe(1)
    expect((await wallet.flush()).broadcast).toEqual([pending.txid])
  })

  it('persists pending transactions for another wallet instance on the same store', async () => {
    const { chain, store, wif, wallet } = setup()
    chain.fund(wallet.address, 5000)
    const pending = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])

    const reopened = DeviceWallet.fromWif(wif, chain, store)
    expect((await reopened.pending()).map((tx) => tx.txid)).toEqual([pending.txid])
    expect(await reopened.ownTxHex(pending.txid)).toBe(pending.hex)
    expect((await reopened.flush()).broadcast).toEqual([pending.txid])
  })

  it('validates inputs before touching state', async () => {
    const { chain, store, wallet } = setup()
    chain.fund(wallet.address, 5000)
    const mainnetAddress = PrivateKey.fromRandom().toAddress('mainnet')
    await expect(wallet.prepareRecords([record(1)], mainnetAddress, [])).rejects.toThrow(/testnet/)
    await expect(wallet.prepareRecords([], ANCHOR, [])).rejects.toThrow(/At least one/)
    await expect(wallet.prepareRecords(Array.from({ length: 26 }, (_, i) => record(i)), ANCHOR, [])).rejects.toThrow(/limit/)
    await expect(wallet.prepareTransfer(mainnetAddress, 100)).rejects.toThrow(/testnet/)
    await expect(wallet.prepareTransfer(fakeAddress(), 0)).rejects.toThrow(/at least 1/)
    await expect(wallet.prepareTransfer(fakeAddress(), 1.5)).rejects.toThrow(/whole number/)
    expect(store.saveCount).toBe(0)
  })
})

describe('insufficient funds', () => {
  it('names the address and suggests a testnet faucet', async () => {
    const { wallet } = setup()
    const error = await wallet.prepareRecords([record(1)], ANCHOR, ['e1']).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(InsufficientFundsError)
    const insufficient = error as InsufficientFundsError
    expect(insufficient.message).toContain(wallet.address)
    expect(insufficient.message).toMatch(/testnet faucet/)
    expect(insufficient.address).toBe(wallet.address)
    expect(insufficient.spendable).toBe(0)
    expect(insufficient.needed).toBeGreaterThan(1)
  })

  it('refuses a transfer larger than the balance and leaves the coins untouched', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 1000)
    await wallet.refresh()
    await expect(wallet.prepareTransfer(fakeAddress(), 1000)).rejects.toMatchObject({ name: 'InsufficientFundsError', spendable: 1000 })
    expect(await wallet.balance()).toMatchObject({ spendable: 1000, pendingBroadcasts: 0 })
  })
})

describe('transfers between device wallets', () => {
  it('pays another wallet, which sees and spends it after refresh', async () => {
    const chain = new FakeChain()
    const alice = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    const bob = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore())
    chain.fund(alice.address, 10_000, { confirmed: true })
    await alice.refresh()

    const payment = await alice.prepareTransfer(bob.address, 3000)
    expect(payment).toMatchObject({ purpose: 'transfer', correlationIds: [] })
    expect(await bob.refresh()).toMatchObject({ spendable: 0 })
    expect((await alice.flush()).broadcast).toEqual([payment.txid])

    expect(await bob.refresh()).toMatchObject({ confirmed: 0, unconfirmed: 3000 })
    chain.mine()
    expect(await bob.refresh()).toMatchObject({ confirmed: 3000, unconfirmed: 0 })

    const back = await bob.prepareTransfer(alice.address, 1000)
    expect((await bob.flush()).broadcast).toEqual([back.txid])
    const aliceChange = Transaction.fromHex(payment.hex).outputs[1].satoshis ?? 0
    expect(await alice.refresh()).toMatchObject({ spendable: aliceChange + 1000 })
  })
})

describe('flush outcomes', () => {
  it('rebroadcasts the same bytes after an ambiguous answer, landing exactly one transaction', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const pending = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])

    chain.failNextBroadcasts('ambiguousButAccepted')
    expect(await wallet.flush()).toEqual({ broadcast: [], rolledBack: [], stillPending: [pending.txid] })
    const [kept] = await wallet.pending()
    expect(kept).toMatchObject({ txid: pending.txid, hex: pending.hex, attempts: 1, lastError: expect.stringMatching(/timed out/) })

    expect(await wallet.flush()).toEqual({ broadcast: [pending.txid], rolledBack: [], stillPending: [] })
    expect(chain.transactions().filter((tx) => tx.txid === pending.txid)).toHaveLength(1)
    expect(chain.transactions()).toHaveLength(2) // funding + ours
  })

  it('stops the round at an ambiguous answer so dependants wait', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const first = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    const second = await wallet.prepareRecords([record(2)], ANCHOR, ['e2'])

    chain.failNextBroadcasts('ambiguous')
    expect(await wallet.flush()).toEqual({ broadcast: [], rolledBack: [], stillPending: [first.txid, second.txid] })
    expect(chain.requestCount.broadcast).toBe(1)
    expect(await wallet.flush()).toEqual({ broadcast: [first.txid, second.txid], rolledBack: [], stillPending: [] })
  })

  it('rolls back a conflict and its dependent child, returns their correlation IDs and refreshes', async () => {
    // The same key restored on a second device spends the coin first.
    const chain = new FakeChain()
    const wif = DeviceWallet.generateWif()
    const device = DeviceWallet.fromWif(wif, chain, new MemoryWalletStateStore())
    const restored = DeviceWallet.fromWif(wif, chain, new MemoryWalletStateStore())
    chain.fund(device.address, 10_000, { confirmed: true })
    await device.refresh()
    await restored.refresh()

    const elsewhere = await restored.prepareTransfer(fakeAddress(), 2000)
    expect((await restored.flush()).broadcast).toEqual([elsewhere.txid])

    const parent = await device.prepareRecords([record(1)], ANCHOR, ['event-a'])
    const child = await device.prepareRecords([record(2)], ANCHOR, ['event-b', 'event-c'])
    expect(inputsOf(child.hex)).toEqual([`${parent.txid}:2`])
    const unspentCallsBefore = chain.requestCount.unspent

    const result = await device.flush()
    expect(result.broadcast).toEqual([])
    expect(result.stillPending).toEqual([])
    expect(result.rolledBack).toEqual([
      { txid: parent.txid, correlationIds: ['event-a'], status: 'conflict', reason: expect.stringMatching(/conflict/) },
      { txid: child.txid, correlationIds: ['event-b', 'event-c'], status: 'conflict', reason: expect.stringMatching(new RegExp(`Depends on rolled-back transaction ${parent.txid}`)) },
    ])
    expect(chain.requestCount.unspent).toBe(unspentCallsBefore + 1)

    // After the refresh the device only holds the other device's change.
    const otherChange = Transaction.fromHex(elsewhere.hex).outputs[1].satoshis ?? 0
    expect(await device.balance()).toEqual({ address: device.address, confirmed: 0, unconfirmed: otherChange, spendable: otherChange, pendingBroadcasts: 0 })
    const retry = await device.prepareRecords([record(1)], ANCHOR, ['event-a'])
    expect(inputsOf(retry.hex)).toEqual([`${elsewhere.txid}:1`])
    expect((await device.flush()).broadcast).toEqual([retry.txid])
  })

  it('rolls back on fee-too-low, raises the fee rate 1 -> 10 and persists it', async () => {
    const { chain, store, wif, wallet } = setup({ minFeeSatPerKb: 5 })
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const cheap = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    expect(cheap.feeSatPerKb).toBe(1)

    const result = await wallet.flush()
    expect(result.rolledBack).toEqual([{ txid: cheap.txid, correlationIds: ['e1'], status: 'fee-too-low', reason: expect.stringMatching(/fee/) }])
    expect(await wallet.balance()).toMatchObject({ confirmed: 5000, spendable: 5000, pendingBroadcasts: 0 })
    expect((await storedState(store, wallet.address)).feeSatPerKb).toBe(10)

    // A new instance on the same store keeps the raised rate.
    const reopened = DeviceWallet.fromWif(wif, chain, store)
    const fair = await reopened.prepareRecords([record(1)], ANCHOR, ['e1'])
    expect(fair.feeSatPerKb).toBe(10)
    expect((await reopened.flush()).broadcast).toEqual([fair.txid])
  })

  it('climbs the fee ladder to 50 sat/kB and stops there', async () => {
    const { chain, store, wallet } = setup()
    chain.fund(wallet.address, 50_000, { confirmed: true })
    await wallet.refresh()
    const rates: number[] = []
    for (let round = 0; round < 3; round += 1) {
      const pending = await wallet.prepareRecords([record(round)], ANCHOR, [`e${round}`])
      rates.push(pending.feeSatPerKb)
      chain.failNextBroadcasts('fee-too-low')
      await wallet.flush()
    }
    expect(rates).toEqual([1, 10, 50])
    expect((await storedState(store, wallet.address)).feeSatPerKb).toBe(50)
  })

  it('rolls back a rejected transaction and frees its inputs', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const pending = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    chain.failNextBroadcasts('rejected')
    const result = await wallet.flush()
    expect(result.rolledBack).toEqual([{ txid: pending.txid, correlationIds: ['e1'], status: 'rejected', reason: expect.stringMatching(/rejected/) }])
    expect(await wallet.balance()).toMatchObject({ confirmed: 5000, spendable: 5000, pendingBroadcasts: 0 })
    expect(chain.requestCount.unspent).toBe(1) // no refresh for a plain rejection
  })

  it('drops a phantom change coin after the conflict it causes instead of reselecting it', async () => {
    const { chain, wallet } = setup()
    chain.fund(wallet.address, 9000, { confirmed: true })
    const spare = chain.fund(wallet.address, 4000, { confirmed: true })
    await wallet.refresh()

    // The API claims success but the transaction never lands.
    const lost = await wallet.prepareRecords([record(1)], ANCHOR, ['e1'])
    chain.failNextBroadcasts('accepted')
    expect((await wallet.flush()).broadcast).toEqual([lost.txid])
    expect(chain.get(lost.txid)).toBeUndefined()

    const orphan = await wallet.prepareRecords([record(2)], ANCHOR, ['e2'])
    expect(inputsOf(orphan.hex)).toEqual([`${lost.txid}:2`])
    const result = await wallet.flush()
    expect(result.rolledBack.map((entry) => [entry.txid, entry.status])).toEqual([[orphan.txid, 'conflict']])

    // Never the phantom change again. The coin the lost transaction spent is still on chain and the network
    // does not know that transaction, so it is released and may be chosen as well as the spare.
    const retry = await wallet.prepareRecords([record(2)], ANCHOR, ['e2'])
    expect(inputsOf(retry.hex)).not.toContain(`${lost.txid}:2`)
    expect(inputsOf(retry.hex).every((input) => input === `${spare}:0` || !input.startsWith(lost.txid))).toBe(true)
    expect((await wallet.flush()).broadcast).toEqual([retry.txid])
  })

  it('surfaces a txHex failure from prepare without changing state', async () => {
    const { chain, store, wallet } = setup()
    chain.fund(wallet.address, 5000, { confirmed: true })
    await wallet.refresh()
    const saves = store.saveCount
    chain.txHexNotFoundCount = 1
    await expect(wallet.prepareRecords([record(1)], ANCHOR, ['e1'])).rejects.toMatchObject({ status: 404 })
    expect(store.saveCount).toBe(saves)
    await expect(wallet.prepareRecords([record(1)], ANCHOR, ['e1'])).resolves.toMatchObject({ status: 'pending' })
  })
})

describe('coins behind a broadcast the network accepted but never kept', () => {
  it('are released once the network reports that transaction unknown, so the wallet can spend what the chain still lists', async () => {
    const chain = new FakeChain(), wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore()), anchor = fakeAddress()
    const rec = (seed: number) => ({ kind: 'E' as const, payload: new Uint8Array(48).fill(seed) })
    chain.fund(wallet.address, 10_000, { confirmed: true }); await wallet.refresh()
    await wallet.prepareRecords([rec(1)], anchor, ['e1']); chain.failNextBroadcasts('accepted'); await wallet.flush()
    await wallet.prepareRecords([rec(2)], anchor, ['e2']); await wallet.flush() // spends the phantom change: refused
    for (let round = 0; round < 3; round++) { chain.mine(); await wallet.refresh() }
    expect((await wallet.balance()).spendable).toBe(chain.balanceOf(wallet.address))
    await expect(wallet.prepareRecords([rec(3)], anchor, ['e3'])).resolves.toMatchObject({ status: 'pending' })
  })

  it('stay reserved while the spending transaction is still known to the network (the index only lags)', async () => {
    const chain = new FakeChain({ unspentLag: true } as FakeChainOptions), wallet = DeviceWallet.fromWif(DeviceWallet.generateWif(), chain, new MemoryWalletStateStore()), anchor = fakeAddress()
    chain.fund(wallet.address, 10_000, { confirmed: true }); await wallet.refresh()
    await wallet.prepareRecords([{ kind: 'E', payload: new Uint8Array(48).fill(1) }], anchor, ['e1']); await wallet.flush()
    await wallet.refresh()
    expect((await wallet.balance()).spendable).toBeLessThan(10_000)
  })
})

describe('spending an admission ticket’s funding output (ADR 012)', () => {
  const ticketKey = () => PrivateKey.fromRandom()
  async function fundedTicket(satoshis = 2_000) {
    const { chain, wallet, ...rest } = setup(), key = ticketKey(), ticketAddress = key.toAddress('testnet')
    chain.fund(wallet.address, 50_000, { confirmed: true })
    const funding = await wallet.prepareTransfer(ticketAddress, satoshis)
    return { chain, wallet, key, ticketAddress, funding, ...rest }
  }

  it('signs with the ticket key, carries a T record and a 1-sat marker at the ticket address, and returns the rest to the wallet', async () => {
    const { chain, wallet, key, ticketAddress, funding } = await fundedTicket()
    await wallet.flush()
    const before = (await wallet.balance()).spendable
    const spend = await wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(1, 2, 3) }], markerAddress: ticketAddress, correlationIds: ['cancel:t-x'] })
    expect(inputsOf(spend.hex)).toEqual([`${funding.txid}:0`])
    const flushed = await wallet.flush()
    expect(flushed.broadcast).toEqual([spend.txid]); expect(flushed.rolledBack).toEqual([])
    expect(chain.spenderOf(funding.txid, 0)).toBe(spend.txid)
    expect(decodeArgusRecords(spend.hex)).toMatchObject([{ kind: 'T', vout: 0 }])
    const tx = Transaction.fromHex(spend.hex)
    expect(tx.outputs[1].satoshis).toBe(1)
    // the ticket address shows the spend in its history (the marker), and the leftover came back to the wallet
    expect(chain.balanceOf(ticketAddress)).toBe(1)
    expect((await wallet.balance()).spendable).toBeGreaterThan(before + 1_900)
    expect(feeOf(chain, spend.hex)).toBeLessThanOrEqual(5)
  })

  it('marks every address it is asked to: a redemption shows at the ticket address and on the unit’s anchor', async () => {
    const { chain, wallet, key, ticketAddress, funding } = await fundedTicket()
    const anchor = fakeAddress()
    const spend = await wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(1) }, { kind: 'E', payload: Uint8Array.of(2) }], markerAddress: ticketAddress, alsoMarkAddresses: [anchor], correlationIds: ['redeem:t-x'] })
    expect((await wallet.flush()).broadcast).toEqual([funding.txid, spend.txid])
    expect(decodeArgusRecords(spend.hex).map(record => record.kind)).toEqual(['T', 'E'])
    expect([chain.balanceOf(ticketAddress), chain.balanceOf(anchor)]).toEqual([1, 1])
    expect(await chain.unconfirmedHistory(anchor)).toEqual([spend.txid])
    await expect(wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(1) }], markerAddress: ticketAddress, alsoMarkAddresses: ['1BoatSLRHtKNngkdXEeobR76b53LETtpyT'], correlationIds: [] })).rejects.toThrow(/Marker address/)
  })

  it('queues the spend durably, in order behind its funding transaction, and survives a restart', async () => {
    const { wallet, key, ticketAddress, funding, store, wif, chain } = await fundedTicket()
    const spend = await wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(9) }], markerAddress: ticketAddress, correlationIds: ['cancel:t-x'] })
    const again = DeviceWallet.fromWif(wif, chain, store)
    expect((await again.pending()).map(tx => tx.txid)).toEqual([funding.txid, spend.txid])
    expect((await again.pending())[1].correlationIds).toEqual(['cancel:t-x'])
    const flushed = await again.flush()
    expect(flushed.broadcast).toEqual([funding.txid, spend.txid])
  })

  it('refuses a key that does not own the output, and an output that is not there', async () => {
    const { wallet, ticketAddress, funding } = await fundedTicket()
    await expect(wallet.prepareSpendOfOutpoint({ key: ticketKey(), outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(1) }], markerAddress: ticketAddress, correlationIds: [] })).rejects.toThrow(/does not belong to this ticket key/)
    await expect(wallet.prepareSpendOfOutpoint({ key: ticketKey(), outpoint: { txid: funding.txid, vout: 9 }, records: [{ kind: 'T', payload: Uint8Array.of(1) }], markerAddress: ticketAddress, correlationIds: [] })).rejects.toThrow(/does not belong/)
    await expect(wallet.prepareSpendOfOutpoint({ key: ticketKey(), outpoint: { txid: funding.txid, vout: 0 }, records: [], markerAddress: ticketAddress, correlationIds: [] })).rejects.toThrow(/At least one/)
  })

  it('lets the network decide: a second spend of the same output is rolled back as a conflict', async () => {
    const { wallet, chain, key, ticketAddress, funding } = await fundedTicket()
    await wallet.flush()
    const first = await wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(1) }], markerAddress: ticketAddress, correlationIds: ['a'] })
    await wallet.flush()
    const second = await wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: Uint8Array.of(2) }], markerAddress: ticketAddress, correlationIds: ['b'] })
    const flushed = await wallet.flush()
    expect(flushed.rolledBack.map(entry => ({ txid: entry.txid, status: entry.status, ids: entry.correlationIds }))).toEqual([{ txid: second.txid, status: 'conflict', ids: ['b'] }])
    expect(chain.spenderOf(funding.txid, 0)).toBe(first.txid)
  })

  it('says so when the funding is too small to pay the fee', async () => {
    const { wallet, key, ticketAddress, funding } = await fundedTicket(1)
    await expect(wallet.prepareSpendOfOutpoint({ key, outpoint: { txid: funding.txid, vout: 0 }, records: [{ kind: 'T', payload: new Uint8Array(40_000) }], markerAddress: ticketAddress, correlationIds: [] })).rejects.toThrow(/too small/)
  })
})
