import { useEffect, useState } from 'react'
import { UnitRuntime, type UnitRuntimeOptions } from '../runtime'
import { TicketCodeError } from '../../identity/ticketCode'
import { TicketRefusal, readTicket, redeemTicket, resumeTicketRedemption, type OpenedTicket } from '../ticketRedemption'
import { ticketCodeFromQrImage } from '../ticketQr'
import { createJoiningDevice, createMasterDevice, forgetDevice, loadDeviceVault, readRedemption, restoreFromRecoveryFile, unlockDevice, type DeviceVaultRecord, type UnlockedDevice } from '../vault'
import { plainChainError, roleLabel } from './labels'
import './unit-gate.css'

type Step = { kind: 'welcome' } | { kind: 'create' } | { kind: 'ticket' } | { kind: 'restore' } | { kind: 'unlock'; record: DeviceVaultRecord } | { kind: 'pending'; device: UnlockedDevice } | { kind: 'opening' } | { kind: 'ready'; runtime: UnitRuntime }

export type UnitGateProps = {
  children: (runtime: UnitRuntime, lock: () => void) => React.ReactNode
  /** Tests inject a fake chain and in-memory stores; the app uses WhatsOnChain testnet and IndexedDB. */
  runtimeOptions?: UnitRuntimeOptions
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}

/**
 * Everything before the main app: create a unit (first device = Master), join one with a ticket (any
 * other person), unlock an existing device, and finish a ticket the network has not yet answered.
 * Each device creates its own keys and wallet here; nothing secret is ever copied between devices.
 */
export function UnitGate({ children, runtimeOptions, storage = localStorage }: UnitGateProps) {
  const [step, setStep] = useState<Step>(() => { const record = loadDeviceVault(storage); return record ? { kind: 'unlock', record } : { kind: 'welcome' } })
  const [error, setError] = useState('')
  const open = async (device: UnlockedDevice) => {
    if (device.record.role === 'PENDING' || !device.record.unit) { setStep({ kind: 'pending', device }); return }
    setStep({ kind: 'opening' })
    try {
      const runtime = await UnitRuntime.open(device, { ...runtimeOptions, storage: runtimeOptions?.storage ?? storage })
      runtime.start()
      setStep({ kind: 'ready', runtime })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'A.R.G.U.S. could not open this unit.')
      setStep({ kind: 'unlock', record: device.record })
    }
  }
  useEffect(() => () => { if (step.kind === 'ready') step.runtime.stop() }, [step])
  const lock = () => { if (step.kind === 'ready') step.runtime.stop(); const record = loadDeviceVault(storage); setStep(record ? { kind: 'unlock', record } : { kind: 'welcome' }) }

  if (step.kind === 'ready') return <>{children(step.runtime, lock)}</>
  if (step.kind === 'opening') return <main className="loading-state unit-gate" aria-live="polite"><GateBanner /><div className="modal"><h2>Opening your unit…</h2><p>Decrypting this device&apos;s copy and checking BSV testnet for everyone&apos;s latest work.</p></div></main>
  const openOptions = { ...runtimeOptions, storage: runtimeOptions?.storage ?? storage }
  const readOptions = runtimeOptions?.api ? { api: runtimeOptions.api } : {}
  /** Redeems an opened ticket on `device` (a fresh one is made when none is given): in and open when the network accepts it, waiting when it has not answered. */
  const joinWith = async (opened: OpenedTicket, passphrase: string, existing?: UnlockedDevice) => {
    const device = existing ?? await createJoiningDevice({ passphrase, displayName: opened.displayName }, storage)
    try {
      const result = await redeemTicket(device, opened, openOptions)
      if (result.status === 'PENDING') setStep({ kind: 'pending', device: result.device }); else await open(result.device)
    } catch (cause) {
      // A redemption the network has not decided is kept (the device resumes it); a device that made nothing of the ticket is not kept.
      if (await readRedemption(device)) { setStep({ kind: 'pending', device }); return }
      if (!existing) await forgetDevice(storage)
      throw cause
    }
  }
  if (step.kind === 'welcome') return <Welcome choose={kind => { setError(''); setStep({ kind }) }} />
  if (step.kind === 'restore') return <Restore back={() => setStep({ kind: 'welcome' })} submit={async input => open(await restoreFromRecoveryFile(input, storage))} />
  if (step.kind === 'create') return <CreateUnit back={() => setStep({ kind: 'welcome' })} submit={async input => open(await createMasterDevice({ passphrase: input.passphrase, displayName: input.displayName, unitName: input.unitName }, storage))} />
  if (step.kind === 'ticket') return <TicketEntry newDevice back={() => setStep({ kind: 'welcome' })} check={code => readTicket(code, readOptions)} join={(opened, passphrase) => joinWith(opened, passphrase)} />
  if (step.kind === 'pending') return <Pending device={step.device} check={code => readTicket(code, readOptions)} join={opened => joinWith(opened, '', step.device)} resume={async () => {
    const result = await resumeTicketRedemption(step.device, openOptions)
    if (result?.status === 'ACTIVE') await open(result.device); else if (result) setStep({ kind: 'pending', device: result.device })
  }} lock={lock} />
  return <Unlock record={step.record} initialError={error} unlock={async passphrase => { setError(''); await open(await unlockDevice(step.record, passphrase)) }} reset={() => { void forgetDevice(storage).then(() => setStep({ kind: 'welcome' })) }} />
}

