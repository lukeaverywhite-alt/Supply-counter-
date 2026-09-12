import type { RepositoryState } from './storage/repository'

export type IntegrityIssue = { code: string; entityId: string; message: string }
export type IntegrityReport = { healthy: boolean; issues: IntegrityIssue[]; orphanReferences: number; projectionErrors: number; migrationWarnings: number }

export function inspectRepository(state: RepositoryState): IntegrityReport {
  const issues: IntegrityIssue[] = []
  const add = (code: string, entityId: string, message: string) => issues.push({ code, entityId, message })
  const inventory = new Set(state.inventory.map(item => item.entityId)), cadets = new Set(state.cadets.map(cadet => cadet.cadetId))
  for (const item of state.inventory) {
    if (item.onHand < 0) add('NEGATIVE_ON_HAND', item.entityId, 'Inventory on hand cannot be negative.')
    if (item.issued < 0) add('NEGATIVE_ISSUED', item.entityId, 'Inventory issued cannot be negative.')
    if (new Set(item.appliedEventIds).size !== item.appliedEventIds.length) add('DUPLICATE_APPLIED_EVENT', item.entityId, 'Projection contains duplicate applied event IDs.')
  }
  for (const cadet of state.cadets) for (const property of cadet.currentProperty) if (!inventory.has(property.itemId)) add('ORPHAN_PROPERTY_ITEM', cadet.cadetId, 'Current property references missing inventory.')
  for (const requirement of state.stillNeeded) {
    if (!cadets.has(requirement.cadetId)) add('ORPHAN_REQUIREMENT_CADET', requirement.requirementId, 'Still Needed references a missing cadet.')
    if (requirement.itemId && !inventory.has(requirement.itemId)) add('ORPHAN_REQUIREMENT_ITEM', requirement.requirementId, 'Still Needed references missing inventory.')
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
  const orphanReferences = issues.filter(issue => issue.code.includes('ORPHAN')).length
  const migrationWarnings = state.cadets.filter(cadet => cadet.profileNeedsReview).length
  return { healthy: issues.length === 0, issues, orphanReferences, projectionErrors: issues.length - orphanReferences, migrationWarnings }
}
