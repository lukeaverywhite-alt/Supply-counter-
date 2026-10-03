import { useEffect, useState } from 'react'
import { Activity, Eye, EyeOff, Lock, MessageSquare, PackageMinus, PackagePlus, Pencil, PencilLine, Ruler, UserRound } from 'lucide-react'
import { Drawer, Summary } from '../../components/Drawer'
import type { ArgusAppProjection, DistributedAppController } from '../../distributed/appIntegration'
import type { ArgusPermission, CadetTicketProjection, PropertyCorrection, SupplyTransaction } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'
import { NOT_YET_PUBLISHED, NoticeForm, type NoticeSender } from '../../unit/screens/NoticesPanel'
import { RecordCorrectionForm } from '../corrections/RecordCorrectionForm'
import { KIND_LABELS, describeLine, recordCorrections, transactionTargets } from '../corrections/correctionModel'
import { StillNeededActions } from '../needs/StillNeededActions'
import { CadetForm } from './CadetForm'
import { PhoneTicketPanel, type PhoneLineReader, type PhoneTicketMaker } from './PhoneTicketPanel'
import { TICKET_WAITING } from './phoneTicket'
import { SizeCorrectionForm } from './SizeCorrectionForm'
import { cadetMonogram, memberLabel } from './cadetDisplay'
import './cadets.css'

type Cadet = ArgusAppProjection['cadets'][number]

export type CadetDrawerProps = {
  cadet: Cadet
  projection: ArgusAppProjection
  controller: DistributedAppController
  can: (permission: ArgusPermission) => boolean
  onProjection: (projection: ArgusAppProjection) => void
  notify: (message: string) => void
  onIssue: (cadetId: string) => void
  onReturn: (cadetId: string) => void
  /** Sends a notice to this cadet alone; without it (or without notices.send) the drawer offers no message. */
  sendNotice?: NoticeSender
  /** Makes this cadet's phone ticket; without it (or without cadets.admit) the drawer offers none. */
  makePhoneTicket?: PhoneTicketMaker
  /** Replaces this cadet's phone (a new ticket, the old phone goes dark); without it (or without cadets.admit) the drawer offers none. */
  replacePhone?: PhoneTicketMaker
  /** Reads the Phone line for this cadet; without it the drawer shows none. */
  phoneLine?: PhoneLineReader
  close: () => void
}

const formatDate = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown date' : date.toLocaleDateString()
}
const humanStatus = (value: string) => value.replaceAll('_', ' ').toLowerCase()
const describeLines = (transaction: SupplyTransaction) => {
  const moved = transaction.lines.map(describeLine)
  const missing = transaction.missingLines?.length ?? 0
  if (!moved.length) return missing ? `Nothing issued · ${missing} added to Still Needed` : 'No items'
  return missing ? `${moved.join(', ')} · ${missing} added to Still Needed` : moved.join(', ')
}
const describeCorrection = (projection: ArgusAppProjection, correction: PropertyCorrection) => {
  const from = projection.inventory.find(item => item.entityId === correction.fromItemId)
  const to = projection.inventory.find(item => item.entityId === correction.toItemId)
  return `${from?.name ?? to?.name ?? 'Issued item'}: ${from?.variant ?? 'unknown size'} → ${to?.variant ?? 'unknown size'}`
}

/**
 * One cadet's property record. The drawer is titled by cadet ID; the encrypted name is rendered only
 * after the operator taps "Show name". That reveal lives in this component's state, so it resets
 * whenever the drawer closes and is never persisted.
 */
