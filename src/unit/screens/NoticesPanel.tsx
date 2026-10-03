import { useState } from 'react'
import { Megaphone } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { NoticeAudience } from '../../distributed/types'
import { cadetLabel } from '../../stage3/domain'

/** What sending a notice does (UnitRuntime.sendNotice): published false means it is saved and goes out when the network is reachable. */
export type NoticeSender = (audience: NoticeAudience, text: string) => Promise<{ noticeId: string; published: boolean }>
export const NOT_YET_PUBLISHED = 'goes out to cadets when the network is reachable'

/** A text box and Send for one audience: used for all cadets (Notices) and for one cadet (the cadet drawer). */
export function NoticeForm({ label, audience, send, onSent }: { label: string; audience: NoticeAudience; send: NoticeSender; onSent: (published: boolean) => void }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { const { published } = await send(audience, text.trim()); setText(''); onSent(published) } catch (cause) { setError(cause instanceof Error ? cause.message : 'The notice could not be sent.') } finally { setBusy(false) }
  }
  return (
    <form className="panel-rows" onSubmit={submit}>
      <label className="field">{label.toUpperCase()}<textarea aria-label={label} value={text} onChange={event => setText(event.target.value)} rows={3} autoComplete="off" /></label>
      {error && <div className="workflow-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button></div>
    </form>
  )
}

/**
 * Notices (ADR 013, mw-kmgi38.5): staff with notices.send write a notice to every cadet and see the notices already sent, newest first,
 * with who sent them and when. A person without notices.send sees the list and no way to send.
 */
export function NoticesPanel({ projection, memberName, canSend, send, close, notify }: { projection: ArgusAppProjection; memberName: (publicIdentity: string) => string; canSend: boolean; send: NoticeSender; close: () => void; notify: (message: string) => void }) {
  const cadetCode = (cadetId: string) => { const cadet = projection.cadets.find(candidate => candidate.cadetId === cadetId); return cadet ? cadetLabel(cadet) : 'a cadet' }
  return (
    <Drawer title="Notices" icon={<Megaphone />} close={close}>
      {canSend ? (
        <>
          <p>Cadets with the app see a notice the next time their phone checks. It reaches every cadet who has a phone.</p>
          <NoticeForm label="Notice to all cadets" audience="all" send={send} onSent={published => notify(published ? 'Notice sent' : `Notice saved. It ${NOT_YET_PUBLISHED}.`)} />
        </>
      ) : <p className="safe-note">Only a Master, an Instructor or a Supply Officer can send notices.</p>}
      <h3>Sent notices</h3>
      {projection.notices.length ? (
        <ul className="panel-rows" aria-label="Sent notices">
          {projection.notices.map(notice => (
            <li key={notice.noticeId}>
              <p>{notice.text}</p>
              <small>{memberName(notice.sentBy)} · {new Date(notice.sentAt).toLocaleString()} · {notice.audience === 'all' ? 'To all cadets' : `To cadet ${cadetCode(notice.audience.cadetId)}`}</small>
            </li>
          ))}
        </ul>
      ) : <p>No notices have been sent.</p>}
    </Drawer>
  )
}
