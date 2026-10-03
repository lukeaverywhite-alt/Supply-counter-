import { P2PKH, Transaction } from '@bsv/sdk'
import { AuthorizationService, ROLE_PERMISSIONS, isTicketCredential, issueCredential, issueRevocation, lacksRolePermissions, reissueCredential, ticketCredential, ticketRuleViolation } from '../auth/authorization'
import type { ChainApi, WalletBalance, WalletStateStore } from '../chain/types'
import { DeviceWallet, InsufficientFundsError } from '../chain/wallet'
import { IndexedDbWalletStateStore } from '../chain/walletStore'
import { WhatsOnChainApi } from '../chain/woc'
import { canonicalize } from '../distributed/canonical'
import { DistributedAppController, type ArgusAppProjection } from '../distributed/appIntegration'
import { isAuthorBoundEventId, unsignedEventJson } from '../distributed/replica'
import type { ArgusRole, AuthorityCredential, NoticeAudience, SignedArgusEvent } from '../distributed/types'
import { decodeTicketCode, encodeTicketCode, makeTicketSecret } from '../identity/ticketCode'
import { deriveTicketKeys, newTicketEcdhKeyPair, newTicketId } from '../identity/ticketKeys'
import { unsignedKeyGrantFields, unwrapEpochKeyFromGrant, wrapEpochKeyForGrant } from '../private-sync/keyGrant'
import { TICKET_LIFETIME_MS, parseCadetJoinedRecord, parseKeyGrantRecord } from '../private-sync/schema'
import { sealTicketRecord } from '../private-sync/ticketRecord'
import { listTickets } from '../private-sync/tickets'
import type { CadetJoinedRecord, CadetTicketPackage, KeyGrantRecord, TicketCancellation, TicketFundingOutpoint, TicketInvitation, TicketPackage } from '../private-sync/types'
import { MemoryRepository } from '../storage/repository'
import { cadetLabel } from '../stage3/domain'
import { CadetPublisher, type CadetPublishProgress } from './cadetPublisher'
import { readChannelRecords, type ChannelRecordRead } from './channelReader'
import { IndexedDbLedgerStore, type LedgerStore } from './ledgerStore'
import { UnitEventSyncProvider } from './syncProvider'
import { ChainTransport, type TransportStatus } from './transport'
import { openEnvelope } from './envelope'
import { exportRecoveryFile, forgetTicketSecret, installUnitKey, newUnitKey, rawUnitKeys, readTicketSecret, recoveryFingerprint, recoveryGranteeIdentity, sealTicketSecret, setCurrentEpoch, ticketGranteeIdentity, updateDeviceCredential, type UnlockedDevice } from './vault'

export type UnitRuntimeOptions = {
  api?: ChainApi
  ledger?: LedgerStore
  walletStore?: WalletStateStore
  /** Where the device record is saved (defaults to localStorage). */
  storage?: Pick<Storage, 'getItem' | 'setItem'>
}
/** revoked: a Master removed this person; the device can still show what it knew but nothing it does is accepted. */
export type UnitStatus = TransportStatus & { unitId: string; unitName: string; role: ArgusRole; displayName: string; walletAddress: string; unreadable: number; revoked: boolean; holdsAuthority: boolean; currentEpoch: string }
/** Default satoshis the Master sends a newly admitted member so they can publish right away (≈ 400+ records at 1 sat/kB). Editable at admission. */
export const DEFAULT_MEMBER_TOP_UP_SATOSHIS = 2_000
export type KeyRotationResult = { epochId: string; recipients: number; missing: string[] }
/** What the issuer gets back for a new ticket: the code to hand to the named person (or show as a QR), and when it runs out. */
export type IssuedTicket = { ticketId: string; code: string; displayName: string; role: ArgusRole; ticketAddress: string; issuedAt: string; expiresAt: string; funding: TicketFundingOutpoint }
/** CANCELLED: the network accepted the cancelling transaction and the unit has been told. PENDING: it is saved and goes out when the network is reachable; call cancelTicket again then. */
export type TicketCancelResult = { status: 'CANCELLED' | 'PENDING'; txid: string }
/** Satoshis kept back beyond the starter satoshis when making a ticket, for the fees of its record and of the fact that announces it. */
export const TICKET_FEE_RESERVE_SATOSHIS = 50
/** Starter satoshis on a cadet's ticket: the phone's redemption pays its small fee from them and sends the rest back to the issuer. */
export const CADET_TICKET_SATOSHIS = 500
/** A cadet's ticket (ADR 013): the code to hand to the cadet, and the channel it opens. */
export type IssuedCadetTicket = { ticketId: string; code: string; cadetId: string; displayName: string; ticketAddress: string; channelAddress: string; issuedAt: string; expiresAt: string; funding: TicketFundingOutpoint }
/** What staff read from a cadet's channel on demand: every record that opens, and the latest CADET_JOINED (absent: no phone yet). */
export type CadetChannelReading = { cadetId: string; channelAddress?: string; records: ChannelRecordRead[]; joined?: CadetJoinedRecord }
/** The cadet drawer's Phone line: "Phone: joined <date>" once a phone joined the cadet's current channel, else "No phone yet". */
export const cadetPhoneLine = (reading: Pick<CadetChannelReading, 'joined'>) => reading.joined ? `Phone: joined ${reading.joined.joinedAt.slice(0, 10)}` : 'No phone yet'

/**
 * The cadets whose record an event changes, whether or not its payload names one. A cadet's channel being made or replaced (and a ticket
 * for it) puts the record there for the first time. Otherwise: the cadet the payload, the entity, a Still Needed line or a transaction
 * names, and every cadet or Still Needed line the fold says this very event changed (import, annual rollover, a conflict settled as
 * Still Needed). Notices and tickets of the unit are not changes to a record.
 */
