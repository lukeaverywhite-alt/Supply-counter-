import type { SignedArgusEvent } from '../distributed/types'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { ArgusRepository } from '../storage/repository'
import type { EventSyncProvider } from '../sync/mock'
import { decryptEvent, encryptEvent } from './crypto'
import type { KeyDistributionService } from './keys'
import type { PrivateHistoryProvider } from './types'

/**
 * Adapts the encrypted relay protocol to the replica transport contract.
 * Prepared ciphertext is committed to IndexedDB before the network request,
 * so an ambiguous retry sends byte-for-byte the same authenticated envelope.
 * Pulls intentionally replay from cursor zero: replica event IDs make this
 * safe and prevent a cursor write from outrunning projection persistence.
 */
export class DurableEncryptedEventSyncProvider implements EventSyncProvider {
  constructor(
    private readonly providerId: string,
    private readonly repository: ArgusRepository,
    private readonly provider: PrivateHistoryProvider,
    private readonly identity: ArgusIdentityProvider,
    private readonly keys: KeyDistributionService,
    private readonly organizationId: string,
  ) {}

  async publish(event: SignedArgusEvent) {
    if (event.organizationId !== this.organizationId) throw new Error('Cannot publish an event for another organization.')
    const snapshot = await this.repository.snapshot()
    let envelope = snapshot.privateSyncOutbox.find(item => item.providerId === this.providerId && item.eventId === event.eventId)?.envelope
    if (!envelope) {
      const prepared = await encryptEvent(event, this.identity, this.keys)
      await this.repository.transaction(state => {
        const existing = state.privateSyncOutbox.find(item => item.providerId === this.providerId && item.eventId === event.eventId)
        if (existing) envelope = existing.envelope
        else { state.privateSyncOutbox.push({ providerId: this.providerId, eventId: event.eventId, envelope: prepared }); envelope = prepared }
      })
    }
    if (!envelope) throw new Error('Encrypted event was not durably prepared.')
    const acknowledgment = await this.provider.publish(envelope)
    if (acknowledgment && acknowledgment.accepted !== true) throw new Error('Encrypted relay did not durably acknowledge the event.')
    await this.repository.transaction(state => { state.privateSyncOutbox = state.privateSyncOutbox.filter(item => item.providerId !== this.providerId || item.eventId !== event.eventId) })
    return acknowledgment
  }

  async pull() {
    const identity = await this.identity.getPublicIdentity(), events: SignedArgusEvent[] = []
    let cursor = '0', hasMore = true, pages = 0
    while (hasMore) {
      if (++pages > 10_000) throw new Error('Encrypted history pagination did not terminate.')
      const page = await this.provider.getSince(cursor)
      if (page.cursor === cursor && page.hasMore) throw new Error('Encrypted history provider returned a stalled cursor.')
      for (const envelope of page.envelopes) {
        try {
          const event = await decryptEvent(envelope, identity, this.identity, this.keys)
          if (event.organizationId !== this.organizationId) throw new Error('Encrypted history contains an event for another organization.')
          events.push(event)
        } catch (error) {
          const eventId = typeof envelope === 'object' && envelope && 'eventId' in envelope ? String(envelope.eventId) : 'unknown'
          const reason = error instanceof Error ? error.message : 'Encrypted history envelope was rejected.'
          await this.repository.transaction(state => { if (!state.quarantine.some(item => item.eventId === eventId && item.reason === reason)) state.quarantine.push({ eventId, reason, receivedAt: new Date().toISOString() }) })
        }
      }
      cursor = page.cursor; hasMore = Boolean(page.hasMore)
    }
    return events
  }
}
