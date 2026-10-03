import { useEffect, useState } from 'react'
import { Ticket } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusRole } from '../../distributed/types'
import { plural } from '../../plural'
import { listTickets, type TicketListEntry } from '../../private-sync/tickets'
import type { IssuedTicket, UnitRuntime } from '../runtime'
import { ticketQrDataUrl } from '../ticketQr'
import { roleLabel } from './labels'

/** Who may be offered which role (D4): an Instructor only the cadet roles, a Master anything, and the unit authority alone a Master. */
const CADET_ROLES: ArgusRole[] = ['SUPPLY_ASSISTANT', 'SUPPLY_OFFICER']
const PAST_LABEL = { redeemed: 'Used', cancelled: 'Cancelled', expired: 'Expired' } as Record<TicketListEntry['status'], string>

/**
 * Tickets (ADR 012): a Master, or an Instructor for cadet roles, names a person and a role and gets a one-week, one-use ticket,
 * shown as a QR and a short code. Below it, the tickets that are out with their days left and a way to cancel them; the ones that
 * were used, cancelled or ran out are folded away.
 */
export function TicketsPanel({ runtime, projection, close, notify }: { runtime: UnitRuntime; projection: ArgusAppProjection; close: () => void; notify: (message: string) => void }) {
  const record = runtime.device.record, status = runtime.status()
  const roles: ArgusRole[] = status.revoked ? [] : record.role === 'MASTER' ? ['SUPPLY_ASSISTANT', 'SUPPLY_OFFICER', 'INSTRUCTOR', ...(status.holdsAuthority ? ['MASTER' as const] : [])] : record.role === 'INSTRUCTOR' ? CADET_ROLES : []
  const [name, setName] = useState(''), [role, setRole] = useState<ArgusRole>('SUPPLY_ASSISTANT'), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<{ ticket: IssuedTicket; qr?: string; qrError?: boolean }>(), [copied, setCopied] = useState(false), [cancelling, setCancelling] = useState('')
  const canShare = typeof navigator.share === 'function'
  useEffect(() => {
    if (!result || result.qr || result.qrError) return
    let active = true
    ticketQrDataUrl(result.ticket.code).then(qr => { if (active) setResult(current => current && { ...current, qr }) }, () => { if (active) setResult(current => current && { ...current, qrError: true }) })
    return () => { active = false }
  }, [result])

  const make = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const ticket = await runtime.issueTicket(name.trim(), role)
      setResult({ ticket }); setCopied(false); setName('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The ticket could not be made.') } finally { setBusy(false) }
  }
  const copy = () => { if (result) void navigator.clipboard.writeText(result.ticket.code).then(() => setCopied(true), () => undefined) }
  const share = async () => {
    if (!result) return
    const { displayName, code } = result.ticket
    try { await navigator.share({ title: `A.R.G.U.S. ticket for ${displayName}`, text: `${displayName}, here is your A.R.G.U.S. ticket. It works once and runs out in a week: ${code}` }) } catch { /* the person closed the share sheet */ }
  }
  const cancel = async (ticket: TicketListEntry) => {
    setCancelling(ticket.ticketId); setError('')
    try {
      const outcome = await runtime.cancelTicket(ticket.ticketId)
      notify(outcome.status === 'CANCELLED' ? `The ticket for ${ticket.displayName} was cancelled.` : `The cancellation of ${ticket.displayName}'s ticket is saved and goes out when the network is reachable. Tap Cancel again then to finish it.`)
      if (result?.ticket.ticketId === ticket.ticketId) setResult(undefined)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The ticket could not be cancelled.') } finally { setCancelling('') }
  }

  const tickets = listTickets(projection.tickets), out = tickets.filter(ticket => ticket.status === 'open'), past = tickets.filter(ticket => ticket.status !== 'open')
  const issuerName = (publicIdentity: string) => projection.members.find(member => member.publicIdentity === publicIdentity)?.displayName ?? 'another person'
  return (
    <Drawer title="Tickets" icon={<Ticket />} close={close}>
      {roles.length ? (
        <form className="panel-rows" aria-label="Make a ticket" onSubmit={make}>
          <h3>Make a ticket</h3>
          <p>A ticket is for one named person and works once. It runs out after a week. They enter it when they open A.R.G.U.S. for the first time, even if your phone is off by then.</p>
          <label className="field">NAME<input aria-label="Name" value={name} onChange={event => setName(event.target.value)} maxLength={60} required autoComplete="off" placeholder="The person’s name or call sign" /></label>
          <label className="field">ROLE<select aria-label="Role" value={role} onChange={event => setRole(event.target.value as ArgusRole)}>{roles.map(choice => <option key={choice} value={choice}>{roleLabel(choice)}</option>)}</select>{record.role === 'INSTRUCTOR' && <small>An Instructor can make tickets for Supply Officers and Supply Assistants. A Master makes the others.</small>}{role === 'MASTER' && <small>A Master can make tickets, change roles and remove people (not other Masters). Choose someone you trust fully.</small>}</label>
          {error && <div className="workflow-error" role="alert">{error}</div>}
          <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Making ticket…' : 'Make ticket'}</button></div>
        </form>
      ) : <p className="safe-note">{status.revoked ? 'Your access to this unit was removed.' : 'Only a Master or an Instructor can make tickets.'}</p>}
      {result && (
        <div className="validation ticket-result" role="status">
          <strong>Ticket ready for {result.ticket.displayName}</strong>
          <p>{roleLabel(result.ticket.role)} · good for one use until {new Date(result.ticket.expiresAt).toLocaleDateString()}. Let them scan this QR, or send them the code.</p>
          {result.qr ? <img className="ticket-qr" src={result.qr} alt={`Ticket QR code for ${result.ticket.displayName}`} /> : result.qrError ? <p>The QR picture could not be made. Use the code below.</p> : <p>Preparing the QR picture…</p>}
          <code className="ticket-code" aria-label="Ticket code">{result.ticket.code}</code>
          <div className="modal-actions">
            <button type="button" onClick={copy}>{copied ? 'Code copied ✓' : 'Copy code'}</button>
            {canShare && <button type="button" onClick={() => void share()}>Share</button>}
            <button type="button" onClick={() => setResult(undefined)}>Hide</button>
          </div>
          <p className="safe-note">Anyone who has this code can join as {result.ticket.displayName} until it is used or cancelled. Send it only to them.</p>
        </div>
      )}
      <h3>Tickets out</h3>
      {out.length ? (
        <ul className="panel-rows" aria-label="Tickets out">
          {out.map(ticket => (
            <li key={ticket.ticketId}>
              <p>
                <strong>{ticket.displayName}</strong> · {roleLabel(ticket.role)} · {plural(ticket.daysLeft, 'day')} left
                {ticket.issuedBy !== record.signingIdentity && <><br /><small>Made by {issuerName(ticket.issuedBy)}</small></>}
              </p>
              {ticket.issuedBy === record.signingIdentity && <div className="modal-actions"><button className="secondary-button" aria-label={`Cancel ticket for ${ticket.displayName}`} disabled={cancelling === ticket.ticketId} onClick={() => void cancel(ticket)}>{cancelling === ticket.ticketId ? 'Cancelling…' : 'Cancel'}</button></div>}
            </li>
          ))}
        </ul>
      ) : <p>No tickets are out.</p>}
      {past.length > 0 && (
        <details>
          <summary>Used, cancelled or expired ({past.length})</summary>
          <ul className="panel-rows" aria-label="Past tickets">
            {past.map(ticket => <li key={ticket.ticketId}><p><strong>{ticket.displayName}</strong> · {roleLabel(ticket.role)} · {PAST_LABEL[ticket.status]}</p></li>)}
          </ul>
        </details>
      )}
    </Drawer>
  )
}
