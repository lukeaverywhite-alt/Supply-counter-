import { useEffect, useMemo, useState } from 'react'
import { WhatsOnChainApi } from '../chain/woc'
import type { ChainApi } from '../chain/types'
import type { CadetViewHaveLine, CadetViewNeedLine } from '../distributed/types'
import { browserNotificationEnvironment, type DevicePermission, type NotificationEnvironment } from '../notifications/environment'
import { DeviceNotifier, NotificationHistoryStore } from '../notifications/notifier'
import type { StoredNotice, UnlockedCadetDevice } from '../unit/vault'
import { useCadetPoller } from './CadetPoller'
import { useCadetNotices } from './useCadetNotices'
import { formatWhen } from './format'
import './cadet.css'

export type CadetAppProps = {
  device: UnlockedCadetDevice
  /** Tests inject a fake chain; the phone reads BSV testnet through WhatsOnChain. */
  api?: ChainApi
  /** Where the phone keeps what it reads (the notices, sealed in the cadet record); tests inject a memory store. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** The browser's notification API behind one interface; tests inject a fake. */
  notificationEnvironment?: NotificationEnvironment
  /** Called once the cadet has confirmed leaving; the caller wipes the phone's record. */
  onLeave: () => void | Promise<void>
}

/**
 * Cadet mode (ADR 013): what a cadet's phone shows instead of the staff app. My gear, read from the cadet's own channel, Notices (the
 * unit's notices and notes to this cadet, with an unread badge and a banner, mw-kmgi38.6), and a Settings sheet with Leave. There are no tabs and no unit screen: the phone holds no unit key to show one with.
 */
export function CadetApp({ device, api, storage = localStorage, notificationEnvironment = browserNotificationEnvironment, onLeave }: CadetAppProps) {
  const cadet = device.cadet!
  const chain = useMemo(() => api ?? new WhatsOnChainApi(), [api])
  const poll = useCadetPoller(cadet, chain)
  const [settings, setSettings] = useState(false)
  const [screen, setScreen] = useState<'gear' | 'notices'>('gear'), [openedAt, setOpenedAt] = useState('')
  const [notifier] = useState(() => new DeviceNotifier(notificationEnvironment, new NotificationHistoryStore(storage)))
  const { notices, unread, markAllRead } = useCadetNotices(device, storage, poll.notices, notifier, cadet.unit.unitName)
  const { view } = poll
  // Opening Notices marks everything read, also what arrives while it is open; what was unread when it opened stays marked New until it closes.
  useEffect(() => { if (screen === 'notices') markAllRead() }, [screen, notices, markAllRead])
  const openNotices = () => { setOpenedAt(new Date().toISOString()); setScreen('notices') }
  return (
    <div className="cadet-app">
      <div className="environment-banner testnet cadet-banner" role="note"><strong>BSV TESTNET</strong><span>Development Environment · No Production Transactions</span></div>
      <header className="cadet-header">
        <div><p className="eyebrow">Cadet</p><h1>{cadet.unit.unitName}</h1></div>
        <div className="cadet-header-actions">
          <button className="secondary-button cadet-notices-button" aria-label={unread ? `Notices, ${unread} unread` : 'Notices'} onClick={openNotices}>Notices{unread > 0 && <span className="cadet-badge" aria-hidden="true">{unread}</span>}</button>
          <button className="secondary-button" onClick={() => setSettings(true)}>Settings</button>
        </div>
      </header>
      <main className="cadet-main">
        {screen === 'notices' ? <NoticesScreen notices={notices} openedAt={openedAt} back={() => setScreen('gear')} /> : (
        <>
        {unread > 0 && <button type="button" className="cadet-notice-banner" onClick={openNotices}>{unread === 1 ? '1 new notice' : `${unread} new notices`}</button>}
        <section className="cadet-card" aria-labelledby="cadet-gear-title">
          <h2 id="cadet-gear-title">My gear</h2>
          <p className="cadet-who"><strong>{view?.fullName ?? cadet.displayName}</strong>{view && <span className="cadet-code">{view.cadetCode}</span>}</p>
          {view && <p className="cadet-updated">{poll.offline ? 'Last updated' : 'Updated'} {formatWhen(view.updatedAt)}</p>}
          {poll.offline && <div className="validation" role="status">{view ? 'Could not reach the network, so this is the last record this phone read. ' : 'Could not reach the network. '}Press Refresh to try again.</div>}
          {!view && poll.loaded && !poll.offline && <div className="validation" role="status">The supply counter has not published your gear yet. Check again after your next visit.</div>}
          {!view && !poll.loaded && <p role="status">Reading your gear…</p>}
          {view && (
            <>
              <section className="cadet-list" aria-label="Have"><h3>Have</h3><Lines empty="Nothing issued yet" lines={view.have} /></section>
              <section className="cadet-list" aria-label="Still needed"><h3>Still needed</h3><Lines empty="Nothing still needed" lines={view.stillNeeded} /></section>
            </>
          )}
          <button className="primary-button cadet-refresh" onClick={poll.refresh}>{poll.checking ? 'Refreshing…' : 'Refresh'}</button>
        </section>
        </>
        )}
      </main>
      {settings && <SettingsSheet unitName={cadet.unit.unitName} name={cadet.displayName} environment={notificationEnvironment} close={() => setSettings(false)} leave={onLeave} />}
    </div>
  )
}

