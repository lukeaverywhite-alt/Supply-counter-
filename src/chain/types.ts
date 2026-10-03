/**
 * Contracts for the A.R.G.U.S. BSV TESTNET chain layer.
 *
 * The chain layer knows nothing about inventory, cadets or encryption. It moves opaque
 * A.R.G.U.S. records (already-encrypted bytes) into testnet transactions that pay a 1-satoshi
 * output to the unit's anchor address, and it finds those transactions again by walking the
 * anchor address history. Every unit device runs its own wallet key; no key is ever shared.
 *
 * Mainnet is not supported anywhere in this layer.
 */

/** One unspent output as reported by the chain API. height 0 means unconfirmed (mempool). */
export type ChainUtxo = { txid: string; vout: number; satoshis: number; height: number }

/** One transaction in an address history. height 0 means unconfirmed (mempool). */
export type ChainHistoryItem = { txid: string; height: number }

export type ChainHistoryPage = { items: ChainHistoryItem[]; nextToken?: string }

/** Result classes of a broadcast attempt. */
export type BroadcastOutcome =
  /** Accepted now, or the network already knows this exact transaction. Both mean "published". */
  | { status: 'accepted'; txid: string; alreadyKnown: boolean }
  /** An input is already spent / missing: our coin view is stale. Roll back and refresh UTXOs. */
  | { status: 'conflict'; message: string }
  /** Fee too low for relay policy. Roll back and rebuild with a higher fee rate. */
  | { status: 'fee-too-low'; message: string }
  /** Any other definitive rejection (malformed, dust, non-standard...). Roll back; surface the message. */
  | { status: 'rejected'; message: string }
  /** Network error, timeout, 429 or 5xx: the transaction MAY have been accepted. Keep it and rebroadcast the same bytes later. */
  | { status: 'ambiguous'; message: string }

/**
 * Read/broadcast API over BSV testnet. The production implementation is WhatsOnChain
 * (https://api.whatsonchain.com/v1/bsv/test); tests use an in-memory fake chain.
 */
export interface ChainApi {
  readonly network: 'testnet'
  /** Spendable outputs for an address, confirmed and unconfirmed. Implementations MUST de-duplicate outpoints. */
  unspent(address: string): Promise<ChainUtxo[]>
  /** Raw transaction hex. Implementations retry a 404 briefly because indexes lag a fresh broadcast. */
  txHex(txid: string): Promise<string>
  /** Confirmed history for an address in ascending height order, starting at fromHeight (inclusive) when given. */
  confirmedHistory(address: string, options?: { fromHeight?: number; token?: string; limit?: number }): Promise<ChainHistoryPage>
  /** Unconfirmed (mempool) txids touching the address. */
  unconfirmedHistory(address: string): Promise<string[]>
  /** Broadcast raw hex. Never throws for a rejection; classifies it instead. */
  broadcast(txHex: string): Promise<BroadcastOutcome>
  /** Current best height (used for status only). */
  tipHeight(): Promise<number>
  /**
   * The chain's own time (ISO), from the latest blocks, or undefined when the service does not say. A phone cannot set it back, so
   * a ticket's expiry is checked against the later of it and the phone's clock (ADR 012).
   */
  tipTime(): Promise<string | undefined>
}

/** A wallet-tracked coin. sourceTxHex lets the SDK sign without refetching, and lets chained unconfirmed spends work. */
export type WalletCoin = {
  txid: string
  vout: number
  satoshis: number
  /** 0 = unconfirmed */
  height: number
  sourceTxHex?: string
  /** txid of our own (pending or broadcast) transaction that spends this coin. Spent coins are never selected again. */
  spentBy?: string
  origin: 'chain' | 'change'
}

/** A transaction this wallet built and must get onto the network exactly once. */
export type WalletPendingTx = {
  txid: string
  hex: string
  createdAt: string
  purpose: 'records' | 'transfer'
  /** Opaque correlation IDs supplied by the caller (A.R.G.U.S. uses event IDs). */
  correlationIds: string[]
  feeSatPerKb: number
  attempts: number
  status: 'pending' | 'broadcast'
  lastError?: string
}

/** Everything a device wallet persists. Saved as ONE record so each save is atomic. */
export type WalletState = {
  version: 1
  address: string
  coins: WalletCoin[]
  pending: WalletPendingTx[]
  /** Recently broadcast txs we authored, newest first, capped. Lets the scanner skip refetching our own hex. */
  recent: Array<{ txid: string; hex: string; broadcastAt: string }>
  lastRefreshAt?: string
  /** Fee rate (sat/kB) raised after a fee-too-low rejection. Absent until the first raise. */
  feeSatPerKb?: number
}

/** One transaction that flush() removed because the network definitively refused it (or a transaction it depended on). */
export type RolledBackTx = {
  txid: string
  correlationIds: string[]
  /** Human-readable reason: the network's message, or which rolled-back parent this transaction depended on. */
  reason: string
  /** The broadcast outcome that caused the rollback (a dependent child reports its parent's outcome). */
  status: 'conflict' | 'fee-too-low' | 'rejected'
}

/** Result of one DeviceWallet.flush() round. */
export type WalletFlushResult = {
  /** Accepted by the network this round (including "already known"), in broadcast order. */
  broadcast: string[]
  rolledBack: RolledBackTx[]
  /** Still waiting for a definitive answer (ambiguous outcome, or queued behind one). */
  stillPending: string[]
}

export interface WalletStateStore {
  load(address: string): Promise<WalletState | undefined>
  save(state: WalletState): Promise<void>
}

/** A.R.G.U.S. record kinds carried in data outputs. */
export type ArgusRecordKind = 'E' /* encrypted event envelope */ | 'G' /* key grant (wrapped unit key) */ | 'T' /* admission ticket record, at a ticket address (ADR 012) */

export type ArgusRecord = { kind: ArgusRecordKind; payload: Uint8Array }

export type DecodedArgusRecord = ArgusRecord & { vout: number }

/** Result of asking the wallet to publish records. */
export type PublishRecordsResult = { txid: string }

export type WalletBalance = {
  address: string
  /** Sum of unspent, not-locally-spent coins with height > 0 */
  confirmed: number
  /** Sum of unspent, not-locally-spent coins with height 0 (includes our own change) */
  unconfirmed: number
  /** confirmed + unconfirmed: what the wallet can spend right now */
  spendable: number
  pendingBroadcasts: number
}
