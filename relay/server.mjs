import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const MAX_BYTES = 256 * 1024
const ID = /^[A-Za-z0-9_-]{8,160}$/
const HASH = /^[a-f0-9]{64}$/
const send = (res, status, value, origin) => { res.writeHead(status, { 'content-type': 'application/json', ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}) }); res.end(JSON.stringify(value)) }
const equal = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) }
const digest = value => createHash('sha256').update(value).digest('hex')

export function createRelay({ database = process.env.ARGUS_RELAY_DATABASE ?? 'argus-relay.json', organizations, allowedOrigins, rateLimit = 120 } = {}) {
  const memberships = organizations ?? JSON.parse(process.env.ARGUS_ORGANIZATIONS ?? '{}')
  const origins = allowedOrigins ?? (process.env.ARGUS_ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map(x => x.trim())
  if (!Object.keys(memberships).length) throw new Error('ARGUS_ORGANIZATIONS must map opaque organization IDs to access tokens.')
  let state
  try { state = existsSync(database) ? JSON.parse(readFileSync(database,'utf8')) : { version:1, nextSequence:1, organizations:{}, events:[] } }
  catch (error) { throw new Error('Relay storage is unreadable; history was preserved and the relay did not start.', { cause: error }) }
  if (state?.version !== 1 || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1 || !state.organizations || !Array.isArray(state.events)) throw new Error('Relay storage schema is invalid; history was preserved and the relay did not start.')
  const persist = () => { const temporary=`${database}.tmp`;writeFileSync(temporary,JSON.stringify(state),{mode:0o600});renameSync(temporary,database) }
  for (const [org, token] of Object.entries(memberships)) { if (!ID.test(org) || typeof token !== 'string' || token.length < 16) throw new Error('Organization IDs must be opaque and tokens must have at least 16 characters.'); state.organizations[org]=digest(token) }
  persist(state)
  const windows = new Map()
  const authorize = (req, org) => { const expected = state.organizations[org]; const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''; return Boolean(expected && token && equal(expected, digest(token))) }
  const server = http.createServer(async (req, res) => {
    const origin = typeof req.headers.origin === 'string' && origins.includes(req.headers.origin) ? req.headers.origin : undefined
    if (req.headers.origin && !origin) return send(res, 403, { code: 'ORIGIN_DENIED' })
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...(origin ? { 'access-control-allow-origin': origin } : {}), 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'authorization,content-type' }); return res.end() }
    if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true, provider: 'argus-relay', protocolVersion: 1, storageAvailable: true, uptimeSeconds: Math.floor(process.uptime()) }, origin)
    const now = Date.now()
    if (windows.size > 1000) for (const [key, value] of windows) if (now - value.start > 120_000) windows.delete(key)
    const ip = req.socket.remoteAddress ?? 'unknown', window = windows.get(ip) ?? { start: now, count: 0 }; if (now - window.start > 60_000) { window.start = now; window.count = 0 } windows.set(ip, window); if (++window.count > rateLimit) return send(res, 429, { code: 'RATE_LIMITED' }, origin)
    const url = new URL(req.url ?? '/', 'http://relay.local')
    if (url.pathname === '/api/v1/events' && req.method === 'POST') {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BYTES) return send(res, 413, { code: 'PAYLOAD_TOO_LARGE' }, origin)
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, 415, { code: 'UNSUPPORTED_MEDIA_TYPE' }, origin)
      let body = ''; let tooLarge = false
      for await (const chunk of req) { if (tooLarge) continue; body += chunk; if (Buffer.byteLength(body) > MAX_BYTES) { tooLarge = true; body = '' } }
      if (tooLarge) return send(res, 413, { code: 'PAYLOAD_TOO_LARGE' }, origin)
      let envelope; try { envelope = JSON.parse(body) } catch { return send(res, 400, { code: 'INVALID_ENVELOPE' }, origin) }
      const valid = envelope?.protocol === 'ARGUS_PRIVATE_EVENT' && envelope?.protocolVersion === 1 && envelope?.algorithm === 'AES-256-GCM' && ID.test(envelope.organizationId ?? '') && ID.test(envelope.eventId ?? '') && HASH.test(envelope.ciphertextHash ?? '') && ['epochId','senderPublicIdentity','nonce','ciphertext','signature'].every(k => typeof envelope[k] === 'string' && envelope[k].length > 0)
      if (!valid) return send(res, envelope?.protocolVersion !== 1 ? 422 : 400, { code: envelope?.protocolVersion !== 1 ? 'UNSUPPORTED_PROTOCOL' : 'INVALID_ENVELOPE' }, origin)
      if (!authorize(req, envelope.organizationId)) return send(res, 401, { code: 'UNAUTHORIZED' }, origin)
      const prior = state.events.find(row=>row.organizationId===envelope.organizationId&&row.eventId===envelope.eventId)
      if (prior) return prior.ciphertextHash === envelope.ciphertextHash ? send(res, 200, { accepted: true, duplicate: true, sequence: prior.sequence }, origin) : send(res, 409, { code: 'EVENT_COLLISION' }, origin)
      const sequence=state.nextSequence, next = { ...state, nextSequence: sequence + 1, events: [...state.events, {sequence,organizationId:envelope.organizationId,eventId:envelope.eventId,createdAt:new Date().toISOString(),senderPublicIdentity:envelope.senderPublicIdentity,keyEpoch:envelope.epochId,ciphertextHash:envelope.ciphertextHash,envelope}] }
      persist(next); state = next
      return send(res, 201, { accepted: true, duplicate: false, sequence }, origin)
    }
    const match = url.pathname.match(/^\/api\/v1\/events\/([^/]+)$/)
    const org = url.searchParams.get('organizationId') ?? ''
    if ((url.pathname === '/api/v1/events' || match) && req.method === 'GET') {
      if (!authorize(req, org)) return send(res, 401, { code: 'UNAUTHORIZED' }, origin)
      if (match) { const row=state.events.find(item=>item.organizationId===org&&item.eventId===decodeURIComponent(match[1])); return row ? send(res, 200, { event: row.envelope }, origin) : send(res, 404, { code: 'NOT_FOUND' }, origin) }
      const cursorRaw=url.searchParams.get('cursor')??'0',limitRaw=url.searchParams.get('limit')??'100'
      if (!/^\d+$/.test(cursorRaw)||!/^\d+$/.test(limitRaw)) return send(res,400,{code:'INVALID_PAGINATION'},origin)
      const cursor=Number(cursorRaw),limit=Number(limitRaw)
      if (!Number.isSafeInteger(cursor)||!Number.isSafeInteger(limit)||limit<1||limit>200) return send(res,400,{code:'INVALID_PAGINATION'},origin)
      const rows=state.events.filter(row=>row.organizationId===org&&row.sequence>cursor).sort((a,b)=>a.sequence-b.sequence).slice(0,limit+1),page=rows.slice(0,limit),nextCursor=page.at(-1)?.sequence??cursor
      return send(res, 200, { events: page.map(row => row.envelope), nextCursor: String(nextCursor), hasMore: rows.length > limit }, origin)
    }
    return send(res, 404, { code: 'NOT_FOUND' }, origin)
  })
  return { server, close: () => server.close() }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const relay = createRelay(), port = Number(process.env.ARGUS_RELAY_PORT ?? 8787), host = process.env.ARGUS_RELAY_HOST ?? '127.0.0.1'
  relay.server.listen(port, host, () => process.stdout.write(`A.R.G.U.S. encrypted relay listening on ${host}:${port}\n`))
}
