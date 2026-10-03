import { useEffect, useState } from 'react'
import { KeyRound, Wallet } from 'lucide-react'
import { Drawer } from '../../components/Drawer'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusRole } from '../../distributed/types'
import type { WalletBalance } from '../../chain/types'
import { plural } from '../../plural'
import { DEFAULT_MEMBER_TOP_UP_SATOSHIS, type UnitRuntime, type UnitStatus } from '../runtime'
import { plainChainError, roleLabel, syncLabel, syncOutcome } from './labels'

const explorer = (kind: 'address' | 'tx', value: string) => `https://test.whatsonchain.com/${kind}/${value}`
/** A public BSV testnet faucet; the coins it sends have no value. */
const TESTNET_FAUCET_URL = 'https://witnessonchain.com/faucet/tbsv'
const shortId = (value: string) => value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

const ROLE_CHOICES: Array<{ role: ArgusRole; label: string }> = [
  { role: 'SUPPLY_ASSISTANT', label: 'Supply Assistant' },
  { role: 'SUPPLY_OFFICER', label: 'Supply Officer' },
  { role: 'INSTRUCTOR', label: 'Instructor' },
  { role: 'MASTER', label: 'Master (delegated)' },
]
function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' })), link = document.createElement('a')
  link.href = url; link.download = fileName; document.body.append(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** Who is in the unit and, for Masters, changing roles, removing people and the recovery file. (New people join with a ticket: TicketsPanel.) */
export function MembersPanel({ runtime, projection, close, onProjection, notify }: { runtime: UnitRuntime; projection: ArgusAppProjection; close: () => void; onProjection: (projection: ArgusAppProjection) => void; notify: (message: string) => void }) {
  const record = runtime.device.record, status = runtime.status(), isMaster = record.role === 'MASTER' && !status.revoked, holdsAuthority = status.holdsAuthority
  const roleChoices = ROLE_CHOICES.filter(choice => choice.role !== 'MASTER' || holdsAuthority)
  const [revoking, setRevoking] = useState(''), [confirmRevoke, setConfirmRevoke] = useState(''), [changing, setChanging] = useState(''), [newRole, setNewRole] = useState<ArgusRole>('SUPPLY_OFFICER'), [working, setWorking] = useState('')
  const revoke = async (publicIdentity: string) => {
    setWorking(publicIdentity)
    try {
      const { rotation, ...next } = await runtime.revoke(publicIdentity)
      onProjection(next); setRevoking(''); setConfirmRevoke('')
      notify(`Access removed. A new unit key went to ${rotation.recipients} ${rotation.recipients === 1 ? 'person' : 'people'}; they cannot read anything written from now on.${rotation.missing.length ? ` ${rotation.missing.join(', ')} joined before key hand-over existed and need a new ticket to keep reading.` : ''}`)
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Access could not be removed.') } finally { setWorking('') }
  }
  const changeRole = async (publicIdentity: string, displayName: string) => {
    setWorking(publicIdentity)
    try { onProjection(await runtime.changeRole(publicIdentity, newRole)); setChanging(''); notify(`${displayName} is now ${roleLabel(newRole)}. Their device picks this up on its next sync.`) }
    catch (cause) { notify(cause instanceof Error ? cause.message : 'The role could not be changed.') } finally { setWorking('') }
  }
  const members = [...projection.members].sort((a, b) => Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') || a.displayName.localeCompare(b.displayName))
  const nobodyElse = !members.some(member => member.publicIdentity !== record.signingIdentity)
  return (
    <Drawer title="Members & access" icon={<KeyRound />} close={close}>
      <div className="panel-rows">
        <p><small>UNIT</small><br /><strong>{record.unit?.unitName}</strong></p>
        <p><small>YOU</small><br /><strong>{record.displayName}</strong> · {status.revoked ? 'Access removed' : roleLabel(record.role)}{holdsAuthority ? ' · holds the unit authority' : ''}</p>
        <details className="technical-details"><summary>Technical details</summary><p><small>Unit ID</small> <code>{record.unit?.unitId}</code></p></details>
      </div>
      <h3>People in this unit</h3>
      <ul className="panel-rows" aria-label="People in this unit">
        {members.map(member => {
          const isYou = member.publicIdentity === record.signingIdentity, manageable = isMaster && !isYou && member.status === 'ACTIVE' && (member.role !== 'MASTER' || holdsAuthority)
          return (
            <li key={member.publicIdentity}>
              <p>
                <strong>{isYou ? `${member.displayName} (you)` : member.displayName}</strong> · {roleLabel(member.role)} · {member.status === 'INVITED' ? 'Invitation sent — waiting for their device' : member.status === 'ACTIVE' ? `since ${new Date(member.roleChangedAt ?? member.activatedAt ?? member.issuedAt).toLocaleDateString()}` : `access removed ${member.revokedAt ? new Date(member.revokedAt).toLocaleDateString() : ''}`}
                {member.walletAddress && <><br /><small>Wallet <a href={explorer('address', member.walletAddress)} target="_blank" rel="noreferrer">{shortId(member.walletAddress)}</a></small></>}
              </p>
              {manageable && changing === member.publicIdentity && (
                <div className="modal-actions">
                  <select aria-label={`New role for ${member.displayName}`} value={newRole} onChange={event => setNewRole(event.target.value as ArgusRole)}>{roleChoices.filter(choice => choice.role !== member.role).map(choice => <option key={choice.role} value={choice.role}>{choice.label}</option>)}</select>
                  <button disabled={working === member.publicIdentity} onClick={() => void changeRole(member.publicIdentity, member.displayName)}>Change role</button>
                  <button onClick={() => setChanging('')}>Cancel</button>
                </div>
              )}
              {manageable && revoking === member.publicIdentity && (
                <div className="modal-actions">
                  <input aria-label={`Type REVOKE to remove ${member.displayName}`} placeholder="Type REVOKE" value={confirmRevoke} onChange={event => setConfirmRevoke(event.target.value)} />
                  <button disabled={confirmRevoke !== 'REVOKE' || working === member.publicIdentity} onClick={() => void revoke(member.publicIdentity)}>{working === member.publicIdentity ? 'Removing…' : 'Remove access'}</button>
                  <button onClick={() => setRevoking('')}>Cancel</button>
                </div>
              )}
              {manageable && changing !== member.publicIdentity && revoking !== member.publicIdentity && (
                <div className="modal-actions">
                  <button className="secondary-button" onClick={() => { setChanging(member.publicIdentity); setRevoking(''); setNewRole(roleChoices.find(choice => choice.role !== member.role)!.role) }}>Change role…</button>
                  <button className="secondary-button" onClick={() => { setRevoking(member.publicIdentity); setChanging(''); setConfirmRevoke('') }}>Remove access…</button>
                </div>
              )}
            </li>
          )
        })}
        {nobodyElse && <li><p>{status.lastScanAt ? 'No one else has been admitted yet.' : 'The member list appears after this device’s first sync with BSV testnet.'}</p></li>}
      </ul>
      {isMaster && <p className="safe-note">Removing someone also replaces the unit key for everyone else, so they cannot read anything written afterwards. Their earlier work stays in the record.</p>}
      <p className="safe-note">{isMaster ? 'To add a person, make them a ticket in Tickets (Command Center). Only a Master can remove people or change their role.' : 'To add a person, ask a Master or an Instructor for a ticket. Only a Master can remove people or change their role.'}</p>
      {isMaster && holdsAuthority && <RecoveryFileSection runtime={runtime} registeredAt={projection.recoveryKey?.registeredAt} notify={notify} onProjection={onProjection} />}
    </Drawer>
  )
}

/** Original (or recovered) Master only: a passphrase-encrypted file that restores Master authority on a new device. */
function RecoveryFileSection({ runtime, registeredAt, notify, onProjection }: { runtime: UnitRuntime; registeredAt?: string; notify: (message: string) => void; onProjection: (projection: ArgusAppProjection) => void }) {
  const [phrase, setPhrase] = useState(''), [confirm, setConfirm] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); setError('')
    if (phrase !== confirm) { setError('The recovery passphrases do not match.'); return }
    setBusy(true)
    try {
      const fileText = await runtime.exportRecovery(phrase)
      downloadText(`argus-recovery-${runtime.device.record.unit!.unitId}.txt`, fileText)
      setPhrase(''); setConfirm(''); onProjection(await runtime.controller.project())
      notify('Recovery file downloaded. Store it offline (USB stick or printed) and keep the recovery passphrase somewhere else.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The recovery file could not be created.') } finally { setBusy(false) }
  }
  return (
    <form className="panel-rows" aria-label="Recovery file" onSubmit={create}>
      <h3>Recovery file</h3>
      <p>If this device is lost or its passphrase forgotten, a recovery file lets a new device take the Master role back, remove this one, and keep reading everything, including data written after the file was made.</p>
      {registeredAt && <p className="safe-note">A recovery key has been set up for this unit since {new Date(registeredAt).toLocaleDateString()}. Making a new file re-uses it.</p>}
      <label className="field">RECOVERY PASSPHRASE<input type="password" aria-label="Recovery passphrase" value={phrase} onChange={event => setPhrase(event.target.value)} minLength={12} required autoComplete="new-password" /><small>Different from this device&apos;s passphrase. At least 12 characters with a letter and a number.</small></label>
      <label className="field">CONFIRM RECOVERY PASSPHRASE<input type="password" aria-label="Confirm recovery passphrase" value={confirm} onChange={event => setConfirm(event.target.value)} minLength={12} required autoComplete="new-password" /></label>
      {error && <div className="workflow-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="primary-button" type="submit" disabled={busy}>{busy ? 'Encrypting…' : 'Download recovery file'}</button></div>
    </form>
  )
}

/** This device's testnet wallet and how its sync with the chain is going. */
export function WalletPanel({ runtime, status, close, notify }: { runtime: UnitRuntime; status: UnitStatus; close: () => void; notify: (message: string) => void }) {
  const [balance, setBalance] = useState<WalletBalance>(), [error, setError] = useState(''), [copied, setCopied] = useState(false), [busy, setBusy] = useState(false)
  const [to, setTo] = useState(''), [amount, setAmount] = useState(String(DEFAULT_MEMBER_TOP_UP_SATOSHIS)), [syncing, setSyncing] = useState(false)
  const refresh = async () => { setBusy(true); setError(''); try { setBalance(await runtime.balance()) } catch (cause) { setError(plainChainError(cause instanceof Error ? cause.message : undefined)) } finally { setBusy(false) } }
  useEffect(() => { let active = true; runtime.balance().then(value => { if (active) setBalance(value) }, cause => { if (active) setError(plainChainError(cause instanceof Error ? cause.message : undefined)) }); return () => { active = false } }, [runtime])
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    const satoshis = Number(amount)
    if (!Number.isInteger(satoshis) || satoshis < 1) { notify('Enter a whole number of satoshis.'); return }
    try { const txid = await runtime.sendSatoshis(to.trim(), satoshis); notify(`Sent ${satoshis.toLocaleString()} testnet satoshis (${shortId(txid)}).`); await refresh() } catch (cause) { notify(cause instanceof Error ? cause.message : 'The transfer failed.') }
  }
  const address = runtime.device.record.walletAddress
  return (
    <Drawer title="Wallet & sync" icon={<Wallet />} close={close}>
      <div className="notice"><div><strong>BSV TESTNET ONLY</strong><p>These are test coins with no value. Never send real (mainnet) BSV to this address.</p></div></div>
      {status.needsFunding && <div className="workflow-error" role="alert">This device needs testnet coins to publish its {status.queued} queued change{status.queued === 1 ? '' : 's'}. Ask your Master for a top-up or use a BSV testnet faucet.</div>}
      <label className="field">THIS DEVICE&apos;S TESTNET ADDRESS<input readOnly aria-label="This device's testnet address" value={address} /></label>
      <div className="modal-actions">
        <button onClick={() => void navigator.clipboard.writeText(address).then(() => setCopied(true), () => undefined)}>{copied ? 'Address copied ✓' : 'Copy address'}</button>
        <a className="secondary-button" href={explorer('address', address)} target="_blank" rel="noreferrer">View on explorer</a>
        <a className="secondary-button" href={TESTNET_FAUCET_URL} target="_blank" rel="noreferrer">Get testnet coins</a>
        <button onClick={() => void refresh()} disabled={busy}>{busy ? 'Checking…' : 'Refresh balance'}</button>
      </div>
      {error && <div className="workflow-error" role="alert">{error}</div>}
      <div className="panel-rows" aria-label="Wallet balance">
        <p><small>SPENDABLE</small><br /><strong>{balance ? `${balance.spendable.toLocaleString()} satoshis` : '—'}</strong></p>
        <p><small>CONFIRMED · UNCONFIRMED</small><br />{balance ? `${balance.confirmed.toLocaleString()} · ${balance.unconfirmed.toLocaleString()}` : '—'}</p>
        <p><small>ABOUT</small><br />Each shared change costs about 2–5 satoshis; 1,000 satoshis covers a few hundred changes.</p>
      </div>
      <h3>Sync with BSV testnet</h3>
      <div className="panel-rows" aria-label="Sync status">
        <p><small>STATUS</small><br /><strong>{syncLabel(status)}</strong>{status.lastError && status.state !== 'synced' ? ` · ${plainChainError(status.lastError)}` : ''}</p>
        {status.lastError && status.state !== 'synced' && <details className="technical-details"><summary>Technical details</summary><p><code>{status.lastError}</code></p></details>}
        <p><small>WAITING TO PUBLISH · AWAITING CONFIRMATION</small><br />{status.queued} · {status.awaitingConfirmation}</p>
        <p><small>LAST CHECKED</small><br />{status.lastScanAt ? new Date(status.lastScanAt).toLocaleString() : 'Not yet'}</p>
        <p><small>UNIT HISTORY ADDRESS</small><br /><a href={explorer('address', status.anchorAddress)} target="_blank" rel="noreferrer">{status.anchorAddress}</a></p>
        {status.unreadable > 0 && <p role="alert">{plural(status.unreadable, 'record')} could not be decrypted on this device yet.</p>}
      </div>
      <button className="primary-button" disabled={syncing} onClick={() => { setSyncing(true); void runtime.syncNow().then(() => notify(syncOutcome(runtime.status()).message), () => notify(syncOutcome({ ...runtime.status(), state: 'error' }).message)).finally(() => setSyncing(false)) }}>{syncing ? 'Syncing…' : 'Sync now'}</button>
      {runtime.device.record.role === 'MASTER' && (
        <form className="panel-rows" aria-label="Send testnet satoshis" onSubmit={send}>
          <h3>Top up a member</h3>
          <label className="field">TO ADDRESS<input aria-label="Recipient address" value={to} onChange={event => setTo(event.target.value)} required placeholder="m… or n…" /></label>
          <label className="field">SATOSHIS<input aria-label="Satoshis" inputMode="numeric" value={amount} onChange={event => setAmount(event.target.value)} required /></label>
          <div className="modal-actions"><button className="primary-button" type="submit">Send</button></div>
        </form>
      )}
    </Drawer>
  )
}
