import { P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'
import { decodeArgusRecords, encodeArgusRecordScript } from './codec'
import { FakeChain, fakeAddress } from './fakeChain'
import { ChainApiError } from './woc'

/** Signs a spend of one output with the SDK directly, bypassing DeviceWallet. */
async function spend(
  chain: FakeChain,
  key: PrivateKey,
  source: { txid: string; vout: number },
  outputs: Array<{ address: string; satoshis: number }>,
  options: { feeSatPerKb?: number; signer?: PrivateKey; withRecord?: boolean } = {},
): Promise<Transaction> {
  const sourceTx = Transaction.fromHex(await chain.txHex(source.txid))
  const tx = new Transaction()
  tx.addInput({ sourceTransaction: sourceTx, sourceOutputIndex: source.vout, unlockingScriptTemplate: new P2PKH().unlock(options.signer ?? key) })
  if (options.withRecord) tx.addOutput({ lockingScript: encodeArgusRecordScript({ kind: 'E', payload: Uint8Array.of(1, 2, 3) }), satoshis: 0 })
  for (const output of outputs) tx.addOutput({ lockingScript: new P2PKH().lock(output.address), satoshis: output.satoshis })
  tx.addOutput({ lockingScript: new P2PKH().lock(key.toAddress('testnet')), change: true })
  await tx.fee(new SatoshisPerKilobyte(options.feeSatPerKb ?? 1))
  await tx.sign()
  return tx
}

describe('FakeChain basics', () => {
  it('funds into the mempool or straight into a block', async () => {
    const chain = new FakeChain()
    const address = fakeAddress()
    const pending = chain.fund(address, 1000)
    const confirmed = chain.fund(address, 2000, { confirmed: true })

    expect(chain.get(pending)?.height).toBe(0)
    expect(chain.get(confirmed)?.height).toBe(101)
    expect(await chain.tipHeight()).toBe(101)
    // the chain's time is whatever a test sets, and unknown until then
    expect(await chain.tipTime()).toBeUndefined()
    chain.blockTime = new Date('2026-10-09T00:00:00.000Z')
    expect(await chain.tipTime()).toBe('2026-10-09T00:00:00.000Z')
    chain.blockTime = undefined
    expect(chain.mempool()).toEqual([pending])
    expect(await chain.unspent(address)).toEqual([
      { txid: pending, vout: 0, satoshis: 1000, height: 0 },
      { txid: confirmed, vout: 0, satoshis: 2000, height: 101 },
    ])
    expect(chain.balanceOf(address)).toBe(3000)
    expect(chain.fund(address, 1000)).not.toBe(pending) // identical funding still gets a fresh txid
  })

  it('mines the whole mempool into a new block', async () => {
    const chain = new FakeChain({ startHeight: 500 })
    const txid = chain.fund(fakeAddress(), 10)
    expect(chain.mine()).toBe(501)
    expect(chain.get(txid)?.height).toBe(501)
    expect(chain.mempool()).toEqual([])
    expect(chain.mine()).toBe(502) // empty blocks are fine
  })

  it('serves hex, 404s unknown txids and can inject index lag', async () => {
    const chain = new FakeChain()
    const txid = chain.fund(fakeAddress(), 10)
    expect(Transaction.fromHex(await chain.txHex(txid)).id('hex')).toBe(txid)
    await expect(chain.txHex('0'.repeat(64))).rejects.toMatchObject({ name: 'ChainApiError', status: 404 })

    chain.txHexNotFoundCount = 1
    await expect(chain.txHex(txid)).rejects.toBeInstanceOf(ChainApiError)
    await expect(chain.txHex(txid)).resolves.toBe(chain.get(txid)?.hex)
    expect(chain.requestCount.txHex).toBe(4)
  })

  it('counts every request, in total and as the difference between two moments, so a test can state a request budget', async () => {
    const chain = new FakeChain()
    const address = fakeAddress()
    chain.fund(address, 10, { confirmed: true })
    await chain.confirmedHistory(address); await chain.unconfirmedHistory(address); await chain.tipHeight()
    expect(chain.totalRequests()).toBe(3)
    const before = chain.requestSnapshot()
    await chain.unspent(address); await chain.unspent(address); await chain.confirmedHistory(address)
    expect(chain.requestsSince(before)).toEqual({ unspent: 2, txHex: 0, confirmedHistory: 1, unconfirmedHistory: 0, broadcast: 0, tipHeight: 0, total: 3 })
    chain.resetRequestCounts()
    expect(chain.totalRequests()).toBe(0)
    expect(chain.requestCount).toEqual({ unspent: 0, txHex: 0, confirmedHistory: 0, unconfirmedHistory: 0, broadcast: 0, tipHeight: 0 })
  })
})

describe('FakeChain broadcast validation', () => {
  it('accepts a valid spend, marks the input spent and indexes every address touched', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const owner = key.toAddress('testnet')
    const anchor = fakeAddress()
    const funding = chain.fund(owner, 5000, { confirmed: true })

    const tx = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: anchor, satoshis: 1 }], { withRecord: true })
    await expect(chain.broadcast(tx.toHex())).resolves.toEqual({ status: 'accepted', txid: tx.id('hex'), alreadyKnown: false })

    expect(chain.spenderOf(funding, 0)).toBe(tx.id('hex'))
    expect(await chain.unconfirmedHistory(anchor)).toEqual([tx.id('hex')])
    expect(await chain.unconfirmedHistory(owner)).toEqual([tx.id('hex')]) // as spender and change receiver
    expect(decodeArgusRecords(chain.get(tx.id('hex'))?.hex ?? '')).toHaveLength(1)
    expect((await chain.unspent(owner)).map((utxo) => utxo.txid)).toEqual([tx.id('hex')])
  })

  it('reports an already-known transaction as accepted', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const funding = chain.fund(key.toAddress('testnet'), 5000)
    const hex = (await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }])).toHex()
    await chain.broadcast(hex)
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'accepted', alreadyKnown: true })
    expect(chain.transactions()).toHaveLength(2)
  })

  it('reports a double spend and a missing input as conflicts', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const funding = chain.fund(key.toAddress('testnet'), 5000)
    const first = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }])
    const second = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 200 }])
    await chain.broadcast(first.toHex())
    await expect(chain.broadcast(second.toHex())).resolves.toMatchObject({ status: 'conflict', message: expect.stringMatching(/mempool-conflict/) })

    const other = new FakeChain()
    await expect(other.broadcast(first.toHex())).resolves.toMatchObject({ status: 'conflict', message: expect.stringMatching(/Missing inputs/) })
  })

  it('enforces the minimum fee rate', async () => {
    const chain = new FakeChain({ minFeeSatPerKb: 5 })
    const key = PrivateKey.fromRandom()
    const funding = chain.fund(key.toAddress('testnet'), 5000)
    const cheap = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }], { feeSatPerKb: 1 })
    await expect(chain.broadcast(cheap.toHex())).resolves.toMatchObject({ status: 'fee-too-low' })
    const fair = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }], { feeSatPerKb: 5 })
    await expect(chain.broadcast(fair.toHex())).resolves.toMatchObject({ status: 'accepted' })
  })

  it('rejects a spend signed by the wrong key and malformed hex', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const funding = chain.fund(key.toAddress('testnet'), 5000)
    const forged = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }], { signer: PrivateKey.fromRandom() })
    await expect(chain.broadcast(forged.toHex())).resolves.toMatchObject({ status: 'rejected', message: expect.stringMatching(/script/) })
    expect(chain.spenderOf(funding, 0)).toBeUndefined()
    await expect(chain.broadcast('00ff')).resolves.toMatchObject({ status: 'rejected' })
  })

  it('injects broadcast outcomes in order', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const funding = chain.fund(key.toAddress('testnet'), 5000)
    const hex = (await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }])).toHex()
    const txid = Transaction.fromHex(hex).id('hex')

    chain.failNextBroadcasts('rejected')
    chain.failNextBroadcasts('ambiguous', 2)
    chain.failNextBroadcasts('accepted')
    chain.failNextBroadcasts('ambiguousButAccepted')
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'rejected' })
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'ambiguous' })
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'ambiguous' })
    expect(chain.get(txid)).toBeUndefined()
    // 'accepted' injection: claims success, but the transaction is lost.
    await expect(chain.broadcast(hex)).resolves.toEqual({ status: 'accepted', txid, alreadyKnown: false })
    expect(chain.get(txid)).toBeUndefined()
    // 'ambiguousButAccepted': the node took it, the caller heard nothing useful.
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'ambiguous' })
    expect(chain.get(txid)?.height).toBe(0)
    await expect(chain.broadcast(hex)).resolves.toMatchObject({ status: 'accepted', alreadyKnown: true })
    expect(chain.requestCount.broadcast).toBe(6)
  })
})