/** Spec §30: every screen of a testnet build says so, including the ones before sign-in. */
function GateBanner() {
  return <div className="environment-banner testnet unit-gate-banner" role="note"><strong>BSV TESTNET</strong><span>Development Environment · No Production Transactions</span></div>
}

function Welcome({ choose }: { choose: (kind: 'create' | 'ticket' | 'restore') => void }) {
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <div className="modal">
        <p className="eyebrow">A.R.G.U.S. · BSV TESTNET</p>
        <h2>Set up this device</h2>
        <p>Everyone in your unit uses their own device and their own key. Supply data is shared by writing encrypted records to the BSV testnet blockchain — there is no server and no shared password.</p>
        <div className="unit-gate-choices">
          <button className="primary-button" onClick={() => choose('ticket')}>I have a ticket<small>From your Master or Instructor: scan it or type it</small></button>
          <button className="secondary-button" onClick={() => choose('create')}>Create a new unit<small>Only the first person, who becomes the unit&apos;s Master</small></button>
          <button className="secondary-button" onClick={() => choose('restore')}>Restore Master from a recovery file<small>The Master&apos;s device was lost or its passphrase forgotten</small></button>
        </div>
      </div>
    </main>
  )
}

function CreateUnit({ back, submit }: { back: () => void; submit: (input: { unitName: string; displayName: string; passphrase: string }) => Promise<void> }) {
  const [unitName, setUnitName] = useState(''), [displayName, setDisplayName] = useState(''), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (passphrase !== confirm) { setError('The passphrases do not match.'); return }
    setBusy(true); setError('')
    try { await submit({ unitName, displayName, passphrase }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'This device could not be set up.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Create a new unit" onSubmit={onSubmit}>
        <h2>Create a new unit</h2>
        <p>This device becomes the unit&apos;s <strong>Master</strong>: it holds the unit authority key that makes tickets for new people and the key that encrypts the unit&apos;s records. Keep this device and its passphrase safe.</p>
        <label className="field">UNIT NAME<input aria-label="Unit name" value={unitName} onChange={event => setUnitName(event.target.value)} maxLength={80} required placeholder="e.g. Bethel NJROTC" /></label>
        <label className="field">YOUR NAME OR CALL SIGN<input aria-label="Your name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={60} required autoComplete="nickname" /><small>Shown to the rest of the unit (stored encrypted).</small></label>
        <label className="field">PASSPHRASE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>At least 12 characters with a letter and a number. It cannot be recovered.</small></label>
        <label className="field">CONFIRM PASSPHRASE<input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={back} disabled={busy}>Back</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Creating keys…' : 'Create unit'}</button>
        </div>
      </form>
    </main>
  )
}

function Unlock({ record, unlock, reset, initialError }: { record: DeviceVaultRecord; unlock: (passphrase: string) => Promise<void>; reset: () => void; initialError: string }) {
  const [passphrase, setPassphrase] = useState(''), [error, setError] = useState(initialError), [busy, setBusy] = useState(false), [resetting, setResetting] = useState(false), [confirmReset, setConfirmReset] = useState('')
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await unlock(passphrase) } catch (cause) { setError(cause instanceof Error ? cause.message : 'This device could not be unlocked.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Unlock A.R.G.U.S." onSubmit={onSubmit}>
        <p className="eyebrow">{record.unit ? record.unit.unitName.toUpperCase() : 'JOINING WITH A TICKET'}</p>
        <h2>Unlock A.R.G.U.S.</h2>
        <p>Welcome back, {record.displayName}. Enter this device&apos;s passphrase.</p>
        <label className="field">PASSPHRASE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} required autoFocus autoComplete="current-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Unlocking…' : 'Unlock'}</button></div>
        <details className="unit-gate-reset" open={resetting} onToggle={event => setResetting((event.target as HTMLDetailsElement).open)}>
          <summary>Forgot the passphrase?</summary>
          <p>The passphrase cannot be recovered. You can erase this device and join the unit again with a new ticket from your Master or Instructor; everything shared returns from the chain. Anything this device had not yet published is lost.</p>
          <label className="field">TYPE ERASE TO CONFIRM<input aria-label="Type ERASE to confirm" value={confirmReset} onChange={event => setConfirmReset(event.target.value)} /></label>
          <button type="button" disabled={confirmReset !== 'ERASE'} onClick={reset}>Erase this device</button>
        </details>
      </form>
    </main>
  )
}