const cadetIdsOf = (event: SignedArgusEvent, state: Awaited<ReturnType<DistributedAppController['technicalState']>>) => {
  const ids = new Set<string>()
  if (event.eventType === 'CADET_CHANNEL_CREATED' || event.eventType === 'CADET_CHANNEL_ROTATED') ids.add(event.entityId)
  else if (event.eventType === 'CADET_TICKET_ISSUED') { if (typeof event.payload.cadetId === 'string') ids.add(event.payload.cadetId) }
  else if (!/^CADET_(CHANNEL|NOTICES|TICKET)/.test(event.eventType) && event.eventType !== 'NOTICE_SENT') {
    if (typeof event.payload.cadetId === 'string') ids.add(event.payload.cadetId)
    for (const cadet of state.cadets) if (cadet.cadetId === event.entityId || cadet.appliedEventIds.includes(event.eventId)) ids.add(cadet.cadetId)
    for (const need of state.stillNeeded) if (need.requirementId === event.entityId || need.appliedEventIds.includes(event.eventId)) ids.add(need.cadetId)
    const transaction = state.transactions.find(candidate => candidate.transactionId === event.entityId)
    if (transaction) ids.add(transaction.cadetId)
  }
  return [...ids]
}

const importEcdhPublic = (spki: string) => { const normalized = spki.replaceAll('-', '+').replaceAll('_', '/'); const bytes = Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)); return crypto.subtle.importKey('spki', bytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }

/**
 * Everything one unlocked, admitted device needs to share the unit's data over BSV TESTNET:
 * its own identity and wallet, the unit key, an encrypted local ledger, the chain transport, and
 * the application controller whose projection every screen reads.
 */
export class UnitRuntime {
  private listeners = new Set<(projection: ArgusAppProjection) => void>()
  private statusListeners = new Set<(status: UnitStatus) => void>()
  private revoked = false
  private reconciling?: Promise<ArgusAppProjection>
  /** Keeps each cadet's channel up to date with what this device commits (ADR 013, mw-kmgi38.3). */
  readonly cadetPublisher: CadetPublisher
  private constructor(
    readonly device: UnlockedDevice,
    readonly controller: DistributedAppController,
    readonly transport: ChainTransport,
    readonly wallet: DeviceWallet,
    readonly authorization: AuthorizationService,
    private readonly provider: UnitEventSyncProvider,
    private readonly options: UnitRuntimeOptions,
    private readonly api: ChainApi,
  ) {
    this.cadetPublisher = new CadetPublisher({
      channelFor: async cadetId => { const channel = (await controller.technicalState()).cadetChannels.find(entry => entry.cadetId === cadetId); return channel && { key: channel.channelKey, address: channel.channelAddress } },
      viewFor: cadetId => controller.cadetViewFor(cadetId),
      noticeFor: async noticeId => {
        const state = await controller.technicalState(), notice = state.notices.find(entry => entry.noticeId === noticeId)
        if (!notice) return undefined
        const channels = state.cadetChannels.filter(entry => notice.audience === 'all' || entry.cadetId === notice.audience.cadetId).map(entry => ({ key: entry.channelKey, address: entry.channelAddress }))
        const sender = state.members.find(member => member.publicIdentity === notice.sentBy)
        return { channels, record: { noticeId, text: notice.text, sentAt: notice.sentAt, from: sender?.displayName ?? 'Staff' } }
      },
      cadetIdsFor: async event => this.revoked ? [] : cadetIdsOf(event, await controller.technicalState()),
      wallet, storage: options.storage ?? localStorage, storageKey: `argus.cadet-publish.v1.${device.record.unit!.unitId}`,
    })
  }

  private get storage() { return this.options.storage ?? localStorage }