describe('FakeChain indexer simulation', () => {
  it('unspentLag keeps mempool-spent outputs and hides mempool-created ones until mined', async () => {
    const chain = new FakeChain()
    const key = PrivateKey.fromRandom()
    const owner = key.toAddress('testnet')
    const funding = chain.fund(owner, 5000, { confirmed: true })
    const tx = await spend(chain, key, { txid: funding, vout: 0 }, [{ address: fakeAddress(), satoshis: 100 }])
    await chain.broadcast(tx.toHex())

    chain.unspentLag = true
    expect((await chain.unspent(owner)).map((utxo) => utxo.txid)).toEqual([funding])
    chain.mine()
    expect((await chain.unspent(owner)).map((utxo) => utxo.txid)).toEqual([tx.id('hex')])
    chain.unspentLag = false
    expect((await chain.unspent(owner)).map((utxo) => utxo.txid)).toEqual([tx.id('hex')])
  })

  it('duplicateUnspent lists each outpoint twice, unconfirmed copy first', async () => {
    const chain = new FakeChain()
    const address = fakeAddress()
    const txid = chain.fund(address, 700, { confirmed: true })
    chain.duplicateUnspent = true
    expect(await chain.unspent(address)).toEqual([
      { txid, vout: 0, satoshis: 700, height: 0 },
      { txid, vout: 0, satoshis: 700, height: 101 },
    ])
  })
})

