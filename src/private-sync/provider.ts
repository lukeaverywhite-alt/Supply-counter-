import { parseEncryptedEnvelope } from './schema'
import type { EncryptedArgusEnvelope, HistoryPage, PrivateHistoryProvider } from './types'
import { canonicalize } from '../distributed/canonical'

export class MockPrivateHistoryProvider implements PrivateHistoryProvider {
  private values = new Map<string, EncryptedArgusEnvelope>()
  unavailable = false
  reorderDelivery = false
  duplicateDelivery = false
  constructor(readonly name: string) {}
  async publish(input: EncryptedArgusEnvelope) { if (this.unavailable) throw new Error(`${this.name} unavailable.`); const envelope = parseEncryptedEnvelope(input), existing = this.values.get(envelope.eventId); if (existing && canonicalize(existing) !== canonicalize(envelope)) throw new Error('EVENT_COLLISION: encrypted event identity was reused.'); if (!existing) this.values.set(envelope.eventId, structuredClone(envelope)) }
  async getSince(cursor = '0'): Promise<HistoryPage> { if (this.unavailable) throw new Error(`${this.name} unavailable.`); let values: unknown[] = [...this.values.values()].slice(Number(cursor)); if (this.reorderDelivery) values.reverse(); if (this.duplicateDelivery) values = values.flatMap(value => [value, structuredClone(value)]); return { envelopes: structuredClone(values), cursor: String(this.values.size) } }
  async getByEventId(id: string) { if (this.unavailable) throw new Error(`${this.name} unavailable.`); return structuredClone(this.values.get(id)) }
}

export class MultiPrivateHistoryProvider implements PrivateHistoryProvider {
  readonly name = 'multi-provider'
  constructor(private providers: PrivateHistoryProvider[]) {}
  async publish(envelope: EncryptedArgusEnvelope) { const settled = await Promise.allSettled(this.providers.map(provider => provider.publish(envelope))); if (!settled.some(result => result.status === 'fulfilled')) throw new Error('All private-history providers unavailable.') }
  async getSince(): Promise<HistoryPage> { const settled = await Promise.allSettled(this.providers.map(provider => provider.getSince('0'))); const valid = settled.filter((result): result is PromiseFulfilledResult<HistoryPage> => result.status === 'fulfilled'); if (!valid.length) throw new Error('All private-history providers unavailable.'); const deduped = new Map<string, unknown>(); for (const result of valid) for (const raw of result.value.envelopes) { const envelope = parseEncryptedEnvelope(raw); const existing = deduped.get(envelope.eventId) as EncryptedArgusEnvelope | undefined; if (existing && existing.ciphertextHash !== envelope.ciphertextHash) throw new Error('Providers disagree on event ciphertext.'); deduped.set(envelope.eventId, envelope) } return { envelopes: [...deduped.values()], cursor: String(deduped.size) } }
  async getByEventId(id: string) { const page = await this.getSince(); return page.envelopes.find(value => parseEncryptedEnvelope(value).eventId === id) }
}
