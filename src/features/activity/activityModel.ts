import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { canonicalize, sha256 } from '../../distributed/canonical'
import { isVerified } from '../../distributed/delivery'
import type { DistributedEventType, LocalSyncStatus, SignedArgusEvent, StoredEvent } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { roleLabel } from '../../unit/screens/labels'
import { plural } from '../../plural'

/**
 * Activity / audit view model (master spec §36). Everything here is plain words derived from the
 * shared projection: cadets appear only by cadet ID, and no names, notes, keys, key grants or
 * other secret material ever reach the text.
 */

export type ActivityRecord = { kind: string; label: string }
export type ActivityCorrection = { originalEventId: string; from?: string; to?: string }
export type ActivityDescription = {
  /** One plain sentence, e.g. "Received 12 × PT Shorts · M". */
  title: string
  /** What the change is about, e.g. { kind: 'Item', label: 'PT Shorts · M' }. */
  record: ActivityRecord
  /** Set when this entry corrects an earlier one. */
  correction?: ActivityCorrection
}

type Projection = Pick<ArgusAppProjection, 'inventory' | 'catalog' | 'cadets' | 'countSessions' | 'calendar' | 'bundles' | 'stillNeeded' | 'conflicts' | 'members' | 'keyEpochs' | 'tickets' | 'rollovers' | 'events' | 'transactions'>
type Line = { label?: unknown; variant?: unknown; quantity?: unknown; itemId?: unknown }

