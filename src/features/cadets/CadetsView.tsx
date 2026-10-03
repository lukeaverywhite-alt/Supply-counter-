import { useState } from 'react'
import { ArrowRight, Search, UserPlus, X } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { cadetFullyIssued, standardIssueGaps } from '../../stage3/readiness'
import type { NoticeSender } from '../../unit/screens/NoticesPanel'
import type { PhoneLineReader, PhoneTicketMaker } from './PhoneTicketPanel'
import { CadetDrawer } from './CadetDrawer'
import { CadetForm } from './CadetForm'
import { cadetDisplayName, cadetMatches, cadetMonogram } from './cadetDisplay'
import './cadets.css'

type Cadet = ArgusAppProjection['cadets'][number]
type StatusFilter = 'ACTIVE' | 'INACTIVE' | 'ALL'

export type CadetsViewProps = {
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  /** Called after the cadet drawer closes; the host opens the issue workflow for this cadet. */
  onIssue: (cadetId: string) => void
  /** Called after the cadet drawer closes; the host opens the return workflow for this cadet. */
  onReturn: (cadetId: string) => void
  /** Sends a notice to one cadet (the drawer's Message this cadet); absent where notices cannot be sent. */
  sendNotice?: NoticeSender
  makePhoneTicket?: PhoneTicketMaker
  /** Replaces a cadet's phone (the drawer's Replace phone); absent where there is no unit. */
  replacePhone?: PhoneTicketMaker
  /** The drawer's Phone line; absent where there is no unit. */
  phoneLine?: PhoneLineReader
  /** Open this cadet's record on arrival (e.g. from a dashboard alert). */
  initialCadetId?: string
  /** Start on this status filter instead of Active. */
  initialFilter?: StatusFilter
}

const FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'INACTIVE', label: 'Inactive' },
  { value: 'ALL', label: 'All' },
]

const byName = (a: Cadet, b: Cadet) => cadetDisplayName(a).localeCompare(cadetDisplayName(b)) || cadetLabel(a).localeCompare(cadetLabel(b))

/**
 * Cadet property records. Cadets are minors, so every row, avatar, title and message identifies a
 * cadet primarily by the encrypted name after the unit has been unlocked. The opaque ID remains a
 * fallback for older records that do not yet have a name.
 */
export function CadetsView({ projection, controller, can, onProjection, notify, onIssue, onReturn, sendNotice, makePhoneTicket, replacePhone, phoneLine, initialCadetId, initialFilter = 'ACTIVE' }: CadetsViewProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<StatusFilter>(initialFilter)
  const [openCadetId, setOpenCadetId] = useState<string | undefined>(initialCadetId)
  const [adding, setAdding] = useState(false)
  const canManage = can('cadets.manage')
  const counts: Record<StatusFilter, number> = {
    ACTIVE: projection.cadets.filter(cadet => cadet.status === 'ACTIVE').length,
    INACTIVE: projection.cadets.filter(cadet => cadet.status === 'INACTIVE').length,
    ALL: projection.cadets.length,
  }
  const visible = projection.cadets
    .filter(cadet => (filter === 'ALL' || cadet.status === filter) && cadetMatches(cadet, query))
    .sort(byName)
  const openCadet = projection.cadets.find(cadet => cadet.cadetId === openCadetId)

  const handOff = (open: (cadetId: string) => void, cadetId: string) => {
    // Close the record first: two stacked dialogs are confusing, and closing also re-hides any revealed name.
    setOpenCadetId(undefined)
    open(cadetId)
  }

  return (
    <div className="content">
      <section className="page-intro">
        <div>
          <p className="eyebrow">PERSONNEL ACCOUNTABILITY</p>
          <h2>Cadet property records.</h2>
          <p>Cadets are shown by name. Names and property records stay encrypted while the unit is locked.</p>
        </div>
        {canManage && (
          <button className="gold-button" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" />
            Add cadet
          </button>
        )}
      </section>

      <div className="table-card">
        <div className="table-tools cadet-tools">
          <div className="inline-search">
            <Search aria-hidden="true" />
            <input aria-label="Search cadets" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search cadet ID, NS level or name…" />
            {query && (
              <button type="button" className="cadet-search-clear" aria-label="Clear cadet search" onClick={() => setQuery('')}>
                <X aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="cadet-filters" role="group" aria-label="Filter cadets by status">
            {FILTERS.map(option => (
              <button key={option.value} type="button" aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>
                {option.label} <span>{counts[option.value]}</span>
              </button>
            ))}
          </div>
        </div>

        {projection.cadets.length === 0 ? (
          <p className="empty-state">
            <strong>No cadets yet.</strong>
            <span>Add cadets by cadet ID — names are optional and encrypted.</span>
          </p>
        ) : visible.length === 0 ? (
          <p className="empty-state">
            <strong>No matching cadets</strong>
            <span>Try another cadet ID, NS level or name, or change the status filter.</span>
          </p>
        ) : (
          <div className="cadet-grid">
            {visible.map(cadet => {
              const gaps = standardIssueGaps(cadet, projection)
              const ready = cadetFullyIssued(cadet, projection)
              // Standard-issue gaps can also have a matching Still Needed record after a partial
              // issue. Use the larger count instead of double-counting the same missing item.
              const missing = Math.max(cadet.stillNeededCount, gaps.length)
              const readiness = ready ? 'READY' : `INCOMPLETE · ${missing} needed`
              return (
                <button className="cadet-card" key={cadet.cadetId} onClick={() => setOpenCadetId(cadet.cadetId)}>
                  <span className="large-avatar" aria-hidden="true">{cadetMonogram(cadet)}</span>
                  <span>
                    <strong>{cadetDisplayName(cadet)}</strong>
                    {cadet.fullName && <small>{cadetLabel(cadet)}</small>}
                    <small>{cadet.nsLevel} · {cadet.gender} · {cadet.status}</small>
                    <small className="cadet-card-compact" aria-hidden="true">{cadet.propertyCount} item{cadet.propertyCount === 1 ? '' : 's'} held</small>
                  </span>
                  <div>
                    <b>{cadet.propertyCount}</b>
                    <small>Current property</small>
                  </div>
                  <em className={ready ? 'ready' : 'attention'}>{readiness}</em>
                  <ArrowRight aria-hidden="true" />
                </button>
              )
            })}
          </div>
        )}
      </div>

      {adding && canManage && (
        <Drawer title="Add cadet" icon={<UserPlus />} close={() => setAdding(false)}>
          <CadetForm
            projection={projection}
            controller={controller}
            onCancel={() => setAdding(false)}
            onSaved={(next, created) => {
              onProjection(next)
              notify(`Cadet ${created ? cadetLabel(created) : 'record'} added.`)
              setAdding(false)
              if (created && filter !== 'ALL' && created.status !== filter) setFilter('ALL')
            }}
          />
        </Drawer>
      )}

      {openCadet && (
        <CadetDrawer
          key={openCadet.cadetId}
          cadet={openCadet}
          projection={projection}
          controller={controller}
          can={can}
          onProjection={onProjection}
          notify={notify}
          onIssue={cadetId => handOff(onIssue, cadetId)}
          onReturn={cadetId => handOff(onReturn, cadetId)}
          {...(sendNotice ? { sendNotice } : {})}
          {...(makePhoneTicket ? { makePhoneTicket } : {})}
          {...(replacePhone ? { replacePhone } : {})}
          {...(phoneLine ? { phoneLine } : {})}
          close={() => setOpenCadetId(undefined)}
        />
      )}
    </div>
  )
}