function Lines({ lines, empty }: { lines: Array<CadetViewHaveLine | CadetViewNeedLine>; empty: string }) {
  if (!lines.length) return <p className="cadet-empty">{empty}</p>
  return (
    <ul className="cadet-lines">
      {lines.map((line, index) => (
        <li key={index}><span className="cadet-item">{line.label}</span>{line.size && <span className="cadet-size">Size {line.size}</span>}<span className="cadet-qty">Qty {line.quantity}</span></li>
      ))}
    </ul>
  )
}

function NoticesScreen({ notices, openedAt, back }: { notices: StoredNotice[]; openedAt: string; back: () => void }) {
  return (
    <section className="cadet-card" aria-labelledby="cadet-notices-title">
      <h2 id="cadet-notices-title">Notices</h2>
      {notices.length === 0 ? <p className="cadet-empty">No notices yet</p> : (
        <ul className="cadet-notices" aria-label="Notices">
          {notices.map(notice => (
            <li key={notice.noticeId}>
              {(!notice.readAt || notice.readAt >= openedAt) && <span className="cadet-new">New</span>}
              <p className="cadet-notice-text">{notice.text}</p>
              <p className="cadet-notice-from"><span>{notice.from}</span> · <span>{formatWhen(notice.sentAt)}</span></p>
            </li>
          ))}
        </ul>
      )}
      <button className="primary-button cadet-refresh" onClick={back}>My gear</button>
    </section>
  )
}

const permissionText = (permission: DevicePermission) => permission === 'granted' ? 'Device notifications are on. A new notice shows here and on this phone while this app is open.'
  : permission === 'denied' ? 'Notifications are blocked in your browser’s settings. New notices still show here with a badge.'
  : permission === 'unsupported' ? 'This browser cannot show notifications. New notices still show here with a badge.'
  : 'Allow notifications to hear about a new notice while this app is open.'

function SettingsSheet({ unitName, name, environment, close, leave }: { unitName: string; name: string; environment: NotificationEnvironment; close: () => void; leave: () => void | Promise<void> }) {
  const [asking, setAsking] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [permission, setPermission] = useState<DevicePermission>(() => environment.permission())
  const confirm = async () => {
    setBusy(true); setError('')
    try { await leave() } catch (cause) { setError(cause instanceof Error ? cause.message : 'This phone could not leave the unit.'); setBusy(false) }
  }
  return (
    <div className="modal-backdrop cadet-backdrop">
      <div className="modal cadet-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <h2>Settings</h2>
        <p>This phone belongs to {name} in {unitName}.</p>
        <p className="cadet-permission">{permissionText(permission)}</p>
        {permission === 'default' && <button type="button" onClick={() => void environment.requestPermission().then(setPermission)}>Allow notifications</button>}
        {asking ? (
          <>
            <div className="workflow-warning" role="alert">Leaving erases this phone&apos;s copy of your ticket and keys. To see your gear here again you will need a new ticket from your supply counter.</div>
            {error && <div className="workflow-error" role="alert">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={() => setAsking(false)} disabled={busy}>Keep my place</button>
              <button type="button" className="primary-button" onClick={() => void confirm()} disabled={busy}>{busy ? 'Leaving…' : 'Yes, leave this unit'}</button>
            </div>
          </>
        ) : (
          <div className="modal-actions">
            <button type="button" onClick={close}>Close</button>
            <button type="button" className="primary-button" onClick={() => setAsking(true)}>Leave this unit</button>
          </div>
        )}
      </div>
    </div>
  )
}
