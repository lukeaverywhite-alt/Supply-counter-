/**
 * CADET is a person who reads only their own sealed record (ADR 013): never a unit member, so it holds no unit permission, no
 * unit credential and no unit key. The other four are staff.
 */
export type ArgusRole = 'MASTER' | 'INSTRUCTOR' | 'SUPPLY_OFFICER' | 'SUPPLY_ASSISTANT' | 'CADET'

export const permissions = [
  'inventory.read', 'inventory.issue', 'inventory.return', 'inventory.count', 'inventory.adjust', 'inventory.create',
  'cadets.read', 'cadets.manage', 'calendar.read', 'calendar.write', 'bundles.read', 'bundles.manage',
  'audit.read', 'conflicts.resolve', 'users.authorize', 'users.revoke', 'users.manageRoles', 'cadets.admit', 'notices.send',
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

export type DistributedEventType = 'INVENTORY_ITEM_CREATED' | 'INVENTORY_ITEM_UPDATED' | 'INVENTORY_RECEIVED' | 'CATALOG_ITEM_CREATED' | 'CATALOG_ITEM_UPDATED' | 'CATALOG_SIZES_ADDED' | 'ITEM_ISSUED' | 'ITEM_RETURNED' | 'INVENTORY_COUNT_SUBMITTED' | 'COUNT_SESSION_CREATED' | 'COUNT_CONTRIBUTED' | 'COUNT_CORRECTED' | 'COUNT_RECOUNTED' | 'COUNT_SESSION_SUBMITTED' | 'COUNT_SESSION_RECONCILED' | 'COUNT_SESSION_CANCELLED' | 'AUTHORITY_GRANTED' | 'ADMISSION_CONFIRMED' | 'AUTHORITY_REVOKED' | 'ROLE_CHANGED' | 'CONFLICT_DETECTED' | 'CONFLICT_RESOLVED' | 'RECORD_CORRECTED' | 'CADET_CREATED' | 'CADET_UPDATED' | 'BUNDLE_CREATED' | 'BUNDLE_UPDATED' | 'BUNDLE_DEACTIVATED' | 'STILL_NEEDED_ADDED' | 'STILL_NEEDED_UPDATED' | 'STILL_NEEDED_CANCELLED' | 'STILL_NEEDED_FULFILLED' | 'CALENDAR_EVENT_CREATED' | 'CALENDAR_EVENT_UPDATED' | 'CALENDAR_TASK_ADDED' | 'TASK_COMPLETED' | 'CALENDAR_ATTENDEES_ADDED' | 'CALENDAR_ATTENDEES_REMOVED' | 'CALENDAR_BUNDLES_ADDED' | 'CALENDAR_BUNDLES_REMOVED' | 'CALENDAR_TASK_UPDATED' | 'CALENDAR_TASK_REMOVED' | 'PROPERTY_CORRECTED' | 'ANNUAL_ROLLOVER_COMPLETED' | 'CADETS_IMPORTED' | 'UNIT_KEY_ROTATED' | 'RECOVERY_KEY_REGISTERED' | 'COUNT_SESSION_REOPENED' | 'TICKET_ISSUED' | 'TICKET_CANCELLED' | 'TICKET_REDEEMED' | 'CADET_CHANNEL_CREATED' | 'CADET_CHANNEL_ROTATED' | 'CADET_NOTICES_KEY_CREATED' | 'CADET_TICKET_ISSUED' | 'NOTICE_SENT'
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
  /**
   * Lamport clock: one more than the highest clock the author had seen. Every device folds
   * events in (clock, eventId) order, so the same set of events always yields the same state
   * no matter which order the chain delivered them in. Absent on legacy events (treated as 0).
   */
  clock?: number
  baseVersion?: number
  payload: Record<string, unknown>
}
export type SignedArgusEvent = UnsignedArgusEvent & { signature: string }

