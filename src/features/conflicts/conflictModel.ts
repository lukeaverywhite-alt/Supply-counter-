import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { ConflictOutcome, ConflictRecord, ConflictShortfall } from '../../distributed/types'
import { ONE_SIZE_LABEL, cadetLabel } from '../../stage3/domain'

type Projection = Pick<ArgusAppProjection, 'events' | 'transactions' | 'cadets' | 'conflicts' | 'rejected'>

export const OUTCOME_LABELS: Record<ConflictOutcome, string> = { KEEP_AS_IS: 'Kept as is', RECORD_STILL_NEEDED: 'Recorded as Still Needed' }

const variantText = (variant: string) => (variant === ONE_SIZE_LABEL || variant === 'No variant' ? '' : ` · ${variant}`)
/** "Would leave −1 SDB Jacket · Medium (0 on hand, 1 requested)" — the physical state the losing event would have caused. */
export function describeShortfall(shortfall: ConflictShortfall, holder = 'The cadet') {
  const missing = shortfall.requested - shortfall.available, item = `${shortfall.label}${variantText(shortfall.variant)}`
  return shortfall.kind === 'STOCK'
    ? `Would leave −${missing} ${item} (${shortfall.available} on hand, ${shortfall.requested} requested)`
    : `${holder} would hold −${missing} ${item} (${shortfall.available} held, ${shortfall.requested} requested)`
}

export function cadetCode(projection: Pick<ArgusAppProjection, 'cadets'>, cadetId?: string) {
  const cadet = cadetId ? projection.cadets.find(candidate => candidate.cadetId === cadetId) : undefined
  return cadet ? cadetLabel(cadet) : undefined
}

/** An event is not applied when it lost a conflict or could not be folded at all. */
export function isApplied(projection: Projection, eventId: string) {
  return !projection.conflicts.some(conflict => conflict.losingEventId === eventId) && !projection.rejected.some(record => record.eventId === eventId)
}

type Line = { label?: string; variant?: string; quantity?: number }
const lineText = (line: Line) => `${line.quantity ?? ''} × ${line.label ?? ''}${line.variant ? variantText(line.variant) : ''}`

const FIELD_LABELS: Record<string, string> = { name: 'name', category: 'category', niin: 'NIIN', sizeScheme: 'size scheme', reorderAt: 'low-stock threshold', countIncrement: 'count increment', active: 'active status', title: 'title', startsAt: 'date and time', notes: 'notes', kind: 'event type' }
const valueText = (value: unknown) => {
  if (typeof value === 'boolean') return value ? 'active' : 'inactive'
  if (value === undefined || value === null || value === '') return '“blank”'
  return `“${String(value)}”`
}
const editText = (payload: Record<string, unknown>) => Object.entries(payload)
  .filter(([field]) => field !== 'baseRevisions' && field in FIELD_LABELS)
  .map(([field, value]) => `${FIELD_LABELS[field]} = ${valueText(value)}`)
  .join(', ')

/** A readable summary of one competing event: what it did, to whom, when, and by whom. */
export function describeEvent(projection: Projection, eventId: string, memberName: (publicIdentity: string) => string) {
  const record = projection.events.find(candidate => candidate.event.eventId === eventId)
  if (!record) return { label: 'Event not yet received on this device', when: '', who: '', applied: false }
  const { event } = record, payload = event.payload
  const cadet = cadetCode(projection, typeof payload.cadetId === 'string' ? payload.cadetId : undefined)
  const lines = Array.isArray(payload.lines) ? (payload.lines as Line[]).map(lineText).join(', ') : ''
  let label: string
  switch (event.eventType) {
    case 'ITEM_ISSUED': label = `Issue${cadet ? ` to ${cadet}` : ''}${lines ? `: ${lines}` : ''}`; break
    case 'ITEM_RETURNED': label = `Return${cadet ? ` from ${cadet}` : ''}${lines ? `: ${lines}` : ''}`; break
    case 'RECORD_CORRECTED': label = `Quantity correction: ${String(payload.from)} → ${String(payload.to)}${typeof payload.reason === 'string' ? ` (“${payload.reason}”)` : ''}`; break
    case 'INVENTORY_RECEIVED': label = `Stock received: ${String(payload.quantity)}`; break
    case 'CATALOG_ITEM_UPDATED': label = `Catalog edit: ${editText(payload) || 'details changed'}`; break
    case 'CALENDAR_EVENT_UPDATED': label = `Calendar edit: ${editText(payload) || 'details changed'}`; break
    default: label = event.eventType.replaceAll('_', ' ').toLowerCase()
  }
  return { label, when: new Date(event.timestamp).toLocaleString(), who: memberName(event.actorPublicIdentity), applied: isApplied(projection, eventId) }
}

/**
 * The lines RECORD_STILL_NEEDED would turn into Still Needed: every line (and still-needed line) of
 * the losing, unapplied issue. Undefined when the conflict did not come from an issue.
 */
export function losingIssueLines(projection: Projection, conflict: ConflictRecord) {
  if (!conflict.losingEventId || !conflict.cadetId || projection.transactions.some(transaction => transaction.eventId === conflict.losingEventId)) return undefined
  const event = projection.events.find(record => record.event.eventId === conflict.losingEventId)?.event
  if (!event || event.eventType !== 'ITEM_ISSUED' || !Array.isArray(event.payload.lines)) return undefined
  const missing = Array.isArray(event.payload.missingLines) ? event.payload.missingLines as Line[] : []
  return [...(event.payload.lines as Line[]), ...missing].map(lineText)
}
