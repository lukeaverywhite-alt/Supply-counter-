import type { EncryptedArgusEnvelope } from './types'
import type { SignedArgusEvent } from '../distributed/types'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export function parseEncryptedEnvelope(value: unknown): EncryptedArgusEnvelope {
  if (!record(value) || value.protocol !== 'ARGUS_PRIVATE_EVENT' || value.protocolVersion !== 1 || value.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encrypted envelope protocol.')
  for (const field of ['organizationId', 'eventId', 'epochId', 'senderPublicIdentity', 'nonce', 'ciphertext', 'ciphertextHash', 'signature']) if (typeof value[field] !== 'string' || !value[field]) throw new Error(`Invalid encrypted envelope field: ${field}.`)
  return value as EncryptedArgusEnvelope
}
export function parseSignedEvent(value: unknown): SignedArgusEvent {
  if (!record(value) || value.protocol !== 'ARGUS' || value.protocolVersion !== 1 || value.eventVersion !== 1 || typeof value.organizationId !== 'string' || typeof value.eventId !== 'string' || typeof value.eventType !== 'string' || typeof value.entityId !== 'string' || typeof value.actorPublicIdentity !== 'string' || typeof value.timestamp !== 'string' || !record(value.payload) || typeof value.signature !== 'string') throw new Error('Invalid or unsupported signed event schema.')
  return value as SignedArgusEvent
}