  static async open(device: UnlockedDevice, options: UnitRuntimeOptions = {}) {
    const { record } = device, unit = record.unit
    if (!unit || !record.credential || record.role === 'PENDING') throw new Error('This device has not been admitted to a unit yet.')
    // A ticket credential's permissions are its role's, derived anew by every verifier: this device's own copy follows (mw-kmgi38.11).
    if (isTicketCredential(record.credential)) { const derived = ticketCredential(record.credential.ticket); if (canonicalize(derived) !== canonicalize(record.credential)) await updateDeviceCredential(device, derived, options.storage ?? localStorage) }
    const authorization = new AuthorizationService(unit.authorityIdentity, device.identity)
    const api = options.api ?? new WhatsOnChainApi()
    const ledger = options.ledger ?? new IndexedDbLedgerStore(unit.unitId)
    const wallet = DeviceWallet.fromWif(device.walletWif, api, options.walletStore ?? new IndexedDbWalletStateStore())
    // The provider, transport and runtime refer to each other through callbacks that only run after construction.
    const late: { transport?: ChainTransport; runtime?: UnitRuntime } = {}
    // A record is genuine only if its event ID is bound to its author and the author's signature checks out: nobody holding
    // the unit key can publish under someone else's event ID and so suppress their record on other devices.
    const genuine = async (event: SignedArgusEvent) => await isAuthorBoundEventId(event.eventId, event.actorPublicIdentity) && device.identity.verify(unsignedEventJson(event), event.signature, event.actorPublicIdentity)
    // Epoch and credential are read live: a key rotation or role change takes effect for the very next record.
    const provider = new UnitEventSyncProvider({ unitId: unit.unitId, store: ledger, currentEpoch: () => device.record.unit!.currentEpoch, keyFor: async epoch => device.unitKeys.get(epoch), credential: () => device.record.credential!, authorization, validate: genuine, onQueued: () => { void late.transport?.poke() }, onLocalEvent: event => late.runtime?.cadetPublisher.noteEvent(event) })
    // A device admitted by a delegated Master needs that Master's credential before its own can be verified.
    if (record.issuerCredential) await provider.offerCredential(record.issuerCredential)
    await provider.offerCredential(record.credential)
    const controller = new DistributedAppController(new MemoryRepository(), { identity: device.identity, authorization, provider, organizationId: unit.unitId, genesisCatalog: true, strictPublish: true, authorBoundEventIds: true })
    const transport = late.transport = new ChainTransport({
      unitId: unit.unitId, api, wallet, store: ledger,
      onRemoteEnvelopes: async records => { provider.enqueueRemote(records.map(item => item.eventId)); await late.runtime?.settle(await controller.sync()) },
      onPublished: async (eventIds, txid) => { await late.runtime?.settle(await controller.markPublished(eventIds, txid)) },
      // Rolled back, re-queued, seen on chain, mined: only the records' delivery changed, so just show it.
      onDelivery: async eventIds => { if (late.runtime) late.runtime.emit(await controller.refreshDelivery(eventIds)) },
      onStatus: () => late.runtime?.emitStatus(),
      checkEnvelope: async envelope => { try { const { event } = await openEnvelope(envelope, async epoch => device.unitKeys.get(epoch)); return await genuine(event) ? 'valid' : 'invalid' } catch (error) { return error instanceof Error && error.message.startsWith('NO_EPOCH_KEY') ? 'unknown' : 'invalid' } },
    })
    await provider.prime()
    const runtime = late.runtime = new UnitRuntime(device, controller, transport, wallet, authorization, provider, options, api)
    await runtime.reconcile(await controller.initialize())
    runtime.cadetPublisher.resume()
    return runtime
  }

