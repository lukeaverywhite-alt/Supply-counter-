import { parseEncryptedEnvelope } from './schema'
import type { EncryptedArgusEnvelope, HistoryPage, PrivateHistoryProvider, ProviderHealth, PublishResult } from './types'

export class RemoteProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) { super(message) }
}

type RemoteProviderOptions = {
  endpoint: string
  organizationId: string
  /** Enrollment secret supplied at runtime. Never source this from a VITE_* variable. */
  accessToken: () => string | Promise<string>
  pageSize?: number
  fetch?: typeof globalThis.fetch
}

export class RemotePrivateHistoryProvider implements PrivateHistoryProvider {
  readonly name = 'A.R.G.U.S. encrypted relay'
  private readonly base: string
  private readonly request: typeof globalThis.fetch
  constructor(private readonly options: RemoteProviderOptions) {
    this.base = options.endpoint.replace(/\/$/, '')
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis)
    if (!/^https:\/\//.test(this.base) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]|[^/]+)(:\d+)?$/.test(this.base)) throw new Error('Remote synchronization requires HTTPS except during local/LAN development.')
  }
  private async call(path: string, init: RequestInit = {}) {
    const response = await this.request(`${this.base}${path}`, { ...init, headers: { authorization: `Bearer ${await this.options.accessToken()}`, ...init.headers } })
    const body = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) throw new RemoteProviderError(typeof body.code === 'string' ? body.code : 'REMOTE_UNAVAILABLE', 'Shared synchronization is temporarily unavailable. Your changes are safely stored locally.', response.status)
    return body
  }
  async publish(input: EncryptedArgusEnvelope): Promise<PublishResult> {
    const envelope = parseEncryptedEnvelope(input)
    if (envelope.organizationId !== this.options.organizationId) throw new RemoteProviderError('WRONG_ORGANIZATION', 'Envelope organization does not match the enrolled organization.')
    return await this.call('/api/v1/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }) as PublishResult
  }
  async getSince(cursor = '0'): Promise<HistoryPage> {
    const query = new URLSearchParams({ organizationId: this.options.organizationId, cursor, limit: String(this.options.pageSize ?? 100) })
    const body = await this.call(`/api/v1/events?${query}`)
    return { envelopes: body.events as unknown[], cursor: String(body.nextCursor), hasMore: Boolean(body.hasMore) }
  }
  async getByEventId(eventId: string) {
    const query = new URLSearchParams({ organizationId: this.options.organizationId })
    try { return parseEncryptedEnvelope((await this.call(`/api/v1/events/${encodeURIComponent(eventId)}?${query}`)).event) }
    catch (error) { if (error instanceof RemoteProviderError && error.status === 404) return undefined; throw error }
  }
  async health(): Promise<ProviderHealth> { return await this.call('/health') as ProviderHealth }
}
