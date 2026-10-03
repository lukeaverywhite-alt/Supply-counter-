/**
 * FakeChain: a deterministic in-memory BSV testnet for tests. It validates what a node would
 * (inputs exist and are unspent, fee rate, P2PKH signatures), keeps a mempool and blocks, indexes
 * address histories, and can inject the failure modes the real WhatsOnChain API shows.
 *
 * Several DeviceWallets (one per simulated device) can share one FakeChain.
 */

import { Hash, LockingScript, P2PKH, PrivateKey, Spend, Transaction, UnlockingScript, Utils } from '@bsv/sdk'
import { assertTestnetAddress, computeTxid } from './codec'
import type { BroadcastOutcome, ChainApi, ChainHistoryItem, ChainHistoryPage, ChainUtxo } from './types'
import { outpointKey } from './utxo'
import { ChainApiError } from './woc'

const DEFAULT_START_HEIGHT = 100
const DEFAULT_HISTORY_LIMIT = 1000
const TESTNET_P2PKH_PREFIX = [0x6f]
const P2PKH_SCRIPT_PATTERN = /^76a914([0-9a-f]{40})88ac$/

/**
 * Outcomes failNextBroadcasts can inject. Besides the real outcome classes:
 * - 'ambiguousButAccepted': the transaction IS accepted into the mempool, but the call reports
 *   'ambiguous' (a timeout after the node took it). Tests exactly-once rebroadcast.
 * - 'accepted': the call reports success but the transaction is silently lost and never
 *   reaches the mempool (tests recovery from phantom change coins).
 * - 'ambiguous' / 'conflict' / 'fee-too-low' / 'rejected': reported without accepting.
 */
export type InjectedBroadcastOutcome = BroadcastOutcome['status'] | 'ambiguousButAccepted'

export type FakeChainOptions = {
  /** Minimum relay fee; broadcasts paying less are 'fee-too-low'. Default 1 sat/kB. */
  minFeeSatPerKb?: number
  /** Verify every input's unlocking script. Default true. */
  verifyScripts?: boolean
  /** Height of the last block before the first mine(). Default 100. */
  startHeight?: number
}

/** A stored transaction as tests see it. height 0 = mempool. */
export type FakeChainTx = { txid: string; hex: string; height: number }

type StoredTx = FakeChainTx & { tx: Transaction; sequence: number }

export type FakeChainRequestCounts = {
  unspent: number
  txHex: number
  confirmedHistory: number
  unconfirmedHistory: number
  broadcast: number
  tipHeight: number
}

/** A random BSV testnet P2PKH address nobody will ever spend from (for recipients and anchors in tests). */
export function fakeAddress(): string {
  return PrivateKey.fromRandom().toAddress('testnet')
}