  start(intervalMs?: number) { this.transport.start(intervalMs); this.cadetPublisher.resume() }
  stop() { this.transport.stop(); this.cadetPublisher.stop() }
  /** Publish anything queued and pull everything new right now. */
  async syncNow() { await this.transport.poke(); return this.settle(await this.controller.sync()) }
  onProjection(listener: (projection: ArgusAppProjection) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onStatus(listener: (status: UnitStatus) => void) { this.statusListeners.add(listener); return () => { this.statusListeners.delete(listener) } }
  private emit(projection: ArgusAppProjection) { for (const listener of this.listeners) listener(projection) }
  private emitStatus() { const status = this.status(); for (const listener of this.statusListeners) listener(status) }
  /** Applies what a new projection means for this device (new unit keys, a changed role, removal), then shows it. */
  private async settle(projection: ArgusAppProjection) { const settled = await this.reconcile(projection); this.emit(settled); return settled }
  status(): UnitStatus {
    const { record } = this.device
    return { ...this.transport.status(), unitId: record.unit!.unitId, unitName: record.unit!.unitName, role: record.role as ArgusRole, displayName: record.displayName, walletAddress: record.walletAddress, unreadable: this.provider.unreadable.size, revoked: this.revoked, holdsAuthority: Boolean(this.device.authoritySigner), currentEpoch: record.unit!.currentEpoch }
  }
  balance(): Promise<WalletBalance> { return this.wallet.refresh() }

  // ---------- keeping this device in step with the unit ----------
  private reconcile(projection: ArgusAppProjection): Promise<ArgusAppProjection> {
    // One at a time: a reconcile can itself sync (after installing a key), which must not start another.
    const run = (this.reconciling ?? Promise.resolve(projection)).then(() => this.reconcileOnce(projection))
    this.reconciling = run.finally(() => { if (this.reconciling === guarded) this.reconciling = undefined })
    const guarded = this.reconciling
    return run
  }
  private async reconcileOnce(initial: ArgusAppProjection): Promise<ArgusAppProjection> {
    let projection = initial
    for (let round = 0; round < 4; round++) {
      // A credential replaced elsewhere is adopted before a Master introduces itself, so it never re-introduces the old one.
      await this.adoptOwnCredential(projection)
      projection = await this.introduceMaster(projection)
      projection = await this.reissueOutdatedCredentials(projection)
      await this.adoptOwnCredential(projection)
      const installed = await this.installGrantedKeys(projection)
      this.adoptCurrentEpoch(projection)
      if (!installed) break
      // Records sealed under a key this device just received become readable: fold them in.
      projection = await this.controller.sync().catch(() => this.controller.project())
    }
    this.emitStatus()
    return projection
  }
  /**
   * A Master introduces itself once, so every device can show its name and hand it future unit keys. It waits for the first
   * chain scan, so a device opened with an empty local copy does not republish an introduction the chain already has.
   */
  private async introduceMaster(projection: ArgusAppProjection) {
    const { record } = this.device
    if (record.role !== 'MASTER' || this.revoked || !this.transport.status().lastScanAt) return projection
    if (projection.members.some(member => member.publicIdentity === record.signingIdentity && member.credentialId === record.credential?.credentialId)) return projection
    return this.controller.recordAdmission({ credential: record.credential!, displayName: record.displayName, walletAddress: record.walletAddress, ecdhPublicKey: record.ecdhPublicKey })
  }
  /**
   * mw-kmgi38.11: a credential made before its role gained a permission lacks it (cadets.admit and notices.send on a unit made before
   * the cadet epic). A device holding the unit authority re-issues every active member's direct credential that falls short of its
   * role's current list, its own included, as a role change to the same role; each member's device then adopts its new credential.
   * Two such devices doing it at once make the same replacement, and the second changes nothing (see reissueCredential).
   */
  private async reissueOutdatedCredentials(initial: ArgusAppProjection) {
    const signer = this.device.authoritySigner, now = new Date().toISOString()
    if (!signer || this.device.record.role !== 'MASTER' || this.revoked) return initial
    const outdated = (projection: ArgusAppProjection) => projection.members.flatMap(member => {
      if (member.status !== 'ACTIVE' || (member.expiresAt && member.expiresAt <= now)) return []
      const credential = projection.events.find(stored => stored.event.eventId === member.credentialEventId)?.event.payload.credential as AuthorityCredential | undefined
      return credential && credential.credentialId === member.credentialId && this.authorization.hasCredential(credential.credentialId) && lacksRolePermissions(credential) ? [credential] : []
    })
    if (!outdated(initial).length) return initial
    // Read afresh: a reconcile queued behind another holds a projection from before the other's re-issues.
    let projection = await this.controller.project(), reissued = 0
    for (const credential of outdated(projection)) {
      // A refused re-issue must not keep the unit from opening: it is tried again at the next reconcile.
      try { projection = await this.controller.changeRole(await reissueCredential(signer, credential)); reissued++ } catch { /* tried again later */ }
    }
    if (reissued) void this.transport.poke()
    return projection
  }
  private async adoptOwnCredential(projection: ArgusAppProjection) {
    const { record } = this.device, me = projection.members.find(member => member.publicIdentity === record.signingIdentity)
    if (!me) return
    this.revoked = me.status === 'REVOKED'
    if (me.status !== 'ACTIVE' || me.credentialId === record.credential?.credentialId || !me.credentialEventId) return
    const credential = projection.events.find(stored => stored.event.eventId === me.credentialEventId)?.event.payload.credential as AuthorityCredential | undefined
    if (!credential || credential.credentialId !== me.credentialId || credential.subjectPublicIdentity !== record.signingIdentity || !this.authorization.hasCredential(credential.credentialId)) return
    await updateDeviceCredential(this.device, credential, this.storage)
  }
  /** Opens this device's copy of every unit key generation it has been given (directly, through the unit recovery key, or to the ticket it joined by). */
  private async installGrantedKeys(projection: ArgusAppProjection) {
    let installed = 0
    const recoveryId = this.device.record.recoveryPublicKey && this.device.recoveryEcdhPrivateKey ? recoveryGranteeIdentity(await recoveryFingerprint(this.device.record.recoveryPublicKey)) : undefined
    const { ticketEcdh } = this.device, ticketId = ticketEcdh ? ticketGranteeIdentity(ticketEcdh.ticketId) : undefined
    for (const epoch of projection.keyEpochs) {
      if (this.device.unitKeys.has(epoch.epochId)) continue
      const event = projection.events.find(stored => stored.event.eventId === epoch.eventId)?.event
      const payload = event?.payload as { grants?: unknown[]; grantorEcdhPublicKey?: string } | undefined
      if (!event || !payload?.grantorEcdhPublicKey || !Array.isArray(payload.grants)) continue
      const grants = payload.grants.map(grant => parseKeyGrantRecord(grant))
      const mine = grants.find(grant => grant.granteePublicIdentity === this.device.record.signingIdentity), viaRecovery = !mine && recoveryId ? grants.find(grant => grant.granteePublicIdentity === recoveryId) : undefined
      const viaTicket = !mine && !viaRecovery && ticketId ? grants.find(grant => grant.granteePublicIdentity === ticketId) : undefined
      const grant = mine ?? viaRecovery ?? viaTicket
      if (!grant || grant.grantorPublicIdentity !== event.actorPublicIdentity || !(await this.device.identity.verify(canonicalize(unsignedKeyGrantFields(grant)), grant.signature, grant.grantorPublicIdentity))) continue
      try {
        const key = await unwrapEpochKeyFromGrant(grant, { granteeEcdhPrivateKey: mine ? this.device.ecdhPrivateKey : viaRecovery ? this.device.recoveryEcdhPrivateKey! : ticketEcdh!.privateKey, grantorEcdhPublicKey: await importEcdhPublic(payload.grantorEcdhPublicKey), extractable: true })
        await installUnitKey(this.device, epoch.epochId, key, { makeCurrent: false }, this.storage)
        installed++
      } catch { /* wrapped for a different key pair: not this device's to open */ }
    }
    return installed
  }
  /** Every device writes with the newest key generation it holds; concurrent rotations resolve to the same one everywhere (canonical order). */
  private adoptCurrentEpoch(projection: ArgusAppProjection) {
    const newest = [...projection.keyEpochs].reverse().find(epoch => this.device.unitKeys.has(epoch.epochId))
    if (newest) setCurrentEpoch(this.device, newest.epochId, this.storage)
  }

  // ---------- Master actions ----------
  private requireMaster() { if (this.device.record.role !== 'MASTER' || this.revoked) throw new Error('Only a unit Master can do this.') }
  private signerFor(targetRole: ArgusRole, newRole?: ArgusRole) {
    // Masters are made and removed only with the unit authority key; everyone else by any Master's own key.
    if (targetRole === 'MASTER' || newRole === 'MASTER') { if (!this.device.authoritySigner) throw new Error(newRole === 'MASTER' ? 'Only the unit authority (the original or a recovered Master device) can make someone a Master.' : 'Only the unit authority (the original or a recovered Master device) can remove a Master.'); return this.device.authoritySigner }
    return this.device.authoritySigner ?? this.device.identity
  }
  private async activeMember(publicIdentity: string) {
    const projection = await this.controller.project(), member = projection.members.find(candidate => candidate.publicIdentity === publicIdentity && candidate.status === 'ACTIVE')
    if (!member) throw new Error('That person is not an active member.')
    if (publicIdentity === this.device.record.signingIdentity) throw new Error('You cannot change your own access.')
    return member
  }
  /**
   * Master only: removes a person from now on. Their past work stays in history, and the unit key is
   * replaced so they cannot read anything written after this moment.
   */
  async revoke(publicIdentity: string): Promise<ArgusAppProjection & { rotation: KeyRotationResult }> {
    this.requireMaster()
    const member = await this.activeMember(publicIdentity)
    const revocation = await issueRevocation(this.signerFor(member.role), { credentialId: member.credentialId, subjectPublicIdentity: member.publicIdentity } as AuthorityCredential, new Date().toISOString())
    await this.controller.recordRevocation(revocation)
    const rotation = await this.rotateUnitKey('REVOCATION')
    return { ...(await this.settle(await this.controller.project())), rotation }
  }
  /** Master only: gives a person a different role (a new credential replaces the old one in one signed event). */
  async changeRole(publicIdentity: string, role: ArgusRole) {
    this.requireMaster()
    const member = await this.activeMember(publicIdentity)
    if (member.role === role) throw new Error(`${member.displayName} is already ${role}.`)
    const signer = this.signerFor(member.role, role), now = new Date().toISOString()
    const credential = await issueCredential(signer, { subjectPublicIdentity: member.publicIdentity, role, permissions: [...ROLE_PERMISSIONS[role]], issuedAt: now, ...(member.expiresAt && member.expiresAt > now ? { expiresAt: member.expiresAt } : {}) })
    const revocation = await issueRevocation(signer, { credentialId: member.credentialId, subjectPublicIdentity: member.publicIdentity } as AuthorityCredential, now)
    const projection = await this.controller.changeRole({ credential, revocation })
    void this.transport.poke()
    return this.settle(projection)
  }
  /**
   * Master only: creates a new unit key and hands one wrapped copy to every active member (and to
   * the unit recovery key, and to every ticket still open, for whoever redeems it). The announcement
   * is encrypted under the old key; members who were removed can read the announcement but cannot
   * open any copy, nor anything written afterwards.
   */
  async rotateUnitKey(reason: 'REVOCATION' | 'MANUAL' = 'MANUAL'): Promise<KeyRotationResult> {
    this.requireMaster()
    const { record } = this.device, projection = await this.controller.project(), unit = record.unit!
    const { epochId, key, raw } = await newUnitKey(this.device)
    const recipients = projection.members.filter(member => member.status === 'ACTIVE'), missing = recipients.filter(member => !member.ecdhPublicKey && member.publicIdentity !== record.signingIdentity).map(member => member.displayName)
    const wrap = async (grantee: string, publicKey: string) => wrapEpochKeyForGrant({ epochKey: key, organizationId: unit.unitId, epochId, granteePublicIdentity: grantee, grantorPublicIdentity: record.signingIdentity, grantorEcdhPrivateKey: this.device.ecdhPrivateKey, granteeEcdhPublicKey: await importEcdhPublic(publicKey), grantorSigner: this.device.identity })
    const grants: KeyGrantRecord[] = [await wrap(record.signingIdentity, record.ecdhPublicKey)]
    for (const member of recipients) if (member.ecdhPublicKey && member.publicIdentity !== record.signingIdentity) grants.push(await wrap(member.publicIdentity, member.ecdhPublicKey))
    if (projection.recoveryKey) grants.push(await wrap(recoveryGranteeIdentity(projection.recoveryKey.fingerprint), projection.recoveryKey.publicKey))
    const people = grants.length - (projection.recoveryKey ? 1 : 0)
    // A ticket out now carries only the keys made before it: one rotated now reaches its person through the ticket's own ECDH key (ADR 012).
    for (const ticket of listTickets(projection.tickets).filter(entry => entry.status === 'open')) grants.push(await wrap(ticketGranteeIdentity(ticket.ticketId), ticket.ticketEcdhPublicKey))
    await this.controller.rotateUnitKey({ epochId, previousEpoch: unit.currentEpoch, reason, grants, grantorEcdhPublicKey: record.ecdhPublicKey })
    await installUnitKey(this.device, epochId, raw, { makeCurrent: true }, this.storage)
    void this.transport.poke()
    this.emitStatus()
    return { epochId, recipients: people, missing }
  }
  /**
   * Original (or recovered) Master only: an encrypted recovery file for getting the unit authority
   * back on a new device. Registers the recovery key with the unit so future key generations stay
   * openable from the file.
   */
  async exportRecovery(recoveryPassphrase: string) {
    this.requireMaster()
    const result = await exportRecoveryFile(this.device, recoveryPassphrase, this.storage)
    const projection = await this.controller.project()
    if (projection.recoveryKey?.fingerprint !== result.fingerprint) {
      await this.controller.registerRecoveryKey({ publicKey: result.publicKey, fingerprint: result.fingerprint })
      // Key generations created before the recovery key existed are already in the file; later ones will include it.
    }
    void this.transport.poke()
    return result.fileText
  }
  // ---------- admission tickets (docs/adr/012-admission-by-invitation-ticket.md) ----------
  /** Who may sign a ticket for this role: the unit authority for a Master ticket, otherwise the authority if this device holds it, else the person's own key. */
  private ticketSigner(role: ArgusRole) {
    if (role === 'MASTER') { if (!this.device.authoritySigner) throw new Error('Only the unit authority (the original or a recovered Master device) can make a Master ticket.'); return this.device.authoritySigner }
    return this.device.authoritySigner ?? this.device.identity
  }
  private requireTicketIssuer(role: ArgusRole) {
    if (this.revoked) throw new Error('Your access to this unit was removed.')
    const violation = ticketRuleViolation(this.device.record.role as ArgusRole, role); if (violation) throw new Error(violation)
  }
  /**
   * Master, or Instructor for the cadet roles only (D4, enforced again by every device that folds the ticket). Makes a one-week,
   * one-use ticket for one named person: funds the ticket's address with the starter satoshis, publishes the encrypted TICKET
   * record there (a signed invitation, the unit's keys, the issuer's credential chain), seals the ticket's code in this device's vault
   * so the issuer can cancel it, and records TICKET_ISSUED in the unit's history. Everything is built and saved on this device
   * before anything is sent, so an unreachable network only delays it. Refused, with nothing left behind, when the wallet cannot pay.
   */
  async issueTicket(displayName: string, role: ArgusRole, options: { satoshis?: number } = {}): Promise<IssuedTicket> {
    const name = displayName.trim(); if (!name || name.length > 60) throw new Error('Enter the person’s name or call sign (1–60 characters).')
    this.requireTicketIssuer(role)
    const signer = this.ticketSigner(role), satoshis = options.satoshis ?? DEFAULT_MEMBER_TOP_UP_SATOSHIS
    if (!Number.isSafeInteger(satoshis) || satoshis < 100) throw new Error('A ticket needs at least 100 starter satoshis.')
    const balance = await this.wallet.refresh().catch(() => this.wallet.balance())
    if (balance.spendable < satoshis + TICKET_FEE_RESERVE_SATOSHIS) throw new InsufficientFundsError(this.wallet.address, balance.spendable, satoshis + TICKET_FEE_RESERVE_SATOSHIS)
    const { record } = this.device, unit = record.unit!, epochKeys = await rawUnitKeys(this.device)
    if (!epochKeys.some(key => key.epochId === unit.currentEpoch)) throw new Error(`This device is missing unit key ${unit.currentEpoch}.`)
    const secret = makeTicketSecret(), code = encodeTicketCode(secret), keys = await deriveTicketKeys(secret), ticketId = newTicketId(), ecdh = await newTicketEcdhKeyPair()
    // Sealed before any money moves: whatever happens next, the funding can be recovered by cancelling.
    await sealTicketSecret(this.device, ticketId, code, this.storage)
    let fundingQueued = false
    try {
      const funding = await this.wallet.prepareTransfer(keys.address, satoshis)
      fundingQueued = true
      if (Transaction.fromHex(funding.hex).outputs[0]?.lockingScript.toHex() !== new P2PKH().lock(keys.address).toHex()) throw new Error('The ticket’s funding output is not where it was expected.')
      const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.parse(issuedAt) + TICKET_LIFETIME_MS).toISOString()
      const unsignedInvitation = { invitationVersion: 1 as const, ticketId, unitId: unit.unitId, displayName: name, role, issuedAt, expiresAt, ticketPublicKey: keys.publicIdentity, funding: { txid: funding.txid, vout: 0, satoshis }, issuedBy: await signer.getPublicIdentity() }
      const invitation: TicketInvitation = { ...unsignedInvitation, signature: await signer.sign(canonicalize(unsignedInvitation)) }
      const authoritySigned = invitation.issuedBy === unit.authorityIdentity
      const ticketPackage: TicketPackage = { kind: 'TICKET', packageVersion: 1, invitation, issuerDisplayName: record.displayName, issuerCredentials: authoritySigned ? [] : [record.credential!, ...(record.issuerCredential ? [record.issuerCredential] : [])], unit: { unitId: unit.unitId, unitName: unit.unitName, authorityIdentity: unit.authorityIdentity }, currentEpoch: unit.currentEpoch, epochKeys, ticketEcdhPrivateKey: ecdh.privateJwk }
      await this.wallet.prepareRecords([{ kind: 'T', payload: await sealTicketRecord(keys.wrappingKey, keys.address, ticketPackage) }], keys.address, [ticketId])
      this.emit(await this.controller.recordTicketIssued({ ticketId, ticketAddress: keys.address, ticketEcdhPublicKey: ecdh.publicKey, displayName: name, role, issuedAt, expiresAt, funding: invitation.funding }))
      void this.transport.poke()
      return { ticketId, code, displayName: name, role, ticketAddress: keys.address, issuedAt, expiresAt, funding: invitation.funding }
    } catch (error) {
      // Nothing was funded yet (the first step failed): forget the code. Once the funding is queued the code stays sealed so it can be cancelled.
      if (!fundingQueued) forgetTicketSecret(this.device, ticketId, this.storage)
      throw error
    }
  }
  /** Every ticket the unit knows of, with status (open, redeemed, cancelled, expired) and days left, open ones first. The clock is only for display. */
  async tickets(now: Date = new Date()) { return listTickets((await this.controller.project()).tickets, now) }
  /**
   * Cancels an open ticket (reason EXPIRED when sweeping one that ran out): spends its funding output with a signed TICKET_CANCELLED
   * record at the ticket address, which sends the starter satoshis back here and makes the network refuse any redemption. Only the
   * device that made the ticket holds the key. The network decides a race with a redemption: the loser is told so in words.
   * With no network the cancellation is saved and the result is PENDING; call again later to finish it (it is never built twice).
   */
  async cancelTicket(ticketId: string, reason: TicketCancellation['reason'] = 'CANCELLED'): Promise<TicketCancelResult> {
    const ticket = (await this.controller.project()).tickets.find(candidate => candidate.ticketId === ticketId)
    if (!ticket) throw new Error('That ticket is not in this unit’s list.')
    if (ticket.issuedBy !== this.device.record.signingIdentity) throw new Error('Only the person who made a ticket can cancel it, on the device that made it.')
    if (ticket.status !== 'OPEN') throw new Error(`This ticket is already ${ticket.status === 'REDEEMED' ? 'used' : 'cancelled'}.`)
    this.requireTicketIssuer(ticket.role)
    const code = await readTicketSecret(this.device, ticketId)
    if (!code) throw new Error('This device no longer holds that ticket’s key, so it cannot cancel it. The ticket runs out by itself after a week.')
    const keys = await deriveTicketKeys(decodeTicketCode(code)), marker = `cancel:${ticketId}`
    let txid = (await this.wallet.pending()).find(tx => tx.correlationIds.includes(marker))?.txid
    if (!txid) {
      const signer = this.ticketSigner(ticket.role), unsigned = { kind: 'TICKET_CANCELLED' as const, cancellationVersion: 1 as const, ticketId, unitId: this.device.record.unit!.unitId, reason, cancelledAt: new Date().toISOString(), issuedBy: await signer.getPublicIdentity() }
      const cancellation: TicketCancellation = { ...unsigned, signature: await signer.sign(canonicalize(unsigned)) }
      txid = (await this.wallet.prepareSpendOfOutpoint({ key: keys.privateKey, outpoint: ticket.funding, records: [{ kind: 'T', payload: await sealTicketRecord(keys.wrappingKey, keys.address, cancellation) }], markerAddress: keys.address, correlationIds: [marker] })).txid
    }
    const flushed = await this.wallet.flush()
    // The transport may have sent it first: not pending any more and still known to the wallet means the network took it.
    if ((await this.wallet.pending()).some(tx => tx.txid === txid)) return { status: 'PENDING', txid }
    if (!(await this.wallet.ownTxHex(txid))) throw new Error(`The ticket could not be cancelled: the network refused it${flushed.rolledBack.find(entry => entry.txid === txid)?.reason ? ` (${flushed.rolledBack.find(entry => entry.txid === txid)!.reason})` : ''}. It has probably already been used.`)
    this.emit(await this.controller.recordTicketCancelled({ ticketId, reason, cancelledAt: new Date().toISOString(), spendTxid: txid }))
    forgetTicketSecret(this.device, ticketId, this.storage)
    void this.transport.poke()
    return { status: 'CANCELLED', txid }
  }

