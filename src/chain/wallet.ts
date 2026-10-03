/**
 * DeviceWallet: one device's own BSV TESTNET key and its local-first view of its coins.
 *
 * Adapted from spell-forge src/bsv (MIT): write-record.ts and send-sats.ts (building and
 * signing with the SDK), pending-spends.ts (never reselect an outpoint our own unconfirmed
 * transaction already spends, because WoC keeps listing it for a while) and keys.ts
 * (testnet key handling).
 *
 * Lifecycle of a transaction:
 *   prepare*()  selects coins, builds and signs, and in ONE state save marks the inputs spent,
 *               records the change coin and queues the transaction as pending. Nothing is sent.
 *   flush()     broadcasts pending transactions in creation order, exactly once each: an
 *               ambiguous answer keeps the same bytes for a later retry; a definitive refusal
 *               rolls the transaction (and everything built on its outputs) back.
 *
 * Because change coins carry their parent's hex, several prepares can be chained before any
 * broadcast or block.
 */

import { P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction, Utils, type LockingScript } from '@bsv/sdk'
import { anchorLockingScript } from '../blockchain/anchor'
import { assertTestnetAddress, assertValidRecordBatch, computeTxid, encodeArgusRecordScript } from './codec'
import type {
  ArgusRecord,
  BroadcastOutcome,
  ChainApi,
  RolledBackTx,
  WalletBalance,
  WalletCoin,
  WalletFlushResult,
  WalletPendingTx,
  WalletState,
  WalletStateStore,
} from './types'
import { dedupeUtxos, outpointKey } from './utxo'

/** Proven on real testnet by spell-forge: a 13 KB transaction paid 14 sat and confirmed. */
export const DEFAULT_FEE_SAT_PER_KB = 1
/** Rates tried after successive fee-too-low rejections. */
const FEE_RATE_STEPS = [10, 50] as const
export const MAX_FEE_SAT_PER_KB = 50
const RECENT_TX_LIMIT = 50
const ANCHOR_OUTPUT_SATOSHIS = 1

const TESTNET_WIF_PREFIX = 0xef
const MAINNET_WIF_PREFIX = 0x80

/** A signed P2PKH input as the SDK's fee model sizes it: outpoint 36 + sequence 4 + script length 1 + script 108. */
const P2PKH_INPUT_BYTES = 149
const P2PKH_LOCKING_SCRIPT_BYTES = 25

export type DeviceWalletOptions = {
  /** Base fee rate; a persisted raise after fee-too-low takes precedence when higher. */
  feeSatPerKb?: number
  /** ISO timestamp source, injectable for deterministic tests. */
  now?: () => string
}

/** Thrown by prepare* when the wallet cannot cover the outputs plus fee. */
export class InsufficientFundsError extends Error {
  readonly address: string
  readonly spendable: number
  readonly needed: number

  constructor(address: string, spendable: number, needed: number) {
    super(
      `This device's testnet wallet ${address} has ${spendable} spendable satoshis but needs about ${needed}. ` +
        `Send testnet coins to ${address} from a BSV testnet faucet, then try again.`,
    )
    this.name = 'InsufficientFundsError'
    this.address = address
    this.spendable = spendable
    this.needed = needed
  }
}

type PlannedOutput = { lockingScript: LockingScript; satoshis: number }

type CoinSelection =
  | { ok: true; coins: WalletCoin[] }
  | { ok: false; spendable: number; needed: number }

/** Decodes a WIF, refusing anything that is not a compressed BSV testnet key. */
function testnetKeyFromWif(wif: string): PrivateKey {
  const trimmed = typeof wif === 'string' ? wif.trim() : ''
  let decoded: ReturnType<typeof Utils.fromBase58Check>
  try {
    decoded = Utils.fromBase58Check(trimmed)
  } catch {
    throw new Error('That is not a valid WIF private key.')
  }
  const { prefix, data } = decoded
  if (!Array.isArray(prefix) || !Array.isArray(data) || prefix.length !== 1) {
    throw new Error('That is not a valid WIF private key.')
  }
  if (prefix[0] === MAINNET_WIF_PREFIX) {
    throw new Error('That is a MAINNET private key. A.R.G.U.S. only uses BSV testnet keys (a testnet WIF starts with "c").')
  }
  if (prefix[0] !== TESTNET_WIF_PREFIX) throw new Error('That is not a BSV testnet private key.')
  if (data.length !== 33 || data[32] !== 0x01) throw new Error('Only compressed testnet WIF keys are supported.')
  return PrivateKey.fromWif(trimmed)
}