describe('FakeChain history', () => {
  it('pages confirmed history ascending with opaque tokens and honours fromHeight', async () => {
    const chain = new FakeChain()
    const address = fakeAddress()
    const confirmed = [1, 2, 3, 4, 5].map((n) => chain.fund(address, n, { confirmed: true })) // heights 101..105
    const unconfirmed = chain.fund(address, 99)

    const page1 = await chain.confirmedHistory(address, { limit: 2 })
    expect(page1.items).toEqual([
      { txid: confirmed[0], height: 101 },
      { txid: confirmed[1], height: 102 },
    ])
    expect(page1.nextToken).toBeDefined()
    const page2 = await chain.confirmedHistory(address, { limit: 2, token: page1.nextToken })
    expect(page2.items.map((item) => item.height)).toEqual([103, 104])
    const page3 = await chain.confirmedHistory(address, { limit: 2, token: page2.nextToken })
    expect(page3).toEqual({ items: [{ txid: confirmed[4], height: 105 }] })

    const recent = await chain.confirmedHistory(address, { fromHeight: 104 })
    expect(recent).toEqual({ items: [{ txid: confirmed[3], height: 104 }, { txid: confirmed[4], height: 105 }] })
    expect(await chain.unconfirmedHistory(address)).toEqual([unconfirmed])
    expect(await chain.confirmedHistory(fakeAddress())).toEqual({ items: [] })
  })

  it('orders several transactions in one block by txid', async () => {
    const chain = new FakeChain()
    const address = fakeAddress()
    const txids = [chain.fund(address, 1), chain.fund(address, 2), chain.fund(address, 3)]
    const height = chain.mine()
    const { items } = await chain.confirmedHistory(address)
    expect(items).toEqual([...txids].sort().map((txid) => ({ txid, height })))
  })

  it('rejects a bad page token', async () => {
    const chain = new FakeChain()
    await expect(chain.confirmedHistory(fakeAddress(), { token: 'nope' })).rejects.toMatchObject({ status: 400 })
  })
})