  // ---------- cadet tickets (docs/adr/013-cadet-channels.md, mw-kmgi38.2) ----------
  /** Checks, before anything is written or paid, that this device may admit cadets, the cadet exists and the wallet can pay. */
  private async cadetTicketPreflight(cadetId: string, satoshis: number) {
    if (this.revoked) throw new Error('Your access to this unit was removed.')
    this.authorization.require(this.device.record.signingIdentity, 'cadets.admit')
    const cadet = (await this.controller.technicalState()).cadets.find(candidate => candidate.cadetId === cadetId)
    if (!cadet) throw new Error('Cadet was not found.')
    if (!Number.isSafeInteger(satoshis) || satoshis < 100) throw new Error('A ticket needs at least 100 starter satoshis.')
    const balance = await this.wallet.refresh().catch(() => this.wallet.balance())
    if (balance.spendable < satoshis + TICKET_FEE_RESERVE_SATOSHIS) throw new InsufficientFundsError(this.wallet.address, balance.spendable, satoshis + TICKET_FEE_RESERVE_SATOSHIS)
    return cadet
  }
  /**
   * Master, Instructor or Supply Officer (cadets.admit): a one-week, one-use ticket for one cadet's phone. Makes the cadet's channel and
   * the unit's notices key when there are none yet, funds the ticket's address with the starter satoshis, publishes the encrypted
   * CADET record there (the channel key and address, the notices key and address, and nothing of the unit's keys), seals the code in
   * this device's vault, and records CADET_TICKET_ISSUED in the unit's history. Refused, with nothing left behind, when the wallet cannot pay.
   */
  async issueCadetTicket(cadetId: string, options: { satoshis?: number } = {}): Promise<IssuedCadetTicket> {
    const satoshis = options.satoshis ?? CADET_TICKET_SATOSHIS, cadet = await this.cadetTicketPreflight(cadetId, satoshis)
    if (!(await this.controller.technicalState()).cadetChannels.some(channel => channel.cadetId === cadetId)) await this.controller.createCadetChannel(cadetId)
    if (!(await this.controller.technicalState()).noticesChannel) await this.controller.createNoticesKey()
    const state = await this.controller.technicalState(), channel = state.cadetChannels.find(entry => entry.cadetId === cadetId)!, notices = state.noticesChannel!
    const { record } = this.device, unit = record.unit!, displayName = (cadet.fullName.trim() || cadetLabel(cadet)).slice(0, 60).trim()
    const secret = makeTicketSecret(), code = encodeTicketCode(secret), keys = await deriveTicketKeys(secret), ticketId = newTicketId()
    // Sealed before any money moves, as for a staff ticket: the funding can be recovered by spending it with the code.
    await sealTicketSecret(this.device, ticketId, code, this.storage)
    let fundingQueued = false
    try {
      const funding = await this.wallet.prepareTransfer(keys.address, satoshis)
      fundingQueued = true
      if (Transaction.fromHex(funding.hex).outputs[0]?.lockingScript.toHex() !== new P2PKH().lock(keys.address).toHex()) throw new Error('The ticket’s funding output is not where it was expected.')
      const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.parse(issuedAt) + TICKET_LIFETIME_MS).toISOString(), outpoint = { txid: funding.txid, vout: 0, satoshis }
      const ticketPackage: CadetTicketPackage = { kind: 'CADET', packageVersion: 1, invitation: { invitationVersion: 1, ticketId, unitId: unit.unitId, role: 'CADET', cadetId, displayName, issuedAt, expiresAt, ticketPublicKey: keys.publicIdentity, funding: outpoint, returnAddress: record.walletAddress }, unit: { unitId: unit.unitId, unitName: unit.unitName }, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: notices.key, noticesAddress: notices.address }
      await this.wallet.prepareRecords([{ kind: 'T', payload: await sealTicketRecord(keys.wrappingKey, keys.address, ticketPackage) }], keys.address, [ticketId])
      this.emit(await this.controller.recordCadetTicketIssued({ ticketId, cadetId, ticketAddress: keys.address, channelAddress: channel.channelAddress, issuedAt, expiresAt, funding: outpoint }))
      void this.transport.poke()
      return { ticketId, code, cadetId, displayName, ticketAddress: keys.address, channelAddress: channel.channelAddress, issuedAt, expiresAt, funding: outpoint }
    } catch (error) {
      if (!fundingQueued) forgetTicketSecret(this.device, ticketId, this.storage)
      throw error
    }
  }
  /**
   * Replace phone: a new key and address for the cadet's channel (so the old phone reads nothing new), then a new ticket that grants
   * them. A cadet with no channel yet simply gets a first ticket.
   */
  async reissueCadetTicket(cadetId: string, options: { satoshis?: number } = {}): Promise<IssuedCadetTicket> {
    await this.cadetTicketPreflight(cadetId, options.satoshis ?? CADET_TICKET_SATOSHIS)
    if ((await this.controller.technicalState()).cadetChannels.some(channel => channel.cadetId === cadetId)) await this.controller.rotateCadetChannel(cadetId, 'Replace phone')
    return this.issueCadetTicket(cadetId, options)
  }
  /**
   * Reads one cadet's current channel from the chain, on demand (the cadet drawer's Phone line): that one address and nothing else.
   * Before a phone redeems the cadet's ticket there is nothing there; after, its CADET_JOINED record. A cadet with no channel has no records.
   */
  async readCadetChannel(cadetId: string): Promise<CadetChannelReading> {
    const channel = (await this.controller.technicalState()).cadetChannels.find(entry => entry.cadetId === cadetId)
    if (!channel) return { cadetId, records: [] }
    const records = await readChannelRecords(this.api, channel.channelAddress, channel.channelKey)
    let joined: CadetJoinedRecord | undefined
    for (const entry of records) if (entry.kind === 'joined') { try { joined = parseCadetJoinedRecord(entry.plaintext) } catch { /* damaged: not a phone */ } }
    return { cadetId, channelAddress: channel.channelAddress, records, ...(joined ? { joined } : {}) }
  }

  /**
   * Master, Instructor or Supply Officer (notices.send): a notice to every cadet or to one cadet, ADR 013 / mw-kmgi38.5. Records
   * NOTICE_SENT in the unit log (which cadets never read), then publishes the sealed text from this device's wallet through the
   * publisher's queue: one record in the channel of each cadet it is for (a notice to all is one record per cadet who has a channel
   * when it goes out, in transactions of up to 25 records; a note to one cadet is one record in one transaction). A cadet with no
   * channel is refused with nothing recorded. When the network does not take the records now, the notice stays queued and goes out
   * later to the channels it has not reached (`published` false). The unit's shared notices address is no longer written.
   */
  async sendNotice(audience: NoticeAudience, text: string): Promise<{ noticeId: string; published: boolean }> {
    if (this.revoked) throw new Error('Your access to this unit was removed.')
    this.authorization.require(this.device.record.signingIdentity, 'notices.send')
    const known = new Set((await this.controller.technicalState()).notices.map(notice => notice.noticeId))
    const projection = await this.controller.sendNotice(audience, text), noticeId = projection.notices.find(notice => !known.has(notice.noticeId))!.noticeId
    this.emit(projection)
    this.cadetPublisher.enqueueNotice(noticeId)
    await this.cadetPublisher.run().catch(() => undefined)
    const published = !this.cadetPublisher.queuedNotices().includes(noticeId)
    void this.transport.poke()
    return { noticeId, published }
  }

  /**
   * Master only: seals every cadet's current record to their channel (every cadet who has one), up to 25 records to a transaction
   * (250 cadets: 10 transactions), one transaction at a time, from this device's wallet. Resumable: what did not go out stays queued, and the next call (or the publisher's own retry) carries on. Reports
   * how far it is after each transaction. A cadet whose record is over the cap, or whose record the network refused, counts as failed.
   */
  async publishAllCadetRecords(onProgress?: (progress: CadetPublishProgress) => void): Promise<CadetPublishProgress> {
    this.requireMaster()
    this.cadetPublisher.enqueue((await this.controller.technicalState()).cadetChannels.map(channel => channel.cadetId))
    return this.cadetPublisher.run(onProgress)
  }

  /** Sends testnet satoshis from this device's wallet (e.g. the Master topping up a member). */
  async sendSatoshis(address: string, satoshis: number) {
    const prepared = await this.wallet.prepareTransfer(address, satoshis)
    const flushed = await this.wallet.flush()
    const rolledBack = flushed.rolledBack.find(entry => entry.txid === prepared.txid)
    if (rolledBack) throw new Error(`The top-up was refused by the network: ${rolledBack.reason}`)
    return prepared.txid
  }
}