/** Words for a ticket that cannot be used (the code reader's and the ticket checker's own sentences); a lost connection in plain words; anything else as it was said. */
function ticketProblem(cause: unknown, fallback: string) {
  if (!(cause instanceof Error)) return fallback
  if (cause instanceof TicketRefusal || cause instanceof TicketCodeError) return cause.message
  return /could not reach|failed to fetch|network|timed? ?out|offline/i.test(cause.message) ? `${plainChainError(cause.message)} Try again.` : cause.message
}

/**
 * Scan or type a ticket, see who it is for, and join. `newDevice`: this device has no keys yet, so it also asks for a passphrase
 * and makes its keys only once the ticket has been checked and is about to be used.
 */
function TicketEntry({ newDevice, back, backLabel = 'Back', check, join }: { newDevice: boolean; back: () => void; backLabel?: string; check: (code: string) => Promise<OpenedTicket>; join: (opened: OpenedTicket, passphrase: string) => Promise<void> }) {
  const [code, setCode] = useState(''), [opened, setOpened] = useState<OpenedTicket>(), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const checkCode = async (text: string) => {
    setBusy(true); setError(''); setOpened(undefined)
    try { setOpened(await check(text)) } catch (cause) { setError(ticketProblem(cause, 'This ticket could not be checked.')) } finally { setBusy(false) }
  }
  const scan = (file: File | undefined) => {
    if (!file) return
    setError(''); setOpened(undefined)
    void ticketCodeFromQrImage(file).then(text => { setCode(text); return checkCode(text) }, cause => setError(cause instanceof Error ? cause.message : 'That QR image could not be read.'))
  }
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!opened) { await checkCode(code); return }
    if (newDevice && passphrase !== confirm) { setError('The passphrases do not match.'); return }
    setBusy(true); setError('')
    try { await join(opened, passphrase) } catch (cause) { setError(ticketProblem(cause, 'This ticket could not be used.')); setOpened(undefined); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="I have a ticket" onSubmit={onSubmit}>
        <h2>I have a ticket</h2>
        <p>Your Master or Instructor made you a ticket. Scan its QR, or type its code (capitals, spaces and dashes do not matter). It works once.</p>
        <label className="field">TICKET CODE<input aria-label="Ticket code" value={code} onChange={event => { setCode(event.target.value); setOpened(undefined); setError('') }} autoComplete="off" autoCapitalize="characters" spellCheck={false} required placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" /></label>
        <label className="field">OR A PICTURE OF ITS QR<input type="file" accept="image/*" capture="environment" aria-label="Ticket QR image" onChange={event => { scan(event.target.files?.[0]); event.target.value = '' }} /><small>Your phone may offer its camera or photo library. The picture never leaves this device.</small></label>
        {opened && (
          <div className="validation" role="status">
            <strong>Ticket for {opened.displayName}</strong>
            <p>{roleLabel(opened.role)} · {opened.unitName} · made by {opened.issuerDisplayName}. Good until {new Date(opened.expiresAt).toLocaleDateString()}.</p>
          </div>
        )}
        {opened && newDevice && (
          <>
            <label className="field">PASSPHRASE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>At least 12 characters with a letter and a number. It cannot be recovered.</small></label>
            <label className="field">CONFIRM PASSPHRASE<input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
          </>
        )}
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={back} disabled={busy}>{backLabel}</button>
          <button className="primary-button" type="submit" disabled={busy || !code.trim()}>{busy ? 'Working…' : opened ? 'Join unit' : 'Check ticket'}</button>
        </div>
      </form>
    </main>
  )
}