export type AuditDeliveryStatus = 'NOT_SUBMITTED' | 'PENDING' | 'BROADCAST' | 'CONFIRMED' | 'PROOF_VERIFIED' | 'FAILED'
/** syncStatus, auditStatus, transactionId, blockHeight and lastError are this device's delivery metadata (see distributed/delivery.ts); only `event` is ever folded. */
export type StoredEvent = { event: SignedArgusEvent; syncStatus: LocalSyncStatus; auditStatus: AuditDeliveryStatus; receivedAt: string; transactionId?: string; blockHeight?: number; lastError?: string }
export type OutboxRecord = { eventId: string; attempts: number; status: 'QUEUED' | 'SYNCING' | 'FAILED'; lastError?: string }
/**
 * One projection represents exactly one stock keeping variant (one size of one catalog item).
 * lastCountedAt/lastCountEventId come from the event that last set on-hand from a physical count
 * (its own timestamp, so every device agrees).
 */
export type InventoryProjection = { entityId: string; catalogId?: string; name: string; category: string; variant: string; niin: string; onHand: number; issued: number; reorderAt?: number; countIncrement: number; active: boolean; version: number; appliedEventIds: string[]; lastCountedAt?: string; lastCountEventId?: string }
/**
 * A catalog item groups the sizes (inventory variants) of one kind of gear, e.g. "PT Shorts"
 * with sizes S/M/L. Unsized gear has exactly one variant labelled ONE_SIZE_LABEL.
 */
export type CatalogItemProjection = { catalogId: string; name: string; category: string; niin: string; sized: boolean; sizeScheme?: string; reorderAt?: number; countIncrement: number; active: boolean; origin: 'GENESIS' | 'EVENT'; version: number; appliedEventIds: string[] }
export type ConflictRecord = { id: string; entityId: string; eventIds: string[]; status: 'OPEN' | 'RESOLVED'; reason: string; resolutionEventId?: string; transactionId?: string; inventoryItemIds?: string[]; cadetId?: string; losingEventId?: string; shortfalls?: ConflictShortfall[]; outcome?: ConflictOutcome }
/**
 * The impossible physical state a conflicting event would have produced, e.g. "would leave −1
 * SDB Jacket · Medium": STOCK means on-hand, PROPERTY means what the cadet holds.
 */
export type ConflictShortfall = { kind: 'STOCK' | 'PROPERTY'; itemId: string; label: string; variant: string; available: number; requested: number }
/**
 * How an authorized person settled a conflict (master spec §23). KEEP_AS_IS leaves the losing event
 * unapplied; RECORD_STILL_NEEDED turns the losing issue's lines into Still Needed for its cadet on
 * every device. Legacy resolutions without an outcome read as KEEP_AS_IS.
 */
export type ConflictOutcome = 'KEEP_AS_IS' | 'RECORD_STILL_NEEDED'
/** Master spec §12: RECORD_CORRECTED changes exactly one recorded quantity; the original event stays in history. */
export type RecordCorrectionKind = 'RECEIPT_QUANTITY' | 'ISSUE_QUANTITY' | 'RETURN_QUANTITY'
/** Only SERVICEABLE returns go back on the shelf; the others clear the cadet's property without adding to on-hand. */
export type ReturnCondition = 'SERVICEABLE' | 'NEEDS_REPAIR' | 'UNSERVICEABLE' | 'LOST'
/** A signed event that could not be applied in canonical order (missing dependency, invalid, unauthorized). Kept, never dropped: a later event may make it applicable. */
export type RejectedEventRecord = { eventId: string; eventType: DistributedEventType; reason: string }
/** ecdhPublicKey lets any Master hand this member a new unit key after a rotation, without meeting them again. credentialEventId points at the event carrying the member's current credential. */
export type MemberProjection = { publicIdentity: string; displayName: string; role: ArgusRole; credentialId: string; credentialEventId?: string; issuedAt: string; expiresAt?: string; walletAddress?: string; ecdhPublicKey?: string; admittedBy: string; admittedEventId: string; status: 'INVITED' | 'ACTIVE' | 'REVOKED'; activatedAt?: string; activationEventId?: string; revokedAt?: string; roleChangedAt?: string }
/** Kept separately so a confirmation whose Lamport order precedes its invitation activates it when the invitation folds later. */
export type AdmissionConfirmationProjection = { publicIdentity: string; credentialId: string; confirmedAt: string; eventId: string }
/**
 * One unit data key generation. The key itself never appears here: the UNIT_KEY_ROTATED event
 * carries one ECDH-wrapped copy per remaining member (and one for the unit recovery key), and is
 * itself encrypted under the previous key, so a removed member can read neither.
 */
