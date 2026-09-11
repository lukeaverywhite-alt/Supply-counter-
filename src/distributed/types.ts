export type ArgusRole = 'MASTER' | 'INSTRUCTOR' | 'SUPPLY_OFFICER' | 'SUPPLY_ASSISTANT'

export const permissions = [
  'inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'inventory.adjust', 'inventory.create',
  'cadets.read', 'cadets.manage', 'calendar.read', 'calendar.write', 'bundles.read', 'bundles.manage',
  'audit.read', 'conflicts.resolve', 'users.authorize', 'users.revoke', 'users.manageRoles',
] as const
export type ArgusPermission = typeof permissions[number]

export type AuthorityCredential = {
  credentialVersion: 1
  credentialId: string
  subjectPublicIdentity: string
  role: ArgusRole
  permissions: ArgusPermission[]
  issuedAt: string
  issuedBy: string
  expiresAt?: string
  signature: string
}

export type AuthorityRevocation = {
  revocationVersion: 1
  revocationId: string
  credentialId: string
  subjectPublicIdentity: string
  effectiveAt: string
  issuedBy: string
  signature: string
}

export type DistributedEventType = 'ITEM_ISSUED' | 'ITEM_RETURNED' | 'INVENTORY_COUNT_SUBMITTED' | 'AUTHORITY_GRANTED' | 'AUTHORITY_REVOKED' | 'ROLE_CHANGED' | 'CONFLICT_DETECTED' | 'CONFLICT_RESOLVED' | 'RECORD_CORRECTED'
export type LocalSyncStatus = 'LOCAL' | 'QUEUED' | 'SYNCING' | 'SYNCHRONIZED' | 'CONFLICT' | 'FAILED'

export type UnsignedArgusEvent = {
  protocol: 'ARGUS'
  protocolVersion: 1
  organizationId: string
  eventVersion: 1
  eventId: string
  eventType: DistributedEventType
  entityId: string
  actorPublicIdentity: string
  timestamp: string
  baseVersion?: number
  payload: Record<string, unknown>
}
export type SignedArgusEvent = UnsignedArgusEvent & { signature: string }

export type AuditDeliveryStatus = 'NOT_SUBMITTED' | 'PENDING' | 'BROADCAST' | 'CONFIRMED' | 'PROOF_VERIFIED' | 'FAILED'
export type StoredEvent = { event: SignedArgusEvent; syncStatus: LocalSyncStatus; auditStatus: AuditDeliveryStatus; receivedAt: string }
export type OutboxRecord = { eventId: string; attempts: number; status: 'QUEUED' | 'SYNCING' | 'FAILED'; lastError?: string }
export type InventoryProjection = { entityId: string; name: string; onHand: number; issued?: number; version: number; appliedEventIds: string[] }
export type ConflictRecord = { id: string; entityId: string; eventIds: string[]; status: 'OPEN' | 'RESOLVED'; reason: string; resolutionEventId?: string }