/** A device that has keys but no unit yet: it is finishing a ticket the network has not answered, or has not been given one. */
function Pending({ device, check, join, resume, lock }: { device: UnlockedDevice; check: (code: string) => Promise<OpenedTicket>; join: (opened: OpenedTicket) => Promise<void>; resume: () => Promise<void>; lock: () => void }) {
  const [waiting, setWaiting] = useState<boolean>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [again, setAgain] = useState(false)
  useEffect(() => { let active = true; void readRedemption(device).then(found => { if (active) setWaiting(Boolean(found)) }); return () => { active = false } }, [device])
  if (waiting === undefined) return <main className="loading-state unit-gate" aria-live="polite"><GateBanner /><div className="modal"><h2>Checking your ticket…</h2></div></main>
  if (!waiting) return <TicketEntry newDevice={false} back={lock} backLabel="Lock" check={check} join={opened => join(opened)} />
  const retry = async () => {
    setBusy(true); setError(''); setAgain(false)
    try { await resume(); setAgain(true) } catch (cause) { setError(ticketProblem(cause, 'This ticket could not be finished.')) } finally { setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <div className="modal">
        <h2>Finishing joining</h2>
        <p>Your ticket was accepted on this device, but the network has not confirmed it yet. This usually means no connection. Nothing is lost: try again when you are online.</p>
        {again && <div className="validation" role="status">Still waiting for the network. Try again in a moment.</div>}
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={lock}>Lock</button>
          <button className="primary-button" type="button" disabled={busy} onClick={() => void retry()}>{busy ? 'Trying…' : 'Try again'}</button>
        </div>
        <p className="safe-note">This device&apos;s testnet wallet: <code>{device.record.walletAddress}</code></p>
      </div>
    </main>
  )
}

function Restore({ back, submit }: { back: () => void; submit: (input: { fileText: string; recoveryPassphrase: string; passphrase: string; displayName: string }) => Promise<void> }) {
  const [fileText, setFileText] = useState(''), [recoveryPassphrase, setRecoveryPassphrase] = useState(''), [displayName, setDisplayName] = useState(''), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const readFile = async (file: File | undefined) => { if (file) setFileText((await file.text()).trim()) }
  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (passphrase !== confirm) { setError('The new passphrases do not match.'); return }
    setBusy(true); setError('')
    try { await submit({ fileText, recoveryPassphrase, passphrase, displayName }) } catch (cause) { setError(cause instanceof Error ? cause.message : 'The unit could not be restored.'); setBusy(false) }
  }
  return (
    <main className="loading-state unit-gate" aria-live="polite">
      <GateBanner />
      <form className="modal" aria-label="Restore Master from a recovery file" onSubmit={onSubmit}>
        <h2>Restore Master from a recovery file</h2>
        <p>This device gets its own new keys and takes the Master role back. Afterwards, open <strong>Members &amp; access</strong> and remove the lost device.</p>
        <label className="field">RECOVERY FILE<input type="file" accept=".txt,text/plain" aria-label="Recovery file" onChange={event => void readFile(event.target.files?.[0])} /><textarea aria-label="Recovery file text" rows={3} value={fileText} onChange={event => setFileText(event.target.value)} placeholder="…or paste the file's contents (starts with ARGUS-RECOVERY-1:)" required /></label>
        <label className="field">RECOVERY PASSPHRASE<input type="password" aria-label="Recovery passphrase" value={recoveryPassphrase} onChange={event => setRecoveryPassphrase(event.target.value)} required autoComplete="off" /></label>
        <label className="field">YOUR NAME OR CALL SIGN<input aria-label="Your name" value={displayName} onChange={event => setDisplayName(event.target.value)} maxLength={60} required autoComplete="nickname" /></label>
        <label className="field">NEW PASSPHRASE FOR THIS DEVICE<input type="password" aria-label="Passphrase" value={passphrase} onChange={event => setPassphrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>At least 12 characters with a letter and a number. It cannot be recovered.</small></label>
        <label className="field">CONFIRM PASSPHRASE<input type="password" aria-label="Confirm passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
        {error && <div className="workflow-error" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={back} disabled={busy}>Back</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Restoring…' : 'Restore Master'}</button>
        </div>
      </form>
    </main>
  )
}
