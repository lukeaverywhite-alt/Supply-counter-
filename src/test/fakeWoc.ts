import type { FakeChain } from '../chain/fakeChain'

/** What a test can see and steer about the WhatsOnChain REST look-alike below. */
export type FakeWocOptions = {
  /** Answer 429 to this request? Called with the path (after the base URL, with its query) and how many requests came before it. */
  rateLimit?: (path: string, requestNumber: number) => boolean
}

/**
 * A `fetch` that answers the WhatsOnChain testnet REST calls the chain client makes out of a FakeChain, so a real
 * WhatsOnChainApi (pacing, retries, backoff) can run against the in-memory chain. Only the calls a device makes are covered.
 */
export function fakeWocFetch(chain: FakeChain, options: FakeWocOptions = {}) {
  const paths: string[] = []
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = String(input).replace(/^https?:\/\/[^/]+\/v1\/bsv\/test/, '')
    const requestNumber = paths.length
    paths.push(path)
    if (options.rateLimit?.(path, requestNumber)) return new Response('Too Many Requests', { status: 429 })
    const url = new URL(path, 'http://woc.invalid'), segments = url.pathname.split('/').filter(Boolean)
    if (init?.method === 'POST' && url.pathname === '/tx/raw') {
      const outcome = await chain.broadcast((JSON.parse(String(init.body)) as { txhex: string }).txhex)
      return outcome.status === 'accepted' ? json(outcome.txid) : new Response(outcome.message, { status: outcome.status === 'ambiguous' ? 503 : 400 })
    }
    if (url.pathname === '/chain/info') return json({ blocks: await chain.tipHeight() })
    if (segments[0] === 'tx' && segments[2] === 'hex') { try { return new Response(await chain.txHex(segments[1]), { status: 200 }) } catch { return new Response('not found', { status: 404 }) } }
    if (segments[0] === 'address') {
      const address = decodeURIComponent(segments[1]), what = segments.slice(2).join('/')
      if (what === 'unspent/all') return json({ result: (await chain.unspent(address)).map(utxo => ({ tx_hash: utxo.txid, tx_pos: utxo.vout, value: utxo.satoshis, height: utxo.height })) })
      if (what === 'unconfirmed/history') return json({ result: (await chain.unconfirmedHistory(address)).map(txid => ({ tx_hash: txid })) })
      if (what === 'confirmed/history') {
        const height = url.searchParams.get('height'), token = url.searchParams.get('token'), limit = url.searchParams.get('limit')
        const page = await chain.confirmedHistory(address, { ...(height ? { fromHeight: Number(height) } : {}), ...(token ? { token } : {}), ...(limit ? { limit: Number(limit) } : {}) })
        return json({ result: page.items.map(item => ({ tx_hash: item.txid, height: item.height })), ...(page.nextToken ? { nextPageToken: page.nextToken } : {}) })
      }
    }
    return new Response(`fakeWoc: no route for ${path}`, { status: 404 })
  }
  return { fetcher: fetcher as typeof fetch, paths }
}
