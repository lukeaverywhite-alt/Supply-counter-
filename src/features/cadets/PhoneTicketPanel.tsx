import { useEffect, useState } from 'react'
import { Smartphone } from 'lucide-react'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { CadetTicketProjection } from '../../distributed/types'
import type { IssuedCadetTicket } from '../../unit/runtime'
import { ticketQrDataUrl } from '../../unit/ticketQr'
import { memberLabel } from './cadetDisplay'
import { TICKET_WAITING } from './phoneTicket'

/** What making a phone ticket does (UnitRuntime.issueCadetTicket): waiting is true when the network did not take it yet, so it is saved here and goes out later. */
export type PhoneTicketMaker = (cadetId: string) => Promise<{ ticket: IssuedCadetTicket; waiting: boolean }>
/** What the drawer's Phone line says for one cadet (cadetPhoneLine over UnitRuntime.readCadetChannel): "Phone: joined <date>" or "No phone yet". */
export type PhoneLineReader = (cadetId: string) => Promise<string>
/**
 * The cadet drawer's Phone ticket section (ADR 013, mw-kmgi38.13). Staff with cadets.admit tap Make phone ticket: the runtime makes
 * the cadet's channel and a one-week, one-use ticket, and the code is shown as a QR and a short code, as in Tickets. The code is shown
 * once, here; afterwards the drawer only says when the ticket was made and by whom (the runtime does not offer a made code again).
 * Always labelled with the cadet ID, never the cadet's name.
 * Once a ticket was made, Replace phone (mw-kmgi38.16) asks once and then replaces the cadet's phone (UnitRuntime.reissueCadetTicket: a new
 * key and address, so the old phone reads nothing new) and shows the new code exactly as Make phone ticket does. The Phone line says
 * whether a phone has joined the cadet's current channel.
 */
export function PhoneTicketPanel({ cadetCode, cadetId, projection, ticket, canMake, make, replace, phoneLine, onMade }: { cadetCode: string; cadetId: string; projection: ArgusAppProjection; ticket?: CadetTicketProjection; canMake: boolean; make?: PhoneTicketMaker; replace?: PhoneTicketMaker; phoneLine?: PhoneLineReader; onMade: (waiting: boolean, replaced: boolean) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<{ ticket: IssuedCadetTicket; waiting: boolean; qr?: string; qrError?: boolean }>(), [copied, setCopied] = useState(false)
  const [asking, setAsking] = useState(false), [line, setLine] = useState<string>(), [lineChecks, setLineChecks] = useState(0)
  const canShare = typeof navigator.share === 'function'
  useEffect(() => {
    if (!phoneLine) return
    let active = true
    phoneLine(cadetId).then(text => { if (active) setLine(text) }, () => { if (active) setLine(undefined) })
    return () => { active = false }
  }, [phoneLine, cadetId, ticket?.ticketId, lineChecks])
  useEffect(() => {
    if (!result || result.qr || result.qrError) return
    let active = true
    ticketQrDataUrl(result.ticket.code).then(qr => { if (active) setResult(current => current && { ...current, qr }) }, () => { if (active) setResult(current => current && { ...current, qrError: true }) })
    return () => { active = false }
  }, [result])

  const mayMake = Boolean(make) && canMake
  if (!mayMake && !ticket) return null
  const mayReplace = Boolean(replace) && canMake && Boolean(ticket)
  const run = async (replaced = false) => {
    setBusy(true); setError(''); setAsking(false)
    try { const made = await (replaced ? replace! : make!)(cadetId); setResult(made); setCopied(false); setLineChecks(value => value + 1); onMade(made.waiting, replaced) } catch (cause) { setError(cause instanceof Error ? cause.message : replaced ? 'The phone could not be replaced.' : 'The ticket could not be made.') } finally { setBusy(false) }
  }
  const copy = () => { if (result) void navigator.clipboard.writeText(result.ticket.code).then(() => setCopied(true), () => undefined) }
  const share = async () => {
    if (!result) return
    try { await navigator.share({ title: 'A.R.G.U.S. ticket', text: `Here is your A.R.G.U.S. ticket. It works once and runs out in a week: ${result.ticket.code}` }) } catch { /* the person closed the share sheet */ }
  }
  return (
    <section className="cadet-phone-panel" aria-label="Phone ticket">
      {result && mayMake ? (
        <div className="validation ticket-result" role="status">
          <strong>Phone ticket ready for {cadetCode}</strong>
          <p>Good for one use until {new Date(result.ticket.expiresAt).toLocaleDateString()}. Let the cadet scan this QR, or send them the code.</p>
          {result.waiting && <p className="safe-note">This ticket {TICKET_WAITING}.</p>}
          {result.qr ? <img className="ticket-qr" src={result.qr} alt={`Ticket QR code for ${cadetCode}`} /> : result.qrError ? <p>The QR picture could not be made. Use the code below.</p> : <p>Preparing the QR picture…</p>}
          <code className="ticket-code" aria-label="Ticket code">{result.ticket.code}</code>
          <div className="modal-actions">
            <button type="button" onClick={copy}>{copied ? 'Code copied ✓' : 'Copy code'}</button>
            {canShare && <button type="button" onClick={() => void share()}>Share</button>}
            <button type="button" onClick={() => setResult(undefined)}>Hide</button>
          </div>
          <p className="safe-note">Anyone who has this code can join as {cadetCode} until it is used. Send it only to the cadet.</p>
        </div>
      ) : ticket ? (
        <>
          <p className="safe-note" role="status">Phone ticket made {new Date(ticket.issuedAt).toLocaleDateString()} by {memberLabel(projection, ticket.issuedBy)}</p>
          {error && <div className="workflow-error" role="alert">{error}</div>}
          {mayReplace && (asking ? (
            <div className="validation" role="group" aria-label="Replace phone">
              <p>{"Replace this cadet's phone? The old phone stops getting updates."}</p>
              <div className="modal-actions">
                <button type="button" className="primary-button" disabled={busy} onClick={() => void run(true)}>Yes, replace phone</button>
                <button type="button" onClick={() => setAsking(false)}>Keep this phone</button>
              </div>
            </div>
          ) : (
            <button type="button" className="secondary-button" disabled={busy} onClick={() => { setError(''); setAsking(true) }}><Smartphone aria-hidden="true" /> {busy ? 'Replacing phone…' : 'Replace phone'}</button>
          ))}
        </>
      ) : mayMake ? (
        <>
          {error && <div className="workflow-error" role="alert">{error}</div>}
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void run()}><Smartphone aria-hidden="true" /> {busy ? 'Making ticket…' : 'Make phone ticket'}</button>
        </>
      ) : null}
      {line && <p className="safe-note cadet-phone-line">{line}</p>}
    </section>
  )
}
