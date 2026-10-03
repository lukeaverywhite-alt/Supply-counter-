/**
 * ChainApi over the WhatsOnChain BSV TESTNET REST API.
 *
 * Adapted from spell-forge src/bsv (MIT): whatsonchain-provider.ts (request pacing, bound
 * fetch, 429 / rejected-fetch retries, txHex 404 retry) and pending-spends.ts (WoC listing
 * the same outpoint twice around confirmation).
 *
 * This is the only file in the chain layer that knows network URLs. It never logs.
 */

import { assertTestnetAddress, computeTxid } from './codec'
import type { BroadcastOutcome, ChainApi, ChainHistoryItem, ChainHistoryPage, ChainUtxo } from './types'
import { dedupeUtxos } from './utxo'

export const WHATSONCHAIN_TESTNET_BASE_URL = 'https://api.whatsonchain.com/v1/bsv/test'

/**
 * WhatsOnChain allows about 3 requests/s per IP without a key. Its 429 reply carries no CORS
 * header, so a browser sees a rejected fetch instead of a 429; pacing avoids provoking it.
 */
const DEFAULT_MIN_SPACING_MS = 350
const DEFAULT_RETRY_DELAY_MS = 500
/** The /tx/{txid}/hex index lags the unspent index by a few seconds right after a broadcast. */
const DEFAULT_TX_HEX_NOT_FOUND_RETRY_MS = 1000
const DEFAULT_TX_HEX_NOT_FOUND_TIMEOUT_MS = 15_000
/** A hung request must not stall a wallet flush forever; an aborted fetch counts as a rejected fetch. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_HISTORY_LIMIT = 1000
const MAX_GET_ATTEMPTS = 3
/** A 429 only says "too many requests from this address": waiting is the cure, so it earns more attempts than a failure that may be real. */
const MAX_RATE_LIMITED_GET_ATTEMPTS = 6
/** Backoff doubles from the first retry delay up to this; with jitter a wait is at most twice it. */
const MAX_RETRY_DELAY_MS = 8000
const MAX_ERROR_BODY_CHARS = 200
const TXID_PATTERN = /^[0-9a-f]{64}$/i

const ALREADY_KNOWN_PATTERN = /already[- ]?known|already in (the )?mempool|txn-already|already in block|transaction already/i
const CONFLICT_PATTERN = /missing ?inputs|missingorspent|mempool-conflict|double.?spend|conflict/i
const FEE_PATTERN = /fee|priority/i

/** A failed WhatsOnChain read. status is the HTTP status when one was received. */
export class ChainApiError extends Error {
  readonly status?: number
  readonly path?: string

