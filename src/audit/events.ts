import type { AppData, AuditEvent, DomainEventType } from '../types'

export const DEMO_ACTOR_ID = 'role:supply-staff'

export function createDomainEvent(input: {
  type: DomainEventType
  entityId: string
  summary: string
  data: AuditEvent['data']
  previousEventHash?: string
}): AuditEvent {
  return {
    eventVersion: 1,
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    actorId: DEMO_ACTOR_ID,
    type: input.type,
    entityId: input.entityId,
    summary: input.summary,
    data: input.data,
    previousEventHash: input.previousEventHash,
    audit: { status: 'QUEUED_FOR_AUDIT', network: 'MOCK' },
  }
}

export function appendDomainEvent(data: AppData, event: AuditEvent): AppData {
  return { ...data, audit: [event, ...data.audit] }
}