function p2pkhAddressOf(lockingScript: LockingScript): string | undefined {
  const match = P2PKH_SCRIPT_PATTERN.exec(lockingScript.toHex())
  return match ? Utils.toBase58Check(Utils.toArray(match[1], 'hex'), TESTNET_P2PKH_PREFIX) : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FakeChain implements ChainApi {
  readonly network = 'testnet' as const

  /**
   * Mimic WhatsOnChain's index lag: unspent() keeps listing outputs spent by mempool
   * transactions and omits outputs created by mempool transactions, until they are mined.
   */
  unspentLag = false
  /** List every outpoint twice from unspent(): first as unconfirmed, then with its real height. */
  duplicateUnspent = false
  /** The next N txHex() calls answer 404 even for known transactions (index lag). */
  txHexNotFoundCount = 0
  /** What tipTime() reports: the chain's own time as a test sets it (unknown until then). */
  blockTime?: Date

  readonly requestCount: FakeChainRequestCounts = { unspent: 0, txHex: 0, confirmedHistory: 0, unconfirmedHistory: 0, broadcast: 0, tipHeight: 0 }

  private readonly minFeeSatPerKb: number
  private readonly verifyScripts: boolean
  private tip: number
  private sequence = 0
  private fundingNonce = 0
  private readonly txs = new Map<string, StoredTx>()
  /** outpoint -> txid of the transaction that spends it */
  private readonly spentBy = new Map<string, string>()
  /** address -> txids touching it (as an output or a spent input), in first-seen order */
  private readonly history = new Map<string, Set<string>>()
  private readonly injected: InjectedBroadcastOutcome[] = []

  constructor(options: FakeChainOptions = {}) {
    this.minFeeSatPerKb = options.minFeeSatPerKb ?? 1
    this.verifyScripts = options.verifyScripts ?? true
    this.tip = options.startHeight ?? DEFAULT_START_HEIGHT
  }

  // ---------------------------------------------------------------- test controls

  /**
   * Creates a transaction paying `satoshis` to `address` out of thin air (its single input
   * references a made-up outpoint). It goes to the mempool, or into a new block of its own
   * when `confirmed` is set. Returns the txid.
   */
  fund(address: string, satoshis: number, options: { confirmed?: boolean } = {}): string {
    assertTestnetAddress(address)
    if (!Number.isSafeInteger(satoshis) || satoshis < 1) throw new Error(`Cannot fund ${satoshis} satoshis.`)
    this.fundingNonce += 1
    const tx = new Transaction()
    tx.addInput({
      sourceTXID: Utils.toHex(Hash.sha256(`fake-chain-funding:${this.fundingNonce}`, 'utf8')),
      sourceOutputIndex: 0,
      unlockingScript: UnlockingScript.fromHex('51'),
      sequence: 0xffffffff,
    })
    tx.addOutput({ lockingScript: new P2PKH().lock(address), satoshis })
    const stored = this.store(tx, tx.toHex())
    if (options.confirmed) {
      this.tip += 1
      stored.height = this.tip
    }
    return stored.txid
  }

  /** Confirms every mempool transaction in a new block. Returns the new height. */
  mine(): number {
    this.tip += 1
    for (const stored of this.txs.values()) if (stored.height === 0) stored.height = this.tip
    return this.tip
  }

  /** Makes the next `count` broadcasts return `outcome` (see InjectedBroadcastOutcome). */
  failNextBroadcasts(outcome: InjectedBroadcastOutcome, count = 1): void {
    for (let index = 0; index < count; index += 1) this.injected.push(outcome)
  }

  /** Drops any injected outcomes that have not been consumed yet. */
  clearInjectedFailures(): void {
    this.injected.length = 0
  }

  /** Requests answered so far, all kinds together. */
  totalRequests(): number {
    return Object.values(this.requestCount).reduce((total, count) => total + count, 0)
  }

  /** A copy of the request counts now, to measure what a later stretch of work cost with requestsSince(). */
  requestSnapshot(): FakeChainRequestCounts {
    return { ...this.requestCount }
  }

  /** The requests made since a requestSnapshot(), by kind and in total. */
  requestsSince(snapshot: FakeChainRequestCounts): FakeChainRequestCounts & { total: number } {
    const difference = Object.fromEntries(Object.entries(this.requestCount).map(([kind, count]) => [kind, count - snapshot[kind as keyof FakeChainRequestCounts]])) as FakeChainRequestCounts
    return { ...difference, total: Object.values(difference).reduce((total, count) => total + count, 0) }
  }

  resetRequestCounts(): void {
    for (const kind of Object.keys(this.requestCount) as Array<keyof FakeChainRequestCounts>) this.requestCount[kind] = 0
  }

  /** Every stored transaction in the order it reached the chain. */
  transactions(): FakeChainTx[] {
    return [...this.txs.values()].sort((left, right) => left.sequence - right.sequence).map(({ txid, hex, height }) => ({ txid, hex, height }))
  }

  get(txid: string): FakeChainTx | undefined {
    const stored = this.txs.get(txid.toLowerCase())
    return stored ? { txid: stored.txid, hex: stored.hex, height: stored.height } : undefined
  }

  /** Txids waiting in the mempool, oldest first. */
  mempool(): string[] {
    return this.transactions().filter((tx) => tx.height === 0).map((tx) => tx.txid)
  }

  /** The txid spending an outpoint, if any. */
  spenderOf(txid: string, vout: number): string | undefined {
    return this.spentBy.get(outpointKey({ txid, vout }))
  }

  /** True unspent total for an address, ignoring the lag/duplicate simulation flags. */
  balanceOf(address: string): number {
    return this.outputsTo(address)
      .filter((output) => !this.spentBy.has(outpointKey(output)))
      .reduce((total, output) => total + output.satoshis, 0)
  }

  // ---------------------------------------------------------------- ChainApi

  async unspent(address: string): Promise<ChainUtxo[]> {
    this.requestCount.unspent += 1
    assertTestnetAddress(address)
    const utxos: ChainUtxo[] = []
    for (const output of this.outputsTo(address)) {
      const spender = this.spentBy.get(outpointKey(output))
      if (this.unspentLag) {
        if (output.height === 0) continue
        if (spender !== undefined && (this.txs.get(spender)?.height ?? 0) > 0) continue
      } else if (spender !== undefined) {
        continue
      }
      if (this.duplicateUnspent) utxos.push({ ...output, height: 0 })
      utxos.push({ ...output })
    }
    return utxos
  }

  async txHex(txid: string): Promise<string> {
    this.requestCount.txHex += 1
    const path = `/tx/${txid}/hex`
    if (this.txHexNotFoundCount > 0) {
      this.txHexNotFoundCount -= 1
      throw new ChainApiError(`FakeChain: ${txid} not found (injected).`, { status: 404, path })
    }
    const stored = this.txs.get(txid.toLowerCase())
    if (!stored) throw new ChainApiError(`FakeChain: ${txid} not found.`, { status: 404, path })
    return stored.hex
  }

  async confirmedHistory(address: string, options: { fromHeight?: number; token?: string; limit?: number } = {}): Promise<ChainHistoryPage> {
    this.requestCount.confirmedHistory += 1
    assertTestnetAddress(address)
    const limit = options.limit ?? DEFAULT_HISTORY_LIMIT
    const offset = options.token === undefined ? 0 : Number(options.token)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ChainApiError(`FakeChain: bad page token "${options.token}".`, { status: 400 })
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ChainApiError(`FakeChain: bad limit ${limit}.`, { status: 400 })

    const all: ChainHistoryItem[] = this.touching(address)
      .filter((stored) => stored.height > 0 && (options.fromHeight === undefined || stored.height >= options.fromHeight))
      .map((stored) => ({ txid: stored.txid, height: stored.height }))
      .sort((left, right) => left.height - right.height || left.txid.localeCompare(right.txid))
    const items = all.slice(offset, offset + limit)
    const nextOffset = offset + items.length
    return nextOffset < all.length ? { items, nextToken: String(nextOffset) } : { items }
  }

  async unconfirmedHistory(address: string): Promise<string[]> {
    this.requestCount.unconfirmedHistory += 1
    assertTestnetAddress(address)
    return this.touching(address)
      .filter((stored) => stored.height === 0)
      .map((stored) => stored.txid)
  }

  async broadcast(txHex: string): Promise<BroadcastOutcome> {
    this.requestCount.broadcast += 1
    const injected = this.injected.shift()
    const hex = txHex.trim().toLowerCase()

    switch (injected) {
      case undefined:
        return this.accept(hex)
      case 'ambiguousButAccepted': {
        const outcome = this.accept(hex)
        return outcome.status === 'accepted' ? { status: 'ambiguous', message: 'FakeChain: timed out (but the transaction was accepted).' } : outcome
      }
      case 'accepted': {
        let txid: string
        try {
          txid = computeTxid(hex)
        } catch (error) {
          return { status: 'rejected', message: errorMessage(error) }
        }
        return { status: 'accepted', txid, alreadyKnown: false }
      }
      default:
        return { status: injected, message: `FakeChain: injected ${injected}.` }
    }
  }

  async tipHeight(): Promise<number> {
    this.requestCount.tipHeight += 1
    return this.tip
  }

  async tipTime(): Promise<string | undefined> {
    return this.blockTime?.toISOString()
  }

  // ---------------------------------------------------------------- internals

  /** Node-like acceptance: parse, dedupe, inputs, fee, scripts; then index and add to the mempool. */
  private accept(hex: string): BroadcastOutcome {
    let tx: Transaction
    try {
      tx = Transaction.fromHex(hex)
    } catch (error) {
      return { status: 'rejected', message: `FakeChain: malformed transaction (${errorMessage(error)}).` }
    }
    const txid = tx.id('hex')
    if (this.txs.has(txid)) return { status: 'accepted', txid, alreadyKnown: true }
    if (tx.inputs.length === 0 || tx.outputs.length === 0) return { status: 'rejected', message: 'FakeChain: bad-txns-vin-empty or vout-empty.' }

    const seen = new Set<string>()
    let inputTotal = 0
    for (const input of tx.inputs) {
      const sourceTxid = input.sourceTXID ?? ''
      const key = outpointKey({ txid: sourceTxid, vout: input.sourceOutputIndex })
      if (seen.has(key)) return { status: 'rejected', message: 'FakeChain: bad-txns-inputs-duplicate.' }
      seen.add(key)
      const source = this.txs.get(sourceTxid)
      const sourceOutput = source?.tx.outputs[input.sourceOutputIndex]
      if (!source || !sourceOutput) return { status: 'conflict', message: `FakeChain: Missing inputs (${key}).` }
      const spender = this.spentBy.get(key)
      if (spender !== undefined) return { status: 'conflict', message: `FakeChain: txn-mempool-conflict (${key} already spent by ${spender}).` }
      inputTotal += sourceOutput.satoshis ?? 0
    }

    const outputTotal = tx.outputs.reduce((total, output) => total + (output.satoshis ?? 0), 0)
    if (outputTotal > inputTotal) return { status: 'rejected', message: 'FakeChain: bad-txns-in-belowout.' }
    const size = hex.length / 2
    const requiredFee = Math.ceil((size * this.minFeeSatPerKb) / 1000)
    if (inputTotal - outputTotal < requiredFee) {
      return { status: 'fee-too-low', message: `FakeChain: min relay fee not met (${inputTotal - outputTotal} < ${requiredFee}).` }
    }

    if (this.verifyScripts) {
      const failure = this.verifyInputs(tx)
      if (failure) return { status: 'rejected', message: `FakeChain: mandatory-script-verify-flag-failed (${failure}).` }
    }

    tx.inputs.forEach((input) => this.spentBy.set(outpointKey({ txid: input.sourceTXID ?? '', vout: input.sourceOutputIndex }), txid))
    this.store(tx, hex)
    return { status: 'accepted', txid, alreadyKnown: false }
  }

  /** Runs every input's unlocking script against the output it spends. Returns a reason on failure. */
  private verifyInputs(tx: Transaction): string | undefined {
    for (let index = 0; index < tx.inputs.length; index += 1) {
      const input = tx.inputs[index]
      const sourceTxid = input.sourceTXID ?? ''
      const sourceOutput = this.txs.get(sourceTxid)?.tx.outputs[input.sourceOutputIndex]
      if (!sourceOutput || !input.unlockingScript) return `input ${index} has nothing to verify`
      try {
        const spend = new Spend({
          sourceTXID: sourceTxid,
          sourceOutputIndex: input.sourceOutputIndex,
          sourceSatoshis: sourceOutput.satoshis ?? 0,
          lockingScript: sourceOutput.lockingScript,
          transactionVersion: tx.version,
          otherInputs: [],
          allInputs: tx.inputs,
          outputs: tx.outputs,
          unlockingScript: input.unlockingScript,
          inputSequence: input.sequence ?? 0xffffffff,
          inputIndex: index,
          lockTime: tx.lockTime,
        })
        if (!spend.validate()) return `input ${index} script evaluated false`
      } catch (error) {
        return `input ${index}: ${errorMessage(error)}`
      }
    }
    return undefined
  }

  /** Records a transaction in the mempool and indexes the addresses it touches. */
  private store(tx: Transaction, hex: string): StoredTx {
    this.sequence += 1
    const stored: StoredTx = { txid: tx.id('hex'), hex, height: 0, tx, sequence: this.sequence }
    this.txs.set(stored.txid, stored)
    const addresses = new Set<string>()
    for (const output of tx.outputs) {
      const address = p2pkhAddressOf(output.lockingScript)
      if (address) addresses.add(address)
    }
    for (const input of tx.inputs) {
      const sourceOutput = this.txs.get(input.sourceTXID ?? '')?.tx.outputs[input.sourceOutputIndex]
      const address = sourceOutput ? p2pkhAddressOf(sourceOutput.lockingScript) : undefined
      if (address) addresses.add(address)
    }
    for (const address of addresses) {
      const txids = this.history.get(address) ?? new Set<string>()
      txids.add(stored.txid)
      this.history.set(address, txids)
    }
    return stored
  }

  private touching(address: string): StoredTx[] {
    const txids = this.history.get(address) ?? new Set<string>()
    return [...txids].flatMap((txid) => {
      const stored = this.txs.get(txid)
      return stored ? [stored] : []
    })
  }

  /** Every P2PKH output paying the address, spent or not. */
  private outputsTo(address: string): ChainUtxo[] {
    const outputs: ChainUtxo[] = []
    for (const stored of this.touching(address)) {
      stored.tx.outputs.forEach((output, vout) => {
        if (p2pkhAddressOf(output.lockingScript) === address) {
          outputs.push({ txid: stored.txid, vout, satoshis: output.satoshis ?? 0, height: stored.height })
        }
      })
    }
    return outputs
  }
}