export type KeyEpochProjection = { epochId: string; previousEpoch: string; reason: 'REVOCATION' | 'MANUAL'; rotatedBy: string; rotatedAt: string; eventId: string; recipients: string[] }
/**
 * One admission ticket (ADR 012) as the unit's history shows it, folded from the TICKET_ISSUED, TICKET_CANCELLED and
 * TICKET_REDEEMED facts: the first of a cancellation and a redemption in the unit's order closes it. It holds no secret.
 * Whether an OPEN ticket has run out of time depends on the viewer's clock, so the fold never decides it (see listTickets).
 */
export type TicketProjection = { ticketId: string; ticketAddress: string; ticketEcdhPublicKey: string; displayName: string; role: ArgusRole; issuedAt: string; expiresAt: string; funding: { txid: string; vout: number; satoshis: number }; issuedBy: string; issuedEventId: string; status: 'OPEN' | 'REDEEMED' | 'CANCELLED'; cancelReason?: 'CANCELLED' | 'EXPIRED'; cancelledAt?: string; spendTxid?: string; redeemedAt?: string; redeemedBy?: string }
/**
 * A cadet's private channel (ADR 013): the AES-256 key (64 hex characters) that seals the cadet's record, and the testnet
 * address derived from it (channelAddress) that the record is paid to. Only the unit log, sealed under the unit key, carries the
 * key; the cadet's phone gets it in its ticket. version counts the keys: a rotation (Replace phone) makes a new key and address.
 */
export type CadetChannelProjection = { cadetId: string; channelKey: string; channelAddress: string; version: number; createdBy: string; createdAt: string; updatedAt: string; eventId: string; rotationReason?: string }
/**
 * A cadet's ticket (ADR 013, mw-kmgi38.2) as the unit log records it: which cadet, where the ticket lives, which channel it grants
 * (the channel's address when it was made: after Replace phone it is stale), and the funding output a redemption spends. It holds
 * no key and no code. A cadet never writes to the unit log, so whether the ticket was used is read from the cadet's channel.
 */
export type CadetTicketProjection = { ticketId: string; cadetId: string; ticketAddress: string; channelAddress: string; issuedAt: string; expiresAt: string; funding: { txid: string; vout: number; satoshis: number }; issuedBy: string; issuedEventId: string }
/** Who a notice is for (ADR 013): every cadet (the notices channel), or one cadet (that cadet's channel). */
export type NoticeAudience = 'all' | { cadetId: string }
/**
 * A notice staff sent (ADR 013, mw-kmgi38.5) as the unit log has it, from NOTICE_SENT. The text is also sealed to the audience's
 * channel by the sending device; the cadet reads it there. sentBy is the sender's public identity (the panel shows their name).
 */
export type NoticeProjection = { noticeId: string; audience: NoticeAudience; text: string; sentBy: string; sentAt: string; eventId: string }
/** The unit's one notices channel (ADR 013): a notice to all cadets is sealed under this key and paid to this address. */
export type NoticesChannelProjection = { key: string; address: string; createdBy: string; createdAt: string; eventId: string }
/**
 * A cadet's own record (ADR 013): exactly what staff seal to the cadet's channel and nothing else (no gender, level, status,
 * notes, staff names or record IDs). Have lines are what the cadet holds now; Still needed lines are the open part of each need.
 * version rises with every folded change to the cadet or to one of the cadet's Still Needed lines, so a cadet's phone can keep
 * the newest record it reads.
 */