function assertFeeRate(rate: number): void {
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error(`Fee rate must be a positive number of sat/kB, not ${String(rate)}.`)
  }
}

/** The next rung of the 1 -> 10 -> 50 sat/kB ladder, never lower than the current rate. */
function raisedFeeRate(current: number): number {
  const step = FEE_RATE_STEPS.find((rate) => rate > current)
  return step ?? Math.max(current, MAX_FEE_SAT_PER_KB)
}

function varIntSize(value: number): number {
  if (value < 0xfd) return 1
  if (value <= 0xffff) return 3
  if (value <= 0xffffffff) return 5
  return 9
}

/** Serialized size the SDK's SatoshisPerKilobyte model will compute for these inputs and outputs. */
function estimateTxBytes(inputCount: number, outputScriptLengths: number[]): number {
  let size = 4 + varIntSize(inputCount) + inputCount * P2PKH_INPUT_BYTES
  size += varIntSize(outputScriptLengths.length)
  for (const length of outputScriptLengths) size += 8 + varIntSize(length) + length
  return size + 4
}

/** Same rounding as SatoshisPerKilobyte.computeFee so our estimate matches the SDK. */
function feeFor(bytes: number, rate: number): number {
  return Math.ceil((bytes / 1000) * rate)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** Largest first; ties prefer confirmed coins, then a stable outpoint order. */
function largestFirst(left: WalletCoin, right: WalletCoin): number {
  return right.satoshis - left.satoshis || right.height - left.height || outpointKey(left).localeCompare(outpointKey(right))
}

function selectCoins(coins: WalletCoin[], outputs: PlannedOutput[], rate: number): CoinSelection {
  const candidates = coins.filter((coin) => !coin.spentBy).sort(largestFirst)
  const outputTotal = sum(outputs.map((output) => output.satoshis))
  // The SDK sizes the fee with the change output present, even when it later drops it.
  const scriptLengths = [...outputs.map((output) => output.lockingScript.toBinary().length), P2PKH_LOCKING_SCRIPT_BYTES]
  const feeWith = (inputCount: number) => feeFor(estimateTxBytes(inputCount, scriptLengths), rate)

  const selected: WalletCoin[] = []
  let total = 0
  for (const coin of candidates) {
    selected.push(coin)
    total += coin.satoshis
    // +1 so there is at least a 1-satoshi change output to chain the next spend from.
    if (total >= outputTotal + feeWith(selected.length) + 1) return { ok: true, coins: selected }
  }
  // An exact fit (no change) is still a valid transaction.
  if (selected.length > 0 && total >= outputTotal + feeWith(selected.length)) return { ok: true, coins: selected }
  return { ok: false, spendable: total, needed: outputTotal + feeWith(Math.max(1, candidates.length)) }
}

function clonePending(tx: WalletPendingTx): WalletPendingTx {
  return { ...tx, correlationIds: [...tx.correlationIds] }
}

function cloneState(state: WalletState): WalletState {
  return {
    ...state,
    coins: state.coins.map((coin) => ({ ...coin })),
    pending: state.pending.map(clonePending),
    recent: state.recent.map((entry) => ({ ...entry })),
  }
}

function withoutSpentBy(coin: WalletCoin): WalletCoin {
  const copy = { ...coin }
  delete copy.spentBy
  return copy
}

function balanceOf(state: WalletState): WalletBalance {
  const unspent = state.coins.filter((coin) => !coin.spentBy)
  const confirmed = sum(unspent.filter((coin) => coin.height > 0).map((coin) => coin.satoshis))
  const unconfirmed = sum(unspent.filter((coin) => coin.height === 0).map((coin) => coin.satoshis))
  return { address: state.address, confirmed, unconfirmed, spendable: confirmed + unconfirmed, pendingBroadcasts: state.pending.length }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Removes a refused pending transaction and every later pending transaction that spends its
 * outputs (directly or through another removed one). Their outputs never existed, so their
 * change coins go; the coins they spent become spendable again.
 */
function rollBack(state: WalletState, rootTxid: string): { next: WalletState; removed: WalletPendingTx[] } {
  const next = cloneState(state)
  const doomed = new Set([rootTxid])
  const rootIndex = next.pending.findIndex((tx) => tx.txid === rootTxid)
  // Children are always created after their parents, so one forward pass is transitive.
  for (const later of next.pending.slice(rootIndex + 1)) {
    const spendsDoomedOutput = next.coins.some((coin) => coin.spentBy === later.txid && doomed.has(coin.txid))
    if (spendsDoomedOutput) doomed.add(later.txid)
  }
  const removed = next.pending.filter((tx) => doomed.has(tx.txid))
  next.pending = next.pending.filter((tx) => !doomed.has(tx.txid))
  next.coins = next.coins
    .filter((coin) => !doomed.has(coin.txid))
    .map((coin) => (coin.spentBy !== undefined && doomed.has(coin.spentBy) ? withoutSpentBy(coin) : coin))
  return { next, removed }
}

/** Moves an accepted transaction from pending to recent. */
function markBroadcast(state: WalletState, txid: string, now: string): WalletState {
  const next = cloneState(state)
  const tx = next.pending.find((entry) => entry.txid === txid)
  if (!tx) return next
  next.pending = next.pending.filter((entry) => entry.txid !== txid)
  next.recent = [{ txid, hex: tx.hex, broadcastAt: now }, ...next.recent.filter((entry) => entry.txid !== txid)].slice(0, RECENT_TX_LIMIT)
  // Inputs of an accepted spend can no longer be rolled back, so their source hex is dead weight.
  next.coins = next.coins.map((coin) => {
    if (coin.spentBy !== txid || coin.sourceTxHex === undefined) return coin
    const copy = { ...coin }
    delete copy.sourceTxHex
    return copy
  })
  return next
}

export class DeviceWallet {
  readonly network = 'testnet' as const
  readonly address: string

  private readonly key: PrivateKey
  private readonly api: ChainApi
  private readonly store: WalletStateStore
  private readonly baseFeeSatPerKb: number
  private readonly now: () => string
  private readonly ownLockingScriptHex: string

  /** Last committed state. Never mutated in place: every change clones, saves, then swaps. */
  private state: WalletState | undefined
  private loading: Promise<WalletState> | undefined
  /** Serializes refresh / prepare / flush so they never interleave within this instance. */
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * Inputs of a transaction the network just called a conflict. The next refresh drops any of
   * them the chain no longer lists, even our own change, so a phantom coin is not reselected forever.
   */
  private readonly suspectOutpoints = new Set<string>()

  private constructor(key: PrivateKey, api: ChainApi, store: WalletStateStore, options: DeviceWalletOptions) {
    this.key = key
    this.address = key.toAddress('testnet')
    this.api = api
    this.store = store
    this.baseFeeSatPerKb = options.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB
    this.now = options.now ?? (() => new Date().toISOString())
    this.ownLockingScriptHex = new P2PKH().lock(this.address).toHex()
  }

  static fromWif(wif: string, api: ChainApi, store: WalletStateStore, options: DeviceWalletOptions = {}): DeviceWallet {
    if (api.network !== 'testnet') throw new Error('Mainnet is disabled: A.R.G.U.S. device wallets only run on BSV testnet.')
    assertFeeRate(options.feeSatPerKb ?? DEFAULT_FEE_SAT_PER_KB)
    return new DeviceWallet(testnetKeyFromWif(wif), api, store, options)
  }

  /** A fresh random testnet WIF (prefix 0xef). */
  static generateWif(): string {
    return PrivateKey.fromRandom().toWif([TESTNET_WIF_PREFIX])
  }

  /** Reconciles the local coin view with the chain's unspent list. */
  refresh(): Promise<WalletBalance> {
    return this.exclusive(async () => balanceOf(await this.refreshState(await this.loadState())))
  }

  // Reads (balance, pending, ownTxHex) skip the queue: they only ever see committed state,
  // so a slow flush never blocks a status display.

  /** Balance from stored state only; no network. */
  async balance(): Promise<WalletBalance> {
    return balanceOf(await this.loadState())
  }

  /**
   * Builds, signs and queues one transaction carrying the records plus a 1-sat anchor output to `anchorAddress` (and to each of
   * `alsoAnchorAddresses`, so a batch of records for several channels shows in each channel's address history). Never broadcasts.
   */
  prepareRecords(records: ArgusRecord[], anchorAddress: string, correlationIds: string[], alsoAnchorAddresses: readonly string[] = []): Promise<WalletPendingTx> {
    return this.exclusive(async () => {
      assertValidRecordBatch(records)
      const anchors = [...new Set([anchorAddress, ...alsoAnchorAddresses])]
      for (const anchor of anchors) assertTestnetAddress(anchor, 'Anchor address')
      if (!Array.isArray(correlationIds) || correlationIds.some((id) => typeof id !== 'string')) {
        throw new Error('correlationIds must be an array of strings.')
      }
      const outputs: PlannedOutput[] = [
        ...records.map((record) => ({ lockingScript: encodeArgusRecordScript(record), satoshis: 0 })),
        ...anchors.map((anchor) => ({ lockingScript: anchorLockingScript(anchor), satoshis: ANCHOR_OUTPUT_SATOSHIS })),
      ]
      return this.prepare('records', outputs, [...correlationIds])
    })
  }

  /** Builds, signs and queues a plain payment. Never broadcasts. */
  prepareTransfer(toAddress: string, satoshis: number): Promise<WalletPendingTx> {
    return this.exclusive(async () => {
      assertTestnetAddress(toAddress, 'Recipient address')
      if (!Number.isSafeInteger(satoshis) || satoshis < 1) {
        throw new Error(`Transfer amount must be a whole number of satoshis, at least 1 (got ${String(satoshis)}).`)
      }
      return this.prepare('transfer', [{ lockingScript: new P2PKH().lock(toAddress), satoshis }], [])
    })
  }

  /**
   * Builds, signs and queues one transaction that spends a single output belonging to ANOTHER key (an admission ticket's
   * funding output, ADR 012), signed with that key: its records (data outputs) and a 1-satoshi output to `markerAddress` (and to
   * each of `alsoMarkAddresses`: a redemption also shows on the unit's anchor), with everything else going back to this wallet as change. The output is not one of this wallet's coins, so it is never
   * selected or reserved here; the network alone decides whether it is still unspent. Never broadcasts.
   */
  prepareSpendOfOutpoint(spend: { key: PrivateKey; outpoint: { txid: string; vout: number }; records: ArgusRecord[]; markerAddress: string; alsoMarkAddresses?: string[]; correlationIds: string[] }): Promise<WalletPendingTx> {
    return this.exclusive(async () => {
      assertValidRecordBatch(spend.records)
      const markers = [spend.markerAddress, ...(spend.alsoMarkAddresses ?? [])]
      for (const marker of markers) assertTestnetAddress(marker, 'Marker address')
      const state = await this.loadState()
      const hex = this.localTxHex(state, spend.outpoint.txid) ?? (await this.api.txHex(spend.outpoint.txid)).trim().toLowerCase()
      if (computeTxid(hex) !== spend.outpoint.txid.toLowerCase()) throw new Error('The funding transaction the network returned is not the one this ticket names.')
      const source = Transaction.fromHex(hex), funding = source.outputs[spend.outpoint.vout]
      if (!funding || funding.lockingScript.toHex() !== new P2PKH().lock(spend.key.toAddress('testnet')).toHex()) throw new Error('That output does not belong to this ticket key.')
      const tx = new Transaction()
      tx.addInput({ sourceTransaction: source, sourceOutputIndex: spend.outpoint.vout, unlockingScriptTemplate: new P2PKH().unlock(spend.key) })
      for (const record of spend.records) tx.addOutput({ lockingScript: encodeArgusRecordScript(record), satoshis: 0 })
      for (const marker of markers) tx.addOutput({ lockingScript: anchorLockingScript(marker), satoshis: ANCHOR_OUTPUT_SATOSHIS })
      tx.addOutput({ lockingScript: new P2PKH().lock(this.address), change: true })
      const rate = this.feeRate(state)
      try {
        await tx.fee(new SatoshisPerKilobyte(rate))
      } catch (error) {
        if (error instanceof RangeError) throw new Error('The ticket’s funding is too small to pay for this transaction.', { cause: error })
        throw error
      }
      await tx.sign()
      const txid = tx.id('hex'), txHex = tx.toHex()
      const changeIndex = tx.outputs.findIndex((output) => output.change === true && (output.satoshis ?? 0) > 0)
      const next = cloneState(state)
      if (changeIndex >= 0) next.coins.push({ txid, vout: changeIndex, satoshis: tx.outputs[changeIndex].satoshis ?? 0, height: 0, sourceTxHex: txHex, origin: 'change' })
      const pendingTx: WalletPendingTx = { txid, hex: txHex, createdAt: this.now(), purpose: 'records', correlationIds: [...spend.correlationIds], feeSatPerKb: rate, attempts: 0, status: 'pending' }
      next.pending.push(pendingTx)
      await this.commit(next)
      return clonePending(pendingTx)
    })
  }

  /** Broadcasts pending transactions in creation order. See the file header for the rules. */
  flush(): Promise<WalletFlushResult> {
    return this.exclusive(() => this.flushPending())
  }

  async pending(): Promise<WalletPendingTx[]> {
    return (await this.loadState()).pending.map(clonePending)
  }

  /** Hex of a transaction this wallet authored, if still pending or recently broadcast. */
  async ownTxHex(txid: string): Promise<string | undefined> {
    return this.localTxHex(await this.loadState(), txid)
  }

  private localTxHex(state: WalletState, txid: string): string | undefined {
    const id = txid.toLowerCase()
    return state.pending.find((tx) => tx.txid === id)?.hex ?? state.recent.find((tx) => tx.txid === id)?.hex
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation)
    this.queue = run.catch(() => undefined)
    return run
  }

  private async loadState(): Promise<WalletState> {
    if (this.state) return this.state
    this.loading ??= this.readStoredState().finally(() => {
      this.loading = undefined
    })
    const loaded = await this.loading
    this.state ??= loaded
    return this.state
  }

  private async readStoredState(): Promise<WalletState> {
    const stored = await this.store.load(this.address)
    if (!stored) return { version: 1, address: this.address, coins: [], pending: [], recent: [] }
    if (stored.version !== 1) throw new Error(`Unsupported wallet state version ${String(stored.version)}.`)
    if (stored.address !== this.address) throw new Error('The stored wallet state belongs to a different address.')
    return cloneState({ ...stored, coins: stored.coins ?? [], pending: stored.pending ?? [], recent: stored.recent ?? [] })
  }

  /** Saves first, then swaps: if the save fails, memory still matches what is persisted. */
  private async commit(next: WalletState): Promise<WalletState> {
    await this.store.save(next)
    this.state = next
    return next
  }

  private feeRate(state: WalletState): number {
    return Math.max(this.baseFeeSatPerKb, state.feeSatPerKb ?? 0)
  }

  private async refreshState(state: WalletState): Promise<WalletState> {
    const reported = dedupeUtxos(await this.api.unspent(this.address))
    const reportedByOutpoint = new Map(reported.map((utxo) => [outpointKey(utxo), utxo]))
    const pendingTxids = new Set(state.pending.map((tx) => tx.txid))
    const next = cloneState(state)

    const known = new Set<string>()
    const kept: WalletCoin[] = []
    const vanished = new Map<string, boolean>()
    for (const coin of next.coins) {
      const key = outpointKey(coin)
      known.add(key)
      const onChain = reportedByOutpoint.get(key)
      if (onChain) {
        // Still listed. A coin we spent stays reserved while that spend is pending or known to the
        // network (the index lags). If the network accepted the broadcast but never kept the
        // transaction (it is neither pending here nor known anywhere), the coin is released.
        const spend = coin.spentBy
        if (spend !== undefined && !pendingTxids.has(spend)) {
          if (!vanished.has(spend)) vanished.set(spend, await this.transactionUnknown(spend))
          if (vanished.get(spend)) { kept.push({ ...withoutSpentBy(coin), height: onChain.height }); continue }
        }
        kept.push({ ...coin, height: onChain.height })
      } else if (coin.spentBy !== undefined) {
        // Keep while our spend is pending so a rollback can release it. Once our spend was
        // accepted and the chain stops listing the coin, the spend is settled: forget it.
        if (pendingTxids.has(coin.spentBy)) kept.push(coin)
      } else if (this.suspectOutpoints.has(key)) {
        // Named in a conflict and not listed: it is gone, whatever its origin.
      } else if (coin.origin === 'change') {
        // Our own fresh change: the indexer lags our broadcasts, so absence means nothing yet.
        kept.push(coin)
      }
      // else: a chain coin that disappeared was spent elsewhere (e.g. this key restored on another device).
    }
    for (const utxo of reported) {
      if (known.has(outpointKey(utxo))) continue
      kept.push({ txid: utxo.txid, vout: utxo.vout, satoshis: utxo.satoshis, height: utxo.height, origin: 'chain' })
    }

    next.coins = kept
    next.lastRefreshAt = this.now()
    const committed = await this.commit(next)
    this.suspectOutpoints.clear()
    return committed
  }

  /** True only when the network positively reports the transaction as unknown (404); any other failure keeps the coin reserved. */
  private async transactionUnknown(txid: string): Promise<boolean> {
    try { await this.api.txHex(txid); return false } catch (error) { return error instanceof Error && (error as { status?: number }).status === 404 }
  }

  /**
   * Returns the source transaction for a coin, or undefined if the coin is not really a
   * P2PKH output of ours with the listed value (an inconsistent index entry).
   */
  private async sourceFor(state: WalletState, coin: WalletCoin): Promise<{ hex: string; tx: Transaction } | undefined> {
    const hex = coin.sourceTxHex ?? this.localTxHex(state, coin.txid) ?? (await this.api.txHex(coin.txid))
    const tx = Transaction.fromHex(hex)
    const output = tx.outputs[coin.vout]
    const matches =
      tx.id('hex') === coin.txid &&
      output !== undefined &&
      output.satoshis === coin.satoshis &&
      output.lockingScript.toHex() === this.ownLockingScriptHex
    return matches ? { hex, tx } : undefined
  }

  private async prepare(purpose: WalletPendingTx['purpose'], outputs: PlannedOutput[], correlationIds: string[]): Promise<WalletPendingTx> {
    let state = await this.loadState()
    const rate = this.feeRate(state)

    let selection = selectCoins(state.coins, outputs, rate)
    if (!selection.ok) {
      // The local view may just be stale (never refreshed, or funded since): look once.
      state = await this.refreshState(state)
      selection = selectCoins(state.coins, outputs, rate)
    }

    // Fetch source transactions. A coin whose source does not match what the index claimed
    // is dropped and selection runs again (bounded: each round removes at least one coin).
    const sources = new Map<string, { hex: string; tx: Transaction }>()
    for (;;) {
      if (!selection.ok) throw new InsufficientFundsError(this.address, selection.spendable, selection.needed)
      const bad: string[] = []
      for (const coin of selection.coins) {
        const key = outpointKey(coin)
        if (sources.has(key)) continue
        const source = await this.sourceFor(state, coin)
        if (source) sources.set(key, source)
        else bad.push(key)
      }
      if (bad.length === 0) break
      const next = cloneState(state)
      next.coins = next.coins.filter((coin) => !bad.includes(outpointKey(coin)))
      state = await this.commit(next)
      selection = selectCoins(state.coins, outputs, rate)
    }
    const selected = selection.coins

    const tx = new Transaction()
    for (const coin of selected) {
      const source = sources.get(outpointKey(coin))
      if (!source) throw new Error('Internal error: missing source transaction.')
      tx.addInput({ sourceTransaction: source.tx, sourceOutputIndex: coin.vout, unlockingScriptTemplate: new P2PKH().unlock(this.key) })
    }
    for (const output of outputs) tx.addOutput({ lockingScript: output.lockingScript, satoshis: output.satoshis })
    tx.addOutput({ lockingScript: new P2PKH().lock(this.address), change: true })

    try {
      await tx.fee(new SatoshisPerKilobyte(rate))
    } catch (error) {
      // Our estimate matches the SDK's, so this is a backstop rather than an expected path.
      if (error instanceof RangeError) {
        const spendable = sum(state.coins.filter((coin) => !coin.spentBy).map((coin) => coin.satoshis))
        throw new InsufficientFundsError(this.address, spendable, sum(outputs.map((output) => output.satoshis)) + 1)
      }
      throw error
    }
    await tx.sign()

    const txid = tx.id('hex')
    const hex = tx.toHex()
    const changeIndex = tx.outputs.findIndex((output) => output.change === true && (output.satoshis ?? 0) > 0)

    const next = cloneState(state)
    const selectedKeys = new Set(selected.map(outpointKey))
    next.coins = next.coins.map((coin) => {
      const key = outpointKey(coin)
      if (!selectedKeys.has(key)) return coin
      return { ...coin, spentBy: txid, sourceTxHex: sources.get(key)?.hex ?? coin.sourceTxHex }
    })
    if (changeIndex >= 0) {
      next.coins.push({ txid, vout: changeIndex, satoshis: tx.outputs[changeIndex].satoshis ?? 0, height: 0, sourceTxHex: hex, origin: 'change' })
    }
    const pendingTx: WalletPendingTx = {
      txid,
      hex,
      createdAt: this.now(),
      purpose,
      correlationIds,
      feeSatPerKb: rate,
      attempts: 0,
      status: 'pending',
    }
    next.pending.push(pendingTx)
    await this.commit(next)
    return clonePending(pendingTx)
  }

  private async flushPending(): Promise<WalletFlushResult> {
    let state = await this.loadState()
    const result: WalletFlushResult = { broadcast: [], rolledBack: [], stillPending: [] }
    let conflictSeen = false

    for (const txid of state.pending.map((tx) => tx.txid)) {
      const tx = state.pending.find((entry) => entry.txid === txid)
      if (!tx) continue // already rolled back this round as a dependent

      let outcome: BroadcastOutcome
      try {
        outcome = await this.api.broadcast(tx.hex)
      } catch (error) {
        // A ChainApi should classify instead of throwing; if one throws anyway, we cannot know.
        outcome = { status: 'ambiguous', message: errorMessage(error) }
      }

      if (outcome.status === 'accepted') {
        state = await this.commit(markBroadcast(state, txid, this.now()))
        result.broadcast.push(txid)
        continue
      }

      if (outcome.status === 'ambiguous') {
        const next = cloneState(state)
        const entry = next.pending.find((candidate) => candidate.txid === txid)
        if (entry) {
          entry.attempts += 1
          entry.lastError = outcome.message
        }
        state = await this.commit(next)
        // Later transactions may spend this one's outputs; retry the same bytes next round first.
        break
      }

      // Definitive refusal: conflict, fee-too-low or rejected.
      const { status, message } = outcome
      const { next, removed } = rollBack(state, txid)
      if (status === 'fee-too-low') next.feeSatPerKb = raisedFeeRate(Math.max(this.feeRate(state), tx.feeSatPerKb))
      if (status === 'conflict') {
        conflictSeen = true
        for (const coin of state.coins) if (coin.spentBy === txid) this.suspectOutpoints.add(outpointKey(coin))
      }
      state = await this.commit(next)
      result.rolledBack.push(...removed.map((entry) => this.rolledBackEntry(entry, txid, status, message)))
    }

    if (conflictSeen) {
      try {
        state = await this.refreshState(state)
      } catch {
        // The rollback already stands; the suspects stay queued for the next refresh().
      }
    }

    result.stillPending = state.pending.map((tx) => tx.txid)
    return result
  }

  private rolledBackEntry(entry: WalletPendingTx, rootTxid: string, status: RolledBackTx['status'], message: string): RolledBackTx {
    const reason = entry.txid === rootTxid ? message : `Depends on rolled-back transaction ${rootTxid} (${status}: ${message})`
    return { txid: entry.txid, correlationIds: [...entry.correlationIds], reason, status }
  }
}
