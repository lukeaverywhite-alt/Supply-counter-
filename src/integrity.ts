import type { RepositoryState } from './storage/repository'

export type IntegrityIssue = { code: string; entityId: string; message: string }
export type IntegrityReport = { healthy: boolean; issues: IntegrityIssue[]; orphanReferences: number; projectionErrors: number; migrationWarnings: number }

/** Commit-time safety invariants. Historical/reference diagnostics remain in inspectRepository. */
export function assertRepositoryInvariants(state: RepositoryState): void {
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`Repository invariant failed: duplicate ${label}.`) }
  unique(state.events.map(value => `${value.event.organizationId}:${value.event.eventId}`), 'event identity')
  unique(state.transactions.map(value => value.transactionId), 'transaction ID')
  unique(state.auditJobs.map(value => `${value.organizationId}:${value.eventId}`), 'audit job identity')
  for (const item of state.inventory) {
    if (!Number.isInteger(item.onHand) || item.onHand < 0 || !Number.isInteger(item.issued) || item.issued < 0) throw new Error(`Repository invariant failed: invalid inventory quantity for ${item.entityId}.`)
    unique(item.appliedEventIds, `applied event on ${item.entityId}`)
  }
  for (const cadet of state.cadets) {
    unique(cadet.currentProperty.map(value => value.propertyId), `property ID on ${cadet.cadetId}`)
    if (cadet.currentProperty.some(value => !Number.isInteger(value.quantity) || value.quantity <= 0)) throw new Error(`Repository invariant failed: invalid property quantity for ${cadet.cadetId}.`)
  }
  for (const need of state.stillNeeded) if (need.quantityFulfilled < 0 || need.quantityFulfilled > need.quantityNeeded) throw new Error(`Repository invariant failed: invalid Still Needed quantity for ${need.requirementId}.`)
}

export function inspectRepository(state: RepositoryState): IntegrityReport {
  const issues: IntegrityIssue[] = []
  const add = (code: string, entityId: string, message: string) => issues.push({ code, entityId, message })
  const inventory = new Set(state.inventory.map(item => item.entityId)), cadets = new Set(state.cadets.map(cadet => cadet.cadetId)), events = new Set(state.events.map(record => record.event.eventId)), transactions = new Set(state.transactions.map(transaction => transaction.transactionId))
  for (const item of state.inventory) {
    if (item.onHand < 0) add('NEGATIVE_ON_HAND', item.entityId, 'Inventory on hand cannot be negative.')
    if (item.issued < 0) add('NEGATIVE_ISSUED', item.entityId, 'Inventory issued cannot be negative.')
    if (new Set(item.appliedEventIds).size !== item.appliedEventIds.length) add('DUPLICATE_APPLIED_EVENT', item.entityId, 'Projection contains duplicate applied event IDs.')
  }
  for (const cadet of state.cadets) { const propertyIds = new Set<string>(); for (const property of cadet.currentProperty) { if (!inventory.has(property.itemId)) add('ORPHAN_PROPERTY_ITEM', cadet.cadetId, 'Current property references missing inventory.'); if (!Number.isInteger(property.quantity) || property.quantity <= 0) add('INVALID_PROPERTY_QUANTITY', property.propertyId, 'Current property quantity must be positive.'); if (propertyIds.has(property.propertyId)) add('DUPLICATE_PROPERTY_ID', property.propertyId, 'Current property IDs must be unique per cadet.'); propertyIds.add(property.propertyId); if (!property.issueTransactionId.startsWith('legacy:') && !transactions.has(property.issueTransactionId)) add('ORPHAN_PROPERTY_TRANSACTION', property.propertyId, 'Current property references missing Issue transaction.'); if (!property.issueEventId.startsWith('legacy:') && !events.has(property.issueEventId)) add('ORPHAN_PROPERTY_EVENT', property.propertyId, 'Current property references missing Issue event.') } }
  for (const requirement of state.stillNeeded) {
    if (!cadets.has(requirement.cadetId)) add('ORPHAN_REQUIREMENT_CADET', requirement.requirementId, 'Still Needed references a missing cadet.')
    if (requirement.itemId && !inventory.has(requirement.itemId)) add('ORPHAN_REQUIREMENT_ITEM', requirement.requirementId, 'Still Needed references missing inventory.')
    for (const transactionId of requirement.relatedTransactionIds ?? []) if (!transactions.has(transactionId)) add('ORPHAN_REQUIREMENT_TRANSACTION', requirement.requirementId, 'Still Needed provenance references missing transaction.')
  }
  for (const bundle of state.bundles) {
    const versions = bundle.versions.map(version => version.version)
    if (!versions.includes(bundle.currentVersion)) add('ORPHAN_BUNDLE_VERSION', bundle.bundleId, 'Bundle current version does not exist.')
    if (new Set(versions).size !== versions.length) add('DUPLICATE_BUNDLE_VERSION', bundle.bundleId, 'Bundle version numbers are not unique.')
  }
  const eventIds = state.events.map(record => record.event.eventId)
  if (new Set(eventIds).size !== eventIds.length) add('DUPLICATE_EVENT_ID', 'repository', 'Stored event IDs are not unique.')
  const factoryIds = state.bundles.flatMap(bundle => bundle.versions.map(version => version.eventId)).filter(id => id.startsWith('factory:'))
  if (new Set(factoryIds).size !== factoryIds.length) add('DUPLICATE_FACTORY_BUNDLE', 'repository', 'Factory bundle seed is duplicated.')
  const transactionIds = state.transactions.map(transaction => transaction.transactionId)
  if (new Set(transactionIds).size !== transactionIds.length) add('DUPLICATE_TRANSACTION_ID', 'repository', 'Supply transaction IDs are not unique.')
  for (const transaction of state.transactions) { if (!cadets.has(transaction.cadetId)) add('ORPHAN_TRANSACTION_CADET', transaction.transactionId, 'Transaction references missing cadet.'); if (!events.has(transaction.eventId)) add('ORPHAN_TRANSACTION_EVENT', transaction.transactionId, 'Transaction references missing event.'); for (const line of transaction.lines) { if (!inventory.has(line.itemId)) add('ORPHAN_TRANSACTION_ITEM', transaction.transactionId, 'Transaction line references missing inventory.'); if (!Number.isInteger(line.quantity) || line.quantity <= 0) add('INVALID_TRANSACTION_QUANTITY', transaction.transactionId, 'Transaction quantities must be positive.') } if (transaction.bundleSnapshot && transaction.bundleSnapshot.version !== transaction.bundleVersion) add('INVALID_BUNDLE_SNAPSHOT', transaction.transactionId, 'Bundle snapshot does not match recorded version.') }
  const orphanReferences = issues.filter(issue => issue.code.includes('ORPHAN')).length
  const migrationWarnings = state.cadets.filter(cadet => cadet.profileNeedsReview).length
  return { healthy: issues.length === 0, issues, orphanReferences, projectionErrors: issues.length - orphanReferences, migrationWarnings }
}