export type CadetView = { cadetId: string; cadetCode: string; fullName: string; sizes: Record<string, string>; have: CadetViewHaveLine[]; stillNeeded: CadetViewNeedLine[]; version: number; updatedAt: string }
export type CadetViewHaveLine = { itemId: string; label: string; size: string; quantity: number; issuedAt: string }
export type CadetViewNeedLine = { label: string; size?: string; quantity: number }
/** Public half of the unit recovery key; every rotation also wraps the new key to it so a recovery file never goes stale. */
export type RecoveryKeyProjection = { publicKey: string; fingerprint: string; registeredBy: string; registeredAt: string; eventId: string }

export type CountSessionStatus = 'DRAFT' | 'ACTIVE' | 'SUBMITTED' | 'RECONCILED' | 'CANCELLED'
export type CountAssignment = { assignmentId: string; itemId: string; scope: string; assignedTo?: string }
/**
 * corrections lists every COUNT_CORRECTED applied to this observation in canonical order; one the
 * submitter/finalizer had not seen is `late` and never changes a frozen total. supersedes is the
 * recount's own list of observations it replaces.
 */
export type CountCorrection = { eventId: string; quantity: number; late?: boolean }
export type CountObservation = { eventId: string; itemId: string; assignmentId: string; actorPublicIdentity: string; quantity: number; effectiveQuantity: number; status: 'ACCEPTED' | 'SUPERSEDED' | 'CORRECTED' | 'LATE'; note?: string; timestamp?: string; corrections?: CountCorrection[]; supersedes?: string[] }
export type CountSessionProjection = {
  sessionId: string
  scope: string
  status: CountSessionStatus
  createdBy?: string
  createdAt?: string
  baseline: Record<string, { quantity: number; inventoryVersion: number }>
  assignments: CountAssignment[]
  participants: string[]
  observations: CountObservation[]
  totals: Record<string, number>
  acceptedEventIds?: string[]
  lateEventIds: string[]
  reconciledEventId?: string
  reconciledBy?: string
  reconciledAt?: string
  /** Counted items whose stock moved (issue/return/receive) between session start and finalization. Shown for review; never silently ignored. */
  movementWarnings?: string[]
  /** Submitted for an officer's approval (lifecycle NEEDS_APPROVAL while status is SUBMITTED). */
  submittedBy?: string
  submittedAt?: string
  /** The last time an officer sent a submitted count back for more counting. */
  sentBack?: { by: string; at: string; reason: string; eventId: string }
  appliedEventIds: string[]
}

export type NsLevel = 'NS1' | 'NS2' | 'NS3' | 'NS4'
export type CadetGender = 'Male' | 'Female'
export type CurrentPropertyLine = { propertyId: string; itemId: string; label: string; variant: string; quantity: number; issuedAt: string; issueEventId: string; issueTransactionId: string; bundleId?: string; bundleVersion?: number }
/**
 * cadetCode is the short opaque ID shown everywhere by default (e.g. "C-4F7K"). fullName is
 * optional: when present it only ever travels inside AES-GCM ciphertext and lives in memory on
 * unlocked devices; it is never written to disk or the chain in plaintext.
 */