  constructor(message: string, options: { status?: number; path?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChainApiError'
    this.status = options.status
    this.path = options.path
  }
}

export type WhatsOnChainApiOptions = {
  fetcher?: typeof fetch
  baseUrl?: string
  /** Extra headers on every request (for example a WhatsOnChain API key). */
  headers?: Record<string, string>
  /** Minimum time between request starts, per instance. */
  minSpacingMs?: number
  /** First GET retry delay; doubles on each further retry. */
  retryDelayMs?: number
  txHexNotFoundRetryMs?: number
  txHexNotFoundTimeoutMs?: number
  sleep?: (ms: number) => Promise<void>
  /** Source of the jitter added to each retry wait, in [0, 1). Default Math.random. */
  random?: () => number
  /** Clock used for pacing (ms). Injected together with sleep in tests. */
  now?: () => number
  /** Per-request timeout, including reading the body. */
  requestTimeoutMs?: number
}

type RawResponse = { status: number; body: string }

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isTxid(value: unknown): value is string {
  return typeof value === 'string' && TXID_PATTERN.test(value)
}

function hasStatus(error: unknown, ...statuses: number[]): boolean {
  return error instanceof ChainApiError && error.status !== undefined && statuses.includes(error.status)
}

function snippet(body: string): string {
  const trimmed = body.trim().slice(0, MAX_ERROR_BODY_CHARS)
  return trimmed ? `: ${trimmed}` : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Heights of 0 or below (or missing) all mean "in the mempool". */
function normalizeHeight(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
}

export class WhatsOnChainApi implements ChainApi {
  readonly network = 'testnet' as const

  private readonly fetcher: typeof fetch
  private readonly baseUrl: string
  private readonly headers: Record<string, string>
  private readonly minSpacingMs: number
  private readonly retryDelayMs: number
  private readonly txHexNotFoundRetryMs: number
  private readonly txHexNotFoundTimeoutMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly random: () => number
  private readonly requestTimeoutMs: number

  /** Every request start queues behind the previous one so starts stay minSpacingMs apart. */
  private slotChain: Promise<void> = Promise.resolve()
  private lastStartAt: number | undefined

  constructor(options: WhatsOnChainApiOptions = {}) {
    const baseUrl = (options.baseUrl ?? WHATSONCHAIN_TESTNET_BASE_URL).replace(/\/+$/, '')
    if (/\/main(\/|$)|mainnet/i.test(baseUrl)) {
      throw new Error('Mainnet is disabled: A.R.G.U.S. only talks to BSV testnet.')
    }
    this.baseUrl = baseUrl
    // Bound, not a bare reference: a browser's fetch throws "Illegal invocation" when called
    // detached from its global (jsdom does not enforce this, so tests would not notice).
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.headers = { ...options.headers }
    this.minSpacingMs = options.minSpacingMs ?? DEFAULT_MIN_SPACING_MS
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.txHexNotFoundRetryMs = options.txHexNotFoundRetryMs ?? DEFAULT_TX_HEX_NOT_FOUND_RETRY_MS
    this.txHexNotFoundTimeoutMs = options.txHexNotFoundTimeoutMs ?? DEFAULT_TX_HEX_NOT_FOUND_TIMEOUT_MS
    this.sleep = options.sleep ?? defaultSleep
    this.now = options.now ?? (() => Date.now())
    this.random = options.random ?? Math.random
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async unspent(address: string): Promise<ChainUtxo[]> {
    assertTestnetAddress(address)
    const encoded = encodeURIComponent(address)
    let items: unknown[]
    try {
      items = this.listFrom(await this.getJson(`/address/${encoded}/unspent/all`), 'unspent/all')
    } catch (error) {
      // Older deployments lack /unspent/all; fall back to the legacy bare-array endpoint.
      if (!hasStatus(error, 404, 400)) throw error
      items = await this.legacyList(`/address/${encoded}/unspent`)
    }

    const utxos: ChainUtxo[] = []
    for (const item of items) {
      if (!isRecord(item)) continue
      // WoC's /unspent/all still lists an output whose spend sits in the mempool, flagged.
      if (item.isSpentInMempoolTx === true) continue
      if (!isTxid(item.tx_hash) || !isNonNegativeInteger(item.tx_pos) || !isNonNegativeInteger(item.value)) continue
      utxos.push({ txid: item.tx_hash.toLowerCase(), vout: item.tx_pos, satoshis: item.value, height: normalizeHeight(item.height) })
    }
    return dedupeUtxos(utxos)
  }

  async txHex(txid: string): Promise<string> {
    if (!isTxid(txid)) throw new ChainApiError(`"${txid}" is not a transaction id.`)
    const id = txid.toLowerCase()
    const path = `/tx/${id}/hex`
    const maxNotFoundRetries = this.txHexNotFoundRetryMs > 0 ? Math.floor(this.txHexNotFoundTimeoutMs / this.txHexNotFoundRetryMs) : 0

    for (let notFoundRetries = 0; ; notFoundRetries += 1) {
      let response: RawResponse
      try {
        response = await this.get(path)
      } catch (error) {
        if (!hasStatus(error, 404)) throw error
        if (notFoundRetries >= maxNotFoundRetries) {
          throw new ChainApiError(`WhatsOnChain does not know transaction ${id} (still 404 after ${notFoundRetries * this.txHexNotFoundRetryMs} ms).`, { status: 404, path, cause: error })
        }
        await this.sleep(this.txHexNotFoundRetryMs)
        continue
      }

      const hex = response.body.trim().replace(/^"|"$/g, '').toLowerCase()
      let actual: string
      try {
        actual = computeTxid(hex)
      } catch (error) {
        throw new ChainApiError(`WhatsOnChain returned malformed hex for ${id}.`, { path, cause: error })
      }
      // Never hand a signer a source transaction that is not the one it asked for.
      if (actual !== id) throw new ChainApiError(`WhatsOnChain returned a different transaction for ${id}.`, { path })
      return hex
    }
  }

  async confirmedHistory(address: string, options: { fromHeight?: number; token?: string; limit?: number } = {}): Promise<ChainHistoryPage> {
    assertTestnetAddress(address)
    const { fromHeight, token } = options
    const limit = options.limit ?? DEFAULT_HISTORY_LIMIT
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`History limit must be a positive integer, not ${limit}.`)
    if (fromHeight !== undefined && !isNonNegativeInteger(fromHeight)) throw new Error(`fromHeight must be a non-negative integer, not ${fromHeight}.`)

    const encoded = encodeURIComponent(address)
    let query = `?order=asc&limit=${limit}`
    if (fromHeight !== undefined) query += `&height=${fromHeight}`
    if (token) query += `&token=${encodeURIComponent(token)}`

    let body: unknown
    try {
      body = await this.getJson(`/address/${encoded}/confirmed/history${query}`)
    } catch (error) {
      if (!hasStatus(error, 404)) throw error
      // Legacy endpoint: the whole history at once, confirmed and unconfirmed, no paging.
      const legacy = await this.legacyList(`/address/${encoded}/history`)
      return { items: this.historyItems(legacy, fromHeight) }
    }

    const items = this.historyItems(this.listFrom(body, 'confirmed/history'), fromHeight)
    let nextToken: unknown
    if (isRecord(body)) nextToken = body.nextPageToken ?? body.next_page_token
    return typeof nextToken === 'string' && nextToken.length > 0 ? { items, nextToken } : { items }
  }

  async unconfirmedHistory(address: string): Promise<string[]> {
    assertTestnetAddress(address)
    let items: unknown[]
    try {
      items = this.listFrom(await this.getJson(`/address/${encodeURIComponent(address)}/unconfirmed/history`), 'unconfirmed/history')
    } catch (error) {
      if (hasStatus(error, 404)) return []
      throw error
    }
    const txids = new Set<string>()
    for (const item of items) {
      const candidate = isRecord(item) ? item.tx_hash : item
      if (isTxid(candidate)) txids.add(candidate.toLowerCase())
    }
    return [...txids]
  }

  /** One attempt, never retried: re-sending after an unclear answer is the wallet's decision. */
  async broadcast(txHex: string): Promise<BroadcastOutcome> {
    const hex = txHex.trim().toLowerCase()
    let txid: string
    try {
      txid = computeTxid(hex)
    } catch (error) {
      return { status: 'rejected', message: `Transaction hex is malformed: ${errorMessage(error)}` }
    }

    let response: RawResponse
    try {
      response = await this.attempt('/tx/raw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txhex: hex }),
      })
    } catch (error) {
      return { status: 'ambiguous', message: `Could not reach WhatsOnChain to broadcast ${txid} (${errorMessage(error)}); it may or may not have been accepted.` }
    }

    // On success WoC answers with the txid as a JSON string. We trust our own hash of the
    // bytes we sent over whatever the body says.
    if (response.status >= 200 && response.status < 300) return { status: 'accepted', txid, alreadyKnown: false }
    return classifyBroadcastFailure(response, txid)
  }

  async tipHeight(): Promise<number> {
    const body = await this.getJson('/chain/info')
    if (!isRecord(body) || !isNonNegativeInteger(body.blocks)) {
      throw new ChainApiError(`WhatsOnChain /chain/info returned an unexpected shape${snippet(JSON.stringify(body) ?? '')}`, { path: '/chain/info' })
    }
    return body.blocks
  }

  /** The median time of the latest blocks (`mediantime`, seconds): a lower bound on the chain's time that no phone clock can move. */
  async tipTime(): Promise<string | undefined> {
    const body = await this.getJson('/chain/info')
    return isRecord(body) && isNonNegativeInteger(body.mediantime) ? new Date(body.mediantime * 1000).toISOString() : undefined
  }

  /** Confirmed history entries: valid txids with a positive height, from fromHeight on, ascending, de-duplicated. */
  private historyItems(items: unknown[], fromHeight: number | undefined): ChainHistoryItem[] {
    const byTxid = new Map<string, ChainHistoryItem>()
    for (const item of items) {
      if (!isRecord(item) || !isTxid(item.tx_hash)) continue
      const height = normalizeHeight(item.height)
      if (height === 0) continue
      if (fromHeight !== undefined && height < fromHeight) continue
      byTxid.set(item.tx_hash.toLowerCase(), { txid: item.tx_hash.toLowerCase(), height })
    }
    return [...byTxid.values()].sort((left, right) => left.height - right.height || left.txid.localeCompare(right.txid))
  }

  /** A legacy bare-array endpoint. Its 404 means "nothing known about this address". */
  private async legacyList(path: string): Promise<unknown[]> {
    try {
      return this.listFrom(await this.getJson(path), path)
    } catch (error) {
      if (hasStatus(error, 404)) return []
      throw error
    }
  }

  /** WoC list endpoints answer either with a bare array or with a { result: [...] } envelope. */
  private listFrom(body: unknown, endpoint: string): unknown[] {
    if (Array.isArray(body)) return body
    if (isRecord(body) && Array.isArray(body.result)) return body.result
    throw new ChainApiError(`WhatsOnChain ${endpoint} returned an unexpected shape${snippet(JSON.stringify(body) ?? '')}`)
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.get(path)
    try {
      return JSON.parse(response.body) as unknown
    } catch (error) {
      throw new ChainApiError(`WhatsOnChain ${path} returned invalid JSON${snippet(response.body)}`, { path, status: response.status, cause: error })
    }
  }

  /**
   * GET with retries on 429, 5xx and rejected fetches (WoC's 429 has no CORS header, so a
   * browser reports it as a network error). Each wait doubles (up to MAX_RETRY_DELAY_MS) and gets random jitter
   * added, so phones that were limited together do not all come back together. A 429 is retried up to
   * MAX_RATE_LIMITED_GET_ATTEMPTS times, anything else up to MAX_GET_ATTEMPTS. Any other non-2xx throws a ChainApiError with its status.
   */
  private async get(path: string): Promise<RawResponse> {
    let delayMs = this.retryDelayMs
    const backOff = async () => {
      await this.sleep(delayMs * (1 + this.random()))
      delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS)
    }
    for (let attempt = 1; ; attempt += 1) {
      let response: RawResponse
      try {
        response = await this.attempt(path, { method: 'GET' })
      } catch (error) {
        if (attempt >= MAX_GET_ATTEMPTS) {
          throw new ChainApiError(
            `Could not reach WhatsOnChain after ${attempt} tries (offline, timed out, or rate-limited; its 429 reply carries no CORS header).`,
            { path, cause: error },
          )
        }
        await backOff()
        continue
      }

      if (response.status >= 200 && response.status < 300) return response
      const rateLimited = response.status === 429
      const retryable = rateLimited || response.status >= 500
      if (retryable && attempt < (rateLimited ? MAX_RATE_LIMITED_GET_ATTEMPTS : MAX_GET_ATTEMPTS)) {
        await backOff()
        continue
      }
      throw new ChainApiError(`WhatsOnChain ${path} answered ${response.status}${snippet(response.body)}`, { status: response.status, path })
    }
  }