/** Payload fields that may hold a person's name or free text: never shown, even when a correction targets them. */
const PRIVATE_FIELDS = new Set(['fullName', 'displayName', 'note', 'reason', 'resolution'])
const FIELD_LABELS: Record<string, string> = { fullName: 'name', nsLevel: 'NS level', profileNeedsReview: 'review flag', reorderAt: 'low-stock level', countIncrement: 'count step', niin: 'NIIN', sizeScheme: 'size scheme', startsAt: 'date', bundleIds: 'bundles', cadetIds: 'cadets', quantityNeeded: 'quantity needed', quantityFulfilled: 'quantity issued', displayLabel: 'label', itemId: 'item' }
const fields = (payload: Record<string, unknown>) => Object.keys(payload).map(key => FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ')
const text = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.trim() : fallback

export function describeActivity(projection: Projection, record: StoredEvent, memberName: (publicIdentity: string) => string): ActivityDescription {
  const { event } = record, payload = event.payload
  const item = (id: unknown) => { const found = projection.inventory.find(candidate => candidate.entityId === id); return found ? `${found.name} · ${found.variant}` : 'an item' }
  const catalog = (id: unknown) => projection.catalog.find(candidate => candidate.catalogId === id)?.name
  const cadet = (id: unknown) => { const found = projection.cadets.find(candidate => candidate.cadetId === id); return found ? cadetLabel(found) : 'a cadet' }
  const scope = (id: unknown) => projection.countSessions.find(session => session.sessionId === id)?.scope
  const count = (id: unknown) => { const name = scope(id) ?? (id === event.entityId && typeof payload.scope === 'string' ? payload.scope : undefined); return name ? `“${name}”` : 'a count' }
  const person = (publicIdentity: string) => projection.members.find(member => member.publicIdentity === publicIdentity)?.displayName ?? memberName(publicIdentity)
  const calendar = (id: unknown) => projection.calendar.find(candidate => candidate.calendarEventId === id)
  const bundle = (id: unknown) => { const found = projection.bundles.find(candidate => candidate.bundleId === id); return found?.versions.find(version => version.version === found.currentVersion)?.displayName }
  const lines = (value: unknown) => (Array.isArray(value) ? value as Line[] : []).map(line => ({ label: `${text(line.label, typeof line.itemId === 'string' ? item(line.itemId) : 'item')}${typeof line.variant === 'string' ? ` · ${line.variant}` : ''}`, quantity: Number(line.quantity) || 0 }))
  const lineSummary = (value: unknown) => { const list = lines(value); return list.slice(0, 3).map(line => `${line.label} ×${line.quantity}`).join(', ') + (list.length > 3 ? `, +${list.length - 3} more` : '') }
  const need = (id: string) => {
    const open = projection.stillNeeded.find(candidate => candidate.requirementId === id)
    if (open) return { cadetId: open.cadetId, label: `${open.displayLabel}${open.size ? ` · ${open.size}` : ''}` }
    const added = projection.events.find(stored => stored.event.eventType === 'STILL_NEEDED_ADDED' && stored.event.entityId === id)?.event.payload
    if (added) return { cadetId: added.cadetId, label: `${text(added.displayLabel, 'item')}${typeof added.size === 'string' ? ` · ${added.size}` : ''}` }
    const [, eventId, lineId] = id.split(':') // need:<issue event>:<line> for lines an issue could not fill
    const issue = projection.events.find(stored => stored.event.eventId === eventId)?.event.payload
    const line = (Array.isArray(issue?.missingLines) ? issue.missingLines as Array<Line & { lineId?: unknown }> : []).find(candidate => candidate.lineId === lineId)
    return { cadetId: issue?.cadetId, label: line ? `${text(line.label, 'item')}${typeof line.variant === 'string' ? ` · ${line.variant}` : ''}` : 'an item' }
  }

  const type: DistributedEventType = event.eventType
  switch (type) {
    case 'INVENTORY_ITEM_CREATED': {
      const label = projection.inventory.some(candidate => candidate.entityId === event.entityId) ? item(event.entityId) : `${text(payload.name, 'item')}${typeof payload.variant === 'string' ? ` · ${payload.variant}` : ''}`
      return { title: `Added inventory item ${label}`, record: { kind: 'Item', label } }
    }
    case 'INVENTORY_ITEM_UPDATED':
      return { title: `Updated ${fields(payload) || 'details'} of ${item(event.entityId)}`, record: { kind: 'Item', label: item(event.entityId) } }
    case 'INVENTORY_RECEIVED':
      return { title: `Received ${Number(payload.quantity)} × ${item(event.entityId)}`, record: { kind: 'Item', label: item(event.entityId) } }
    case 'CATALOG_ITEM_CREATED': {
      const name = catalog(event.entityId) ?? text(payload.name, 'an item')
      return { title: `Added catalog item ${name}`, record: { kind: 'Catalog item', label: name } }
    }
    case 'CATALOG_ITEM_UPDATED': {
      const name = catalog(event.entityId) ?? 'a catalog item'
      return { title: `Updated ${fields(payload) || 'details'} of ${name}`, record: { kind: 'Catalog item', label: name } }
    }
    case 'CATALOG_SIZES_ADDED': {
      const sizes = (Array.isArray(payload.sizes) ? payload.sizes as Array<{ label?: unknown }> : []).map(size => String(size.label))
      const name = catalog(event.entityId) ?? 'an item'
      return { title: `Added sizes ${sizes.slice(0, 6).join(', ')}${sizes.length > 6 ? '…' : ''} to ${name}`, record: { kind: 'Catalog item', label: name } }
    }
    case 'ITEM_ISSUED':
    case 'ITEM_RETURNED': {
      const issued = type === 'ITEM_ISSUED'
      if (!Array.isArray(payload.lines)) { // legacy single-item stock movement
        const quantity = Number(payload.quantity ?? 0)
        return { title: `${issued ? 'Issued' : 'Returned'} ${quantity} × ${item(event.entityId)}`, record: { kind: 'Item', label: item(event.entityId) } }
      }
      const quantity = lines(payload.lines).reduce((sum, line) => sum + line.quantity, 0), who = cadet(payload.cadetId)
      const detail = lineSummary(payload.lines), applied = projection.transactions.some(transaction => transaction.eventId === event.eventId)
      return { title: `${issued ? 'Issued' : 'Returned'} ${plural(quantity, 'item')} ${issued ? 'to' : 'from'} ${who}${applied ? '' : ' (not applied — see conflicts)'}`, record: { kind: 'Cadet', label: detail ? `${who} · ${detail}` : who } }
    }
    case 'INVENTORY_COUNT_SUBMITTED':
      return { title: `Counted ${Number(payload.countedQuantity)} × ${item(event.entityId)}`, record: { kind: 'Item', label: item(event.entityId) } }
    case 'COUNT_SESSION_CREATED':
      return { title: `Started shared count ${count(event.entityId)}`, record: { kind: 'Count', label: count(event.entityId) } }
    case 'COUNT_CONTRIBUTED':
      return { title: `Counted ${Number(payload.quantity)} × ${item(payload.itemId)}`, record: { kind: 'Count', label: `${item(payload.itemId)} in ${count(event.entityId)}` } }
    case 'COUNT_RECOUNTED':
      return { title: `Recounted ${item(payload.itemId)}: ${Number(payload.quantity)}`, record: { kind: 'Count', label: `${item(payload.itemId)} in ${count(event.entityId)}` } }
    case 'COUNT_CORRECTED': {
      const original = projection.countSessions.find(session => session.sessionId === event.entityId)?.observations.find(observation => observation.eventId === payload.originalEventId)
      const label = original ? `${item(original.itemId)} in ${count(event.entityId)}` : count(event.entityId)
      return { title: `Corrected a count to ${Number(payload.replacementQuantity)}`, record: { kind: 'Count', label }, correction: { originalEventId: String(payload.originalEventId ?? ''), ...(original ? { from: String(original.quantity) } : {}), to: String(payload.replacementQuantity) } }
    }
    case 'COUNT_SESSION_SUBMITTED':
      return { title: `Submitted count ${count(event.entityId)} for approval`, record: { kind: 'Count', label: count(event.entityId) } }
    case 'COUNT_SESSION_REOPENED':
      return { title: `Sent count ${count(event.entityId)} back for recounting`, record: { kind: 'Count', label: count(event.entityId) } }
    case 'COUNT_SESSION_RECONCILED':
      return { title: `Finalized count ${count(event.entityId)} — on-hand updated`, record: { kind: 'Count', label: count(event.entityId) } }
    case 'COUNT_SESSION_CANCELLED':
      return { title: `Cancelled count ${count(event.entityId)}`, record: { kind: 'Count', label: count(event.entityId) } }
    case 'AUTHORITY_GRANTED': {
      const name = text(payload.displayName, person(event.entityId)), role = (payload.credential as { role?: string } | undefined)?.role
      return { title: `Invited ${name}${role ? ` as ${roleLabel(role)}` : ''}`, record: { kind: 'Member', label: name } }
    }
    case 'ADMISSION_CONFIRMED':
      return { title: `${person(event.entityId)} activated their device`, record: { kind: 'Member', label: person(event.entityId) } }
    case 'AUTHORITY_REVOKED':
      return { title: `Removed access for ${person(event.entityId)}`, record: { kind: 'Member', label: person(event.entityId) } }
    case 'ROLE_CHANGED': {
      const role = (payload.credential as { role?: string } | undefined)?.role
      return { title: `${person(event.entityId)} is now ${role ? roleLabel(role) : 'in a new role'}`, record: { kind: 'Member', label: person(event.entityId) } }
    }
    case 'CONFLICT_DETECTED':
    case 'CONFLICT_RESOLVED': {
      const conflict = projection.conflicts.find(candidate => candidate.id === payload.conflictId)
      const subject = conflict ? [...new Set((conflict.inventoryItemIds?.length ? conflict.inventoryItemIds : [conflict.entityId]).map(id => projection.inventory.some(candidate => candidate.entityId === id) ? item(id) : cadet(id)))].join(', ') + (conflict.cadetId ? ` · ${cadet(conflict.cadetId)}` : '') : 'a conflict'
      return { title: type === 'CONFLICT_RESOLVED' ? `Resolved a conflict over ${subject}` : `Conflict detected over ${subject}`, record: { kind: 'Conflict', label: subject } }
    }
    case 'RECORD_CORRECTED': {
      // Quantity corrections name what was corrected and from → to; the free-text reason stays out of the feed.
      const kind = payload.kind, from = String(payload.from ?? '?'), to = String(payload.to ?? '?'), original = String(payload.targetEventId ?? '')
      if (kind === 'RECEIPT_QUANTITY') return { title: `Corrected received quantity of ${item(event.entityId)}: ${from} → ${to}`, record: { kind: 'Inventory', label: item(event.entityId) }, correction: { originalEventId: original, from, to } }
      if (kind === 'ISSUE_QUANTITY' || kind === 'RETURN_QUANTITY') {
        const transaction = projection.transactions.find(candidate => candidate.eventId === original), line = transaction?.lines.find(candidate => candidate.lineId === payload.lineId)
        const subject = `${line ? `${line.label} · ${line.variant}` : 'an item'}${transaction ? ` for ${cadet(transaction.cadetId)}` : ''}`
        return { title: `Corrected ${kind === 'ISSUE_QUANTITY' ? 'issued' : 'returned'} quantity of ${subject}: ${from} → ${to}`, record: { kind: 'Cadet', label: subject }, correction: { originalEventId: original, from, to } }
      }
      const field = String(payload.field ?? 'a field'), value = payload.value
      const shown = !PRIVATE_FIELDS.has(field) && ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : undefined
      const subject = projection.inventory.some(candidate => candidate.entityId === event.entityId) ? item(event.entityId) : projection.cadets.some(candidate => candidate.cadetId === event.entityId) ? cadet(event.entityId) : 'a record'
      return { title: `Corrected ${FIELD_LABELS[field] ?? field} of ${subject}`, record: { kind: 'Record', label: subject }, correction: { originalEventId: String(payload.originalEventId ?? ''), ...(shown === undefined ? {} : { to: shown }) } }
    }
    case 'PROPERTY_CORRECTED': {
      const from = item(payload.fromItemId), to = item(payload.toItemId), quantity = Number(payload.quantity) || 1
      return { title: `Corrected issued size for ${cadet(event.entityId)}: ${from} → ${to}`, record: { kind: 'Cadet', label: `${cadet(event.entityId)} · ${quantity > 1 ? `${quantity} × ` : ''}${to}` }, correction: { originalEventId: String(payload.originalEventId ?? ''), from, to } }
    }
    case 'CADET_CREATED':
      return { title: `Added cadet ${cadet(event.entityId)}`, record: { kind: 'Cadet', label: cadet(event.entityId) } }
    case 'CADET_UPDATED':
      return { title: `Updated ${fields(payload) || 'profile'} of cadet ${cadet(event.entityId)}`, record: { kind: 'Cadet', label: cadet(event.entityId) } }
    case 'CADETS_IMPORTED': {
      const rows = Array.isArray(payload.cadets) ? payload.cadets as Array<{ cadetId?: unknown }> : []
      const codes = rows.map(row => cadet(row.cadetId))
      return { title: `Imported ${plural(rows.length, 'cadet')}`, record: { kind: 'Cadets', label: codes.length ? codes.slice(0, 4).join(', ') + (codes.length > 4 ? `, +${codes.length - 4} more` : '') : 'Cadet roster' } }
    }
    case 'ANNUAL_ROLLOVER_COMPLETED': {
      const year = text(payload.schoolYear, 'the school year'), result = projection.rollovers.find(rollover => rollover.eventId === event.eventId)
      return { title: `Completed annual rollover for ${year}`, record: { kind: 'School year', label: result ? `${year} · ${result.advanced} advanced, ${result.graduated} graduated` : year } }
    }
    case 'BUNDLE_CREATED': {
      const name = bundle(event.entityId) ?? text(payload.displayName, 'a bundle')
      return { title: `Created bundle ${name}`, record: { kind: 'Bundle', label: name } }
    }
    case 'BUNDLE_UPDATED': {
      const name = text(payload.displayName, bundle(event.entityId) ?? 'a bundle'), version = event.baseVersion === undefined ? undefined : event.baseVersion + 1
      return { title: `Edited bundle ${name}${version ? ` (version ${version})` : ''}`, record: { kind: 'Bundle', label: name } }
    }
    case 'BUNDLE_DEACTIVATED': {
      const name = bundle(event.entityId) ?? 'a bundle'
      return { title: `Deactivated bundle ${name}`, record: { kind: 'Bundle', label: name } }
    }
    case 'STILL_NEEDED_ADDED':
    case 'STILL_NEEDED_UPDATED':
    case 'STILL_NEEDED_CANCELLED':
    case 'STILL_NEEDED_FULFILLED': {
      const { cadetId, label } = need(event.entityId), who = cadet(cadetId)
      const verb = { STILL_NEEDED_ADDED: 'Marked still needed', STILL_NEEDED_UPDATED: 'Updated still needed', STILL_NEEDED_CANCELLED: 'Cancelled still needed', STILL_NEEDED_FULFILLED: 'Fulfilled still needed' }[type]
      return { title: `${verb}: ${label} for ${who}`, record: { kind: 'Still needed', label: `${who} · ${label}` } }
    }
    case 'CALENDAR_EVENT_CREATED':
    case 'CALENDAR_EVENT_UPDATED':
    case 'CALENDAR_TASK_ADDED':
    case 'CALENDAR_TASK_UPDATED':
    case 'CALENDAR_TASK_REMOVED':
    case 'CALENDAR_ATTENDEES_ADDED':
    case 'CALENDAR_ATTENDEES_REMOVED':
    case 'CALENDAR_BUNDLES_ADDED':
    case 'CALENDAR_BUNDLES_REMOVED':
    case 'TASK_COMPLETED': {
      const target = calendar(event.entityId), title = target?.title ?? text(payload.title, 'a supply event')
      const label = target ? `${target.title} · ${new Date(target.startsAt).toLocaleDateString()}` : title
      if (type === 'CALENDAR_EVENT_CREATED') return { title: `Scheduled ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_EVENT_UPDATED') return { title: payload.active === false ? `Cancelled ${title}` : `Updated ${fields(payload) || 'details'} of ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_TASK_ADDED') return { title: `Added task “${text(payload.title, 'task')}” to ${title}`, record: { kind: 'Supply event', label } }
      const count = (values: unknown) => Array.isArray(values) ? values.length : 0
      // Attendees are counted, never listed: the entry names the event, not the cadets.
      if (type === 'CALENDAR_ATTENDEES_ADDED') return { title: `Added ${plural(count(payload.cadetIds), 'attendee')} to ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_ATTENDEES_REMOVED') return { title: `Removed ${plural(count(payload.cadetIds), 'attendee')} from ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_BUNDLES_ADDED') return { title: `Linked ${plural(count(payload.bundleIds), 'bundle')} to ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_BUNDLES_REMOVED') return { title: `Unlinked ${plural(count(payload.bundleIds), 'bundle')} from ${title}`, record: { kind: 'Supply event', label } }
      const editedTask = target?.tasks.find(candidate => candidate.taskId === payload.taskId)?.title ?? text(payload.title, 'a task')
      if (type === 'CALENDAR_TASK_UPDATED') return { title: `Edited task “${editedTask}” of ${title}`, record: { kind: 'Supply event', label } }
      if (type === 'CALENDAR_TASK_REMOVED') return { title: `Removed task “${editedTask}” from ${title}`, record: { kind: 'Supply event', label } }
      const task = target?.tasks.find(candidate => candidate.taskId === payload.taskId)?.title ?? 'a task'
      return { title: `${payload.completed === false ? 'Reopened' : 'Completed'} task “${task}” for ${title}`, record: { kind: 'Supply event', label } }
    }
    case 'UNIT_KEY_ROTATED': {
      const epoch = projection.keyEpochs.find(candidate => candidate.eventId === event.eventId)
      const why = payload.reason === 'REVOCATION' ? 'after a member was removed' : 'on request'
      return { title: 'Unit key replaced', record: { kind: 'Unit key', label: `Replaced ${why}${epoch ? ` · given to ${plural(epoch.recipients.length, 'holder')}` : ''}` } }
    }
    case 'TICKET_ISSUED': {
      const name = text(payload.displayName, 'someone'), role = typeof payload.role === 'string' ? roleLabel(payload.role) : undefined
      return { title: `Made a ticket for ${name}${role ? ` as ${role}` : ''}`, record: { kind: 'Ticket', label: name } }
    }
    case 'TICKET_CANCELLED': {
      const ticket = projection.tickets.find(candidate => candidate.ticketId === event.entityId), name = ticket?.displayName ?? 'someone'
      return { title: `${payload.reason === 'EXPIRED' ? 'Closed the expired' : 'Cancelled the'} ticket for ${name}`, record: { kind: 'Ticket', label: name } }
    }
    case 'TICKET_REDEEMED': {
      const ticket = projection.tickets.find(candidate => candidate.ticketId === event.entityId), name = ticket?.displayName ?? person(event.actorPublicIdentity)
      return { title: `${name} used their ticket`, record: { kind: 'Ticket', label: name } }
    }
    case 'RECOVERY_KEY_REGISTERED':
      return { title: 'Recovery key registered', record: { kind: 'Unit key', label: 'Unit recovery file' } }
    default: {
      const unknownType: never = type
      return { title: String(unknownType).replaceAll('_', ' ').toLowerCase(), record: { kind: 'Record', label: 'Unit record' } }
    }
  }
}

/** Plain words for each §22 status; the uppercase word is what the badge shows. */
export const SYNC_STATUS_TEXT: Record<LocalSyncStatus, string> = {
  LOCAL: 'Saved on this device only',
  QUEUED: 'Saved here, waiting to be shared',
  SYNCING: 'Being shared now',
  SYNCHRONIZED: 'Shared with the whole unit',
  CONFLICT: 'Competes with another change — needs a decision',
  FAILED: 'Sharing failed; it will be tried again',
}

export type Verification = { verified: boolean; label: string }
/** Verification is separate from sync: VERIFIED only once the record's transaction is mined in a known block. */
export function verificationOf(record: StoredEvent, mode: 'local' | 'remote'): Verification {
  if (isVerified(record)) return { verified: true, label: `VERIFIED in block ${record.blockHeight}` }
  if (mode === 'local' || record.syncStatus === 'LOCAL') return { verified: false, label: 'not on a blockchain (demo)' }
  if (record.transactionId && (record.syncStatus === 'SYNCHRONIZED' || record.syncStatus === 'CONFLICT')) return { verified: false, label: 'on chain · waiting for a block' }
  return { verified: false, label: 'not yet on chain' }
}

const hashes = new Map<string, Promise<string>>()
/** SHA-256 of the canonical signed event: anyone holding the record can recompute it to check nothing changed. */
export function auditHash(event: SignedArgusEvent) {
  const key = `${event.eventId}:${event.signature}`
  let hash = hashes.get(key)
  if (!hash) { hash = sha256(canonicalize(event)); hashes.set(key, hash) }
  return hash
}
