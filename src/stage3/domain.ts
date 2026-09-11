import { matchesSearch } from '../domain'
import type { BundleLineProjection, BundleVersionProjection, CadetGender, CadetProjection, InventoryProjection, NsLevel, StillNeededProjection } from '../distributed/types'

const levels: NsLevel[] = ['NS1', 'NS2', 'NS3', 'NS4']
const genders: CadetGender[] = ['Male', 'Female']
export function validateCadet(value: Pick<CadetProjection, 'fullName' | 'gender' | 'nsLevel' | 'status' | 'sizes'>) {
  if (!value.fullName.trim()) throw new Error('Cadet name is required.')
  if (!genders.includes(value.gender)) throw new Error('Gender must be Male or Female.')
  if (!levels.includes(value.nsLevel)) throw new Error('NS level must be NS1, NS2, NS3, or NS4.')
  if (!['ACTIVE', 'INACTIVE'].includes(value.status)) throw new Error('Cadet status is invalid.')
  if (!value.sizes || typeof value.sizes !== 'object') throw new Error('Cadet size profile is invalid.')
}
export function searchCadets(cadets: CadetProjection[], query: string, status: 'ALL' | CadetProjection['status'] = 'ACTIVE') {
  return cadets.filter(c => (status === 'ALL' || c.status === status) && matchesSearch(query, c.fullName, c.fullName.split(/\s+/).reverse().join(' '), c.nsLevel, c.status))
}
export function validateBundle(value: Pick<BundleVersionProjection, 'displayName' | 'genderApplicability' | 'lines' | 'version'>, inventory?: InventoryProjection[]) {
  if (!value.displayName.trim()) throw new Error('Bundle name is required.')
  if (![...genders, 'Any'].includes(value.genderApplicability)) throw new Error('Bundle gender applicability is invalid.')
  if (!Number.isInteger(value.version) || value.version < 1) throw new Error('Bundle version is invalid.')
  if (!value.lines.length) throw new Error('A bundle must contain at least one line.')
  if (new Set(value.lines.map(l => l.lineId)).size !== value.lines.length) throw new Error('Bundle line IDs must be unique.')
  const itemIds = value.lines.flatMap(l => l.itemId ? [l.itemId] : [])
  if (new Set(itemIds).size !== itemIds.length) throw new Error('Duplicate inventory lines are not allowed.')
  for (const line of value.lines) {
    if (!line.lineId || !line.displayLabel.trim() || !Number.isInteger(line.defaultQuantity) || line.defaultQuantity <= 0) throw new Error('Every bundle line requires a label and positive whole quantity.')
    if (line.itemId && inventory && !inventory.some(i => i.entityId === line.itemId)) throw new Error(`Inventory reference ${line.itemId} is invalid.`)
  }
}
export function validateRequirement(value: Pick<StillNeededProjection, 'cadetId' | 'displayLabel' | 'quantityNeeded' | 'quantityFulfilled' | 'status' | 'source'>) {
  if (!value.cadetId || !value.displayLabel.trim()) throw new Error('Still Needed requires a cadet and item label.')
  if (!Number.isInteger(value.quantityNeeded) || value.quantityNeeded <= 0 || !Number.isInteger(value.quantityFulfilled) || value.quantityFulfilled < 0 || value.quantityFulfilled > value.quantityNeeded) throw new Error('Still Needed quantities are invalid.')
  if (!['OPEN', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED'].includes(value.status) || !['MANUAL', 'INCOMPLETE_ISSUE', 'CORRECTION'].includes(value.source)) throw new Error('Still Needed lifecycle value is invalid.')
}
export function requirementAvailability(requirement: StillNeededProjection, inventory: InventoryProjection[]) { const item = requirement.itemId ? inventory.find(i => i.entityId === requirement.itemId) : undefined; const remaining = requirement.quantityNeeded - requirement.quantityFulfilled; return { onHand: item?.onHand ?? 0, configured: Boolean(item), available: Boolean(item && item.onHand >= remaining) } }
export function cadetReadiness(requirements: StillNeededProjection[]) { const required = requirements.filter(r => r.status !== 'CANCELLED'); const fulfilled = required.filter(r => r.status === 'FULFILLED').length; return { status: required.some(r => r.status === 'OPEN' || r.status === 'PARTIALLY_FULFILLED') ? 'INCOMPLETE' as const : 'READY' as const, fulfilled, total: required.length, percent: required.length ? Math.round(fulfilled / required.length * 100) : 100 } }
export const bundleSuggestions = (gender: CadetGender) => gender === 'Male' ? ['Male NSU', 'Male SDB', 'PT', 'Drill', 'BLT'] : ['Female NSU', 'Female SDB', 'PT', 'Drill', 'BLT']

const line = (bundle: string, label: string, order: number, required = true): BundleLineProjection => ({ lineId: `${bundle}:${order}`, displayLabel: label, required, supportsSizing: !['Buckle', 'Black Belt', 'Khaki Belt', 'Brass Buckle', 'Necktie', 'Neck Tabs'].includes(label), defaultQuantity: 1, order })
const preset = (bundleId: string, displayName: string, genderApplicability: CadetGender | 'Any', purpose: string, names: Array<string | [string, boolean]>): BundleVersionProjection => ({ bundleId, displayName, genderApplicability, purpose, lines: names.map((entry, i) => line(bundleId, typeof entry === 'string' ? entry : entry[0], i, typeof entry === 'string' ? true : entry[1])), active: true, version: 1, createdAt: '2026-09-11T00:00:00.000Z', actorPublicIdentity: 'factory:argus-stage3a', eventId: `factory:${bundleId}:v1` })
export const FACTORY_BUNDLES = [
  preset('bundle-male-nsu', 'Male NSU', 'Male', 'NSU', ['Male Khaki Shirt','Black Trousers','Garrison Cap','Black Belt','Buckle','White Dress Shirt','Black Socks','Black Oxfords']),
  preset('bundle-female-nsu', 'Female NSU', 'Female', 'NSU', ['Khaki Overblouse','Black Slacks','Garrison Cap','Black Oxfords','Pumps']),
  preset('bundle-male-sdb', 'Male SDB', 'Male', 'SDB', ['Male SDB Jacket','Necktie',['White Dress Shirt', false]]),
  preset('bundle-female-sdb', 'Female SDB', 'Female', 'SDB', ['Female SDB Jacket','Neck Tabs','White Dress Shirt']),
  preset('bundle-pt', 'PT', 'Any', 'PT', ['Gold PT Shirt','PT Shorts','Khaki Ball Cap']),
  preset('bundle-drill', 'Drill', 'Any', 'DRILL', ['Tracksuit Top','Tracksuit Bottom']),
  preset('bundle-blt', 'BLT', 'Any', 'BLT', ['Khaki Shirt','Khaki Trousers','Khaki Belt','Brass Buckle','Platoon Shirt']),
]