  /** One paced request. Rejects on network error or timeout; the caller decides about retries. */
  private async attempt(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
    await this.acquireSlot()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: { ...this.headers, ...init.headers },
        body: init.body,
        signal: controller.signal,
      })
      // Read the body inside the timeout too: a stalled body is as bad as a stalled connect.
      const body = await response.text()
      return { status: response.status, body }
    } finally {
      clearTimeout(timer)
    }
  }

  private acquireSlot(): Promise<void> {
    const turn = this.slotChain.then(async () => {
      if (this.lastStartAt !== undefined) {
        const waitMs = this.lastStartAt + this.minSpacingMs - this.now()
        if (waitMs > 0) await this.sleep(waitMs)
      }
      this.lastStartAt = this.now()
    })
    this.slotChain = turn.catch(() => undefined)
    return turn
  }
}

/** Maps a non-2xx broadcast answer onto the wallet's outcome classes (see BroadcastOutcome). */
function classifyBroadcastFailure(response: RawResponse, txid: string): BroadcastOutcome {
  const { status, body } = response
  const message = `WhatsOnChain answered ${status}${snippet(body)}`
  if (ALREADY_KNOWN_PATTERN.test(body)) return { status: 'accepted', txid, alreadyKnown: true }
  if (CONFLICT_PATTERN.test(body)) return { status: 'conflict', message }
  if (FEE_PATTERN.test(body)) return { status: 'fee-too-low', message }
  if (status === 429 || status >= 500) return { status: 'ambiguous', message }
  if (status >= 400) return { status: 'rejected', message }
  // 1xx/3xx: nothing definitive was said about the transaction.
  return { status: 'ambiguous', message }
}
