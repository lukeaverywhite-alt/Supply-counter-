import type { SignedArgusEvent } from '../distributed/types'

export interface EventSyncProvider {
  publish(event: SignedArgusEvent): Promise<unknown>
  pull(): Promise<SignedArgusEvent[]>
}

export class MockSyncProvider implements EventSyncProvider {
  private events = new Map<string, SignedArgusEvent>()
  unavailable = false
  duplicateDelivery = false
  reorderDelivery = false
  async publish(event: SignedArgusEvent) {
    if (this.unavailable) throw new Error('Sync provider unavailable.')
    this.events.set(event.eventId, structuredClone(event))
  }
  async pull(): Promise<SignedArgusEvent[]> {
    if (this.unavailable) throw new Error('Sync provider unavailable.')
    let values = [...this.events.values()].map(event => structuredClone(event))
    if (this.reorderDelivery) values = values.reverse()
    return this.duplicateDelivery ? values.flatMap(event => [event, structuredClone(event)]) : values
  }
}