export type CadetProjection = { cadetId: string; cadetCode?: string; fullName: string; gender: CadetGender; profileNeedsReview?: boolean; nsLevel: NsLevel; status: 'ACTIVE' | 'INACTIVE'; sizes: Record<string, string>; currentProperty: CurrentPropertyLine[]; createdAt: string; updatedAt: string; version: number; appliedEventIds: string[] }
/** itemId pins one exact variant (legacy); catalogId names the catalog item whose size is chosen per cadet at issue time. */
export type BundleLineProjection = { lineId: string; itemId?: string; catalogId?: string; displayLabel: string; required: boolean; supportsSizing: boolean; defaultQuantity: number; order: number }
export type BundleVersionProjection = { bundleId: string; displayName: string; genderApplicability: CadetGender | 'Any'; purpose: string; lines: BundleLineProjection[]; active: boolean; version: number; createdAt: string; actorPublicIdentity: string; priorVersion?: number; eventId: string }
export type BundleProjection = { bundleId: string; currentVersion: number; versions: BundleVersionProjection[]; appliedEventIds: string[] }
/** catalogId names the catalog item when no exact size (itemId) was known; closeReason explains a manual fulfil or cancel. */
export type StillNeededProjection = { requirementId: string; cadetId: string; itemId?: string; catalogId?: string; displayLabel: string; size?: string; quantityNeeded: number; quantityFulfilled: number; status: 'OPEN' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'CANCELLED'; firstNeededAt: string; updatedAt: string; source: 'MANUAL' | 'INCOMPLETE_ISSUE' | 'CORRECTION' | 'CONFLICT_RESOLUTION'; relatedTransactionIds?: string[]; relatedBundleId?: string; bundleVersion?: number; closeReason?: string; version: number; appliedEventIds: string[] }
/**
 * quantity is what the signed event recorded; correctedQuantity (projection only) is the value after
 * RECORD_CORRECTED. Return lines may carry a condition and note; returnedFrom (projection only)
 * snapshots the property the line returned so a quantity correction can restore it.
 */
export type SupplyTransactionLine = { lineId: string; itemId: string; label: string; variant: string; quantity: number; baseVersion: number; propertyId?: string; requirementId?: string; condition?: ReturnCondition; note?: string; correctedQuantity?: number; returnedFrom?: Omit<CurrentPropertyLine, 'quantity'> }
export type MissingIssueLine = { lineId: string; itemId?: string; catalogId?: string; label: string; variant?: string; quantity: number; required: true }
export type SupplyTransaction = { transactionId: string; transactionType: 'ISSUE'|'RETURN'; cadetId: string; actorId: string; createdAt: string; eventId: string; bundleId?: string; bundleVersion?: number; bundleSnapshot?: BundleVersionProjection; lines: SupplyTransactionLine[]; missingLines?: MissingIssueLine[] }

/** Supply calendar (master spec §14–19). Dates are entered by hand each year; tasks are due relative to the event date. */
export type SupplyEventKind = 'NCO' | 'BLT' | 'AMI' | 'MILITARY_BALL' | 'END_OF_YEAR' | 'CUSTOM'
export type CalendarTaskProjection = { taskId: string; title: string; dueOffsetDays: number; completed: boolean; completedBy?: string; completedAt?: string }
export type CalendarEventProjection = { calendarEventId: string; kind: SupplyEventKind; title: string; startsAt: string; notes?: string; bundleIds: string[]; cadetIds: string[]; tasks: CalendarTaskProjection[]; active: boolean; createdBy: string; createdAt: string; version: number; appliedEventIds: string[]; removedTasks?: RemovedCalendarTask[]; fieldRevisions?: CalendarFieldRevisions }
/** A removed preparation task keeps its completion history; it just leaves the checklist. */
export type RemovedCalendarTask = CalendarTaskProjection & { removedBy: string; removedAt: string }
/** Scalar event details that two devices can edit concurrently; each edit names the revisions of the fields it changed. */
export type CalendarScalarField = 'title' | 'startsAt' | 'notes' | 'active' | 'kind'
/**
 * For each scalar field, the IDs of the events that wrote its current value (the creation event
 * when absent; several when concurrent edits wrote the same value). An edit whose author had seen
 * none of them, and that writes a different value, is a concurrent edit of the same field: a conflict.
 */
export type CalendarFieldRevisions = Partial<Record<CalendarScalarField, string[]>>
/** Append-only record that one issued line was wrong (e.g. 34R issued, 32R correct). The original issue event stays in history. */
export type PropertyCorrection = { correctionId: string; cadetId: string; propertyId: string; originalEventId: string; fromItemId: string; toItemId: string; quantity: number; reason: string; actor: string; at: string; eventId: string }
export type RolloverRecord = { schoolYear: string; eventId: string; at: string; actor: string; advanced: number; graduated: number }
