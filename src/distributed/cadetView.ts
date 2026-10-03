import { cadetLabel } from '../stage3/domain'
import type { RepositoryState } from '../storage/repository'
import type { CadetView } from './types'

const isOpen = (status: string) => status === 'OPEN' || status === 'PARTIALLY_FULFILLED'

/**
 * The record a cadet's phone reads (ADR 013), built only from the fold, so every staff device holding the same events builds the
 * same record. Have: the cadet's current property, in fold order. Still needed: each open need's remaining quantity, with its size
 * (or, failing that, the size of the exact item it names). version is the cadet's version plus every one of the cadet's Still
 * Needed lines' versions: a need changes without touching the cadet, and the phone must still see a newer record.
 */
export function cadetViewFrom(state: Pick<RepositoryState, 'cadets' | 'stillNeeded' | 'inventory'>, cadetId: string): CadetView {
  const cadet = state.cadets.find(candidate => candidate.cadetId === cadetId)
  if (!cadet) throw new Error('Cadet was not found.')
  const needs = state.stillNeeded.filter(need => need.cadetId === cadetId)
  const sizeOf = (itemId?: string) => itemId ? state.inventory.find(item => item.entityId === itemId)?.variant : undefined
  return {
    cadetId: cadet.cadetId,
    cadetCode: cadetLabel(cadet),
    fullName: cadet.fullName,
    sizes: { ...cadet.sizes },
    have: cadet.currentProperty.map(line => ({ itemId: line.itemId, label: line.label, size: line.variant, quantity: line.quantity, issuedAt: line.issuedAt })),
    stillNeeded: needs.filter(need => isOpen(need.status) && need.quantityNeeded > need.quantityFulfilled).map(need => { const size = need.size ?? sizeOf(need.itemId); return { label: need.displayLabel, ...(size ? { size } : {}), quantity: need.quantityNeeded - need.quantityFulfilled } }),
    version: cadet.version + needs.reduce((total, need) => total + need.version, 0),
    updatedAt: [cadet.updatedAt, ...needs.map(need => need.updatedAt)].sort().at(-1)!,
  }
}
