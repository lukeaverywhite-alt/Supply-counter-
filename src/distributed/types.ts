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

export type DistributedEventType = 'INVENTORY_ITEM_CREATED' | 'INVENTORY_ITEM_UPDATED' | 'ITEM_ISSUED' | 'ITEM_RETURNED' | 'INVENTORY_COUNT_SUBMITTED' | 'AUTHORITY_GRANTED' | 'AUTHORITY_REVOKED' | 'ROLE_CHANGED' | 'CONFLICT_DETECTED' | 'CONFLICT_RESOLVED' | 'RECORD_CORRECTED' | 'CADET_CREATED' | 'CADET_UPDATED' | 'BUNDLE_CREATED' | 'BUNDLE_UPDATED' | 'BUNDLE_DEACTIVATED' | 'STILL_NEEDED_ADDED' | 'STILL_NEEDED_UPDATED' | 'STILL_NEEDED_CANCELLED' | 'STILL_NEEDED_FULFILLED'
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
/** One projection represents exactly one stock keeping variant. */
export type InventoryProjection = { entityId: string; name: string; category: string; variant: string; niin: string; onHand: number; issued: number; reorderAt?: number; countIncrement: number; active: boolean; version: number; appliedEventIds: string[] }
export type ConflictRecord = { id: string; entityId: string; eventIds: string[]; status: 'OPEN' | 'RESOLVED'; reason: string; resolutionEventId?: string; transactionId?: string; inventoryItemIds?: string[]; cadetId?: string }

export type NsLevel = 'NS1' | 'NS2' | 'NS3' | 'NS4'
export type CadetGender = 'Male' | 'Female'
export type CurrentPropertyLine = { propertyId: string; itemId: string; label: string; variant: string; quantity: number; issuedAt: string; issueEventId: string; issueTransactionId: string; bundleId?: string; bundleVersion?: number }
export type CadetProjection = { cadetId: string; fullName: string; gender: CadetGender; profileNeedsReview?: boolean; nsLevel: NsLevel; status: 'ACTIVE' | 'INACTIVE'; sizes: Record<string, string>; currentProperty: CurrentPropertyLine[]; createdAt: string; updatedAt: string; version: number; appliedEventIds: string[] }
export type BundleLineProjection = { lineId: string; itemId?: string; displayLabel: string; required: boolean; supportsSizing: boolean; defaultQuantity: number; order: number }
export type BundleVersionProjection = { bundleId: string; displayName: string; genderApplicability: CadetGender | 'Any'; purpose: string; lines: BundleLineProjection[]; active: boolean; version: number; createdAt: string; actorPublicIdentity: string; priorVersion?: number; eventId: string }
export type BundleProjection = { bundleId: string; currentVersion: number; versions: BundleVersionProjection[]; appliedEventIds: string[] }
export type StillNeededProjection = { requirementId: string; cadetId: string; itemId?: string; displayLabel: string; size?: string; quantityNeeded: number; quantityFulfilled: number; status: 'OPEN' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED'; firstNeededAt: string; updatedAt: string; source: 'MANUAL' | 'INCOMPLETE_ISSUE' | 'CORRECTION'; relatedTransactionIds?: string[]; relatedBundleId?: string; bundleVersion?: number; version: number; appliedEventIds: string[] }
export type SupplyTransactionLine = { lineId: string; itemId: string; label: string; variant: string; quantity: number; baseVersion: number; propertyId?: string; requirementId?: string }
export type MissingIssueLine = { lineId: string; itemId?: string; label: string; variant?: string; quantity: number; required: true }
export type SupplyTransaction = { transactionId: string; transactionType: 'ISSUE'|'RETURN'; cadetId: string; actorId: string; createdAt: string; eventId: string; bundleId?: string; bundleVersion?: number; bundleSnapshot?: BundleVersionProjection; lines: SupplyTransactionLine[]; missingLines?: MissingIssueLine[] }