export function CadetDrawer({ cadet, projection, controller, can, onProjection, notify, onIssue, onReturn, sendNotice, makePhoneTicket, replacePhone, phoneLine, close }: CadetDrawerProps) {
  const [nameRevealed, setNameRevealed] = useState(false)
  const [editing, setEditing] = useState(false)
  const [correctingId, setCorrectingId] = useState<string>()
  const [correctingTransactionId, setCorrectingTransactionId] = useState<string>()
  const [messaging, setMessaging] = useState(false)
  // Whether the unit has made this cadet a channel (a phone ticket makes one); a message needs one. And the latest ticket made for them.
  const [hasPhone, setHasPhone] = useState<boolean>()
  const [phoneTicket, setPhoneTicket] = useState<CadetTicketProjection>()
  const [phoneChecks, setPhoneChecks] = useState(0)
  useEffect(() => {
    let active = true
    void controller.technicalState().then(state => {
      if (!active) return
      setHasPhone(state.cadetChannels.some(channel => channel.cadetId === cadet.cadetId))
      setPhoneTicket(state.cadetTickets.filter(ticket => ticket.cadetId === cadet.cadetId).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0])
    }, () => { if (active) setHasPhone(false) })
    return () => { active = false }
  }, [controller, cadet.cadetId, projection, phoneChecks])
  const code = cadetLabel(cadet)
  const canReveal = can('cadets.read') || can('cadets.manage')
  const canManage = can('cadets.manage')
  const canCorrect = can('inventory.adjust')
  const canMessage = Boolean(sendNotice) && can('notices.send')
  const canMakeTicket = can('cadets.admit')
  const canIssue = can('inventory.issue') && cadet.status === 'ACTIVE'
  const canReturn = can('inventory.return') && cadet.currentProperty.length > 0
  const needs = projection.stillNeeded.filter(need => need.cadetId === cadet.cadetId)
  const history = projection.transactions
    .filter(transaction => transaction.cadetId === cadet.cadetId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const corrections = projection.corrections
    .filter(correction => correction.cadetId === cadet.cadetId)
    .sort((a, b) => b.at.localeCompare(a.at))
  const quantityCorrections = recordCorrections(projection)
    .filter(correction => history.some(transaction => transaction.eventId === correction.targetEventId))
    .reverse()
  const lineFor = (targetEventId: string, lineId?: string) => history.find(transaction => transaction.eventId === targetEventId)?.lines.find(line => line.lineId === lineId)
  const ready = cadet.readiness.status === 'READY'

  if (editing && canManage) {
    return (
      <Drawer title={`Edit ${code}`} icon={<Pencil />} close={close}>
        <CadetForm
          projection={projection}
          controller={controller}
          cadet={cadet}
          nameRevealed={nameRevealed}
          onRevealName={canReveal ? () => setNameRevealed(true) : undefined}
          onCancel={() => setEditing(false)}
          onSaved={next => {
            onProjection(next)
            notify(`Cadet ${code} updated.`)
            setEditing(false)
          }}
        />
      </Drawer>
    )
  }

  return (
    <Drawer title={code} icon={<UserRound />} close={close}>
      <div className="record-hero">
        <span className="large-avatar" aria-hidden="true">{cadetMonogram(cadet)}</span>
        <div>
          <small>Cadet ID</small>
          <b>{code}</b>
          <p>{cadet.nsLevel} · {cadet.gender} · {cadet.status}</p>
        </div>
        {canManage && (
          <button className="secondary-button cadet-edit-button" onClick={() => setEditing(true)}>
            <Pencil aria-hidden="true" /> Edit
          </button>
        )}
      </div>

      <section className="cadet-name-panel" aria-label="Encrypted name">
        <span>
          <small>Name · encrypted</small>
          {nameRevealed ? (
            <strong className={cadet.fullName ? undefined : 'cadet-name-missing'}>{cadet.fullName || 'No name recorded'}</strong>
          ) : (
            <strong className="cadet-name-missing"><Lock aria-hidden="true" /> Hidden</strong>
          )}
        </span>
        {canReveal && (
          <button type="button" className="secondary-button" onClick={() => setNameRevealed(value => !value)}>
            {nameRevealed ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            {nameRevealed ? 'Hide name' : 'Show name'}
          </button>
        )}
      </section>

      {cadet.profileNeedsReview && (
        <div className="notice" role="alert">
          <Activity aria-hidden="true" />
          <span>
            <strong>Profile review required</strong>
            <br />
            Migrated profile information could not be fully verified.
          </span>
        </div>
      )}

      <div className="record-stats">
        <Summary label="Property" value={String(cadet.propertyCount)} detail="Items currently held" />
        <Summary
          label="Readiness"
          value={`${cadet.readiness.percent}%`}
          detail={ready ? 'Ready' : `Incomplete · ${cadet.stillNeededCount} still needed`}
          accent={!ready}
        />
      </div>

      <PhoneTicketPanel
        cadetCode={code}
        cadetId={cadet.cadetId}
        projection={projection}
        {...(phoneTicket ? { ticket: phoneTicket } : {})}
        canMake={canMakeTicket}
        {...(makePhoneTicket ? { make: makePhoneTicket } : {})}
        {...(replacePhone ? { replace: replacePhone } : {})}
        {...(phoneLine ? { phoneLine } : {})}
        onMade={(waiting, replaced) => { setPhoneChecks(value => value + 1); notify(waiting ? `Phone ticket for ${code} ${TICKET_WAITING}.` : replaced ? `Phone replaced for ${code}. The old phone stops getting updates.` : `Phone ticket made for ${code}.`) }}
      />

      {canMessage && sendNotice && (
        <section className="cadet-message-panel" aria-label="Message this cadet">
          {!messaging ? (
            <button type="button" className="secondary-button" onClick={() => setMessaging(true)}><MessageSquare aria-hidden="true" /> Message this cadet</button>
          ) : hasPhone ? (
            <NoticeForm label="Message to this cadet" audience={{ cadetId: cadet.cadetId }} send={sendNotice} onSent={published => { setMessaging(false); notify(published ? `Message sent to ${nameRevealed && cadet.fullName ? cadet.fullName : code}` : `Message saved for ${code}. It ${NOT_YET_PUBLISHED}.`) }} />
          ) : (
            <p className="safe-note" role="status">{hasPhone === undefined ? 'Checking…' : 'This cadet has no phone yet'}</p>
          )}
        </section>
      )}

      <h3>Current property</h3>
      <div className="cadet-record-rows">
        {cadet.currentProperty.length ? (
          cadet.currentProperty.map(property => {
            const correcting = canCorrect && correctingId === property.propertyId
            return (
              <div className="cadet-property" key={property.propertyId}>
                <div className={canCorrect ? 'needed-row cadet-property-row' : 'needed-row'}>
                  <span>
                    <strong>{property.label}</strong>
                    <small>{property.variant} · Qty {property.quantity} · Issued {formatDate(property.issuedAt)}</small>
                  </span>
                  <b>{property.quantity}</b>
                  {canCorrect && !correcting && (
                    <button
                      type="button"
                      className="secondary-button cadet-correct-button"
                      aria-label={`Correct size of ${property.label} · ${property.variant}`}
                      onClick={() => setCorrectingId(property.propertyId)}
                    >
                      <Ruler aria-hidden="true" /> Correct size
                    </button>
                  )}
                </div>
                {correcting && (
                  <SizeCorrectionForm
                    cadetId={cadet.cadetId}
                    property={property}
                    projection={projection}
                    controller={controller}
                    onCancel={() => setCorrectingId(undefined)}
                    onCorrected={(next, correction) => {
                      setCorrectingId(undefined)
                      onProjection(next)
                      notify(`Size corrected for ${code}: ${correction.label} ${correction.from} → ${correction.to}.`)
                    }}
                  />
                )}
              </div>
            )
          })
        ) : (
          <p className="empty-state">No current property.</p>
        )}
      </div>

      <h3>Still Needed</h3>
      <div className="cadet-record-rows">
        {needs.length ? (
          needs.map(need => (
            <div className="need-entry" key={need.requirementId}>
              <div className="needed-row">
                <span>
                  <strong>{need.displayLabel}</strong>
                  <small>{need.size ?? 'Size not set'} · {humanStatus(need.status)}</small>
                </span>
                <b>{need.quantityNeeded - need.quantityFulfilled}</b>
              </div>
              {canManage && <StillNeededActions need={need} controller={controller} onProjection={onProjection} notify={notify} />}
            </div>
          ))
        ) : (
          <p className="empty-state">No open requirements.</p>
        )}
      </div>

      <h3>Issue &amp; return history</h3>
      <div className="cadet-record-rows">
        {history.length ? (
          history.map(transaction => {
            const title = `${transaction.transactionType.toLowerCase()} of ${formatDate(transaction.createdAt)}`
            const correcting = canCorrect && correctingTransactionId === transaction.transactionId
            return (
              <div className="cadet-property" key={transaction.transactionId}>
                <div className={canCorrect && transaction.lines.length ? 'needed-row cadet-history-row cadet-property-row' : 'needed-row cadet-history-row'}>
                  <span>
                    <strong>{formatDate(transaction.createdAt)}</strong>
                    <small>{describeLines(transaction)}</small>
                  </span>
                  <em className={`status-badge ${transaction.transactionType === 'ISSUE' ? 'success' : 'warning'}`}>{transaction.transactionType}</em>
                  {canCorrect && transaction.lines.length > 0 && !correcting && (
                    <button type="button" className="secondary-button cadet-correct-button" aria-label={`Correct quantity in ${title}`} onClick={() => setCorrectingTransactionId(transaction.transactionId)}>
                      <PencilLine aria-hidden="true" /> Correct…
                    </button>
                  )}
                </div>
                {correcting && (
                  <RecordCorrectionForm
                    title={title}
                    targets={transactionTargets(transaction)}
                    controller={controller}
                    onCancel={() => setCorrectingTransactionId(undefined)}
                    onCorrected={(next, summary) => {
                      setCorrectingTransactionId(undefined)
                      onProjection(next)
                      notify(`${transaction.transactionType === 'ISSUE' ? 'Issue' : 'Return'} corrected for ${code}: ${summary}.`)
                    }}
                  />
                )}
              </div>
            )
          })
        ) : (
          <p className="empty-state">No issues or returns yet.</p>
        )}
      </div>

      <h3>Size corrections</h3>
      <div className="cadet-record-rows">
        {corrections.length ? (
          corrections.map(correction => (
            <div className="needed-row cadet-history-row" key={correction.correctionId}>
              <span>
                <strong>{describeCorrection(projection, correction)}</strong>
                <small className="cadet-correction-reason">{correction.reason}</small>
                <small>{formatDate(correction.at)} · {memberLabel(projection, correction.actor)}</small>
              </span>
              <em className="status-badge warning">× {correction.quantity}</em>
            </div>
          ))
        ) : (
          <p className="empty-state">No size corrections.</p>
        )}
      </div>

      {quantityCorrections.length > 0 && (
        <>
          <h3>Quantity corrections</h3>
          <div className="cadet-record-rows">
            {quantityCorrections.map(correction => {
              const line = lineFor(correction.targetEventId, correction.lineId)
              return (
                <div className="needed-row cadet-history-row" key={correction.eventId}>
                  <span>
                    <strong>{KIND_LABELS[correction.kind]}: {line ? `${line.label} · ${line.variant}` : 'Line'} {correction.from} → {correction.to}</strong>
                    <small className="cadet-correction-reason">{correction.reason}</small>
                    <small>{formatDate(correction.at)} · {memberLabel(projection, correction.actor)}</small>
                  </span>
                  <em className={`status-badge ${correction.applied ? 'warning' : 'danger'}`}>{correction.applied ? 'Corrected' : 'In conflict'}</em>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div className="split-actions cadet-split-actions">
        <button disabled={!canReturn} onClick={() => onReturn(cadet.cadetId)}>
          <PackageMinus aria-hidden="true" /> Return Items
        </button>
        <button className="primary-button" disabled={!canIssue} onClick={() => onIssue(cadet.cadetId)}>
          <PackagePlus aria-hidden="true" /> Issue Items
        </button>
      </div>
      {cadet.status !== 'ACTIVE' && <p className="cadet-action-note">Inactive cadets can return property but cannot be issued new items.</p>}
    </Drawer>
  )
}
