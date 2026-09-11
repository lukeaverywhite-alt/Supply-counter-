import type { AuditEvent } from '../types'

export type AuditCommitment = Pick<AuditEvent, 'eventVersion' | 'eventId' | 'timestamp' | 'actorId' | 'type' | 'entityId' | 'data' | 'previousEventHash'>

const ALLOWED_DATA_FIELDS: Record<AuditEvent['type'], readonly string[]> = {
  INVENTORY_ITEM_CREATED: ['itemId'],
  INVENTORY_COUNT_SUBMITTED: ['countedVariants', 'sessionId'],
  ITEM_ISSUED: ['itemId', 'quantity'],
  ITEM_RETURNED: ['itemId', 'quantity'],
  ANNUAL_ROLLOVER_COMPLETED: ['schoolYear'],
}

export function toAuditCommitment(event: AuditEvent): AuditCommitment {
  const data = Object.fromEntries(Object.entries(event.data).filter(([key]) => ALLOWED_DATA_FIELDS[event.type].includes(key)))
  return {
    eventVersion: event.eventVersion,
    eventId: event.eventId,
    timestamp: event.timestamp,
    actorId: event.actorId,
    type: event.type,
    entityId: event.entityId,
    data,
    ...(event.previousEventHash ? { previousEventHash: event.previousEventHash } : {}),
  }
}

function canonicalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry)}`).join(',')}}`
}

export function canonicalizeEvent(event: AuditEvent): string {
  return canonicalValue(toAuditCommitment(event))
}

export async function hashEvent(event: AuditEvent): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeEvent(event)))
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}
