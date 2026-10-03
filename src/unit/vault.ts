import { PrivateKey } from '@bsv/sdk'
import { ROLE_PERMISSIONS, issueCredential, type TicketCredential } from '../auth/authorization'
import { DEFAULT_WALLET_DB_NAME } from '../chain/walletStore'
import type { ArgusRole, AuthorityCredential } from '../distributed/types'
import { WebCryptoIdentityProvider, type ArgusIdentityProvider } from '../identity/identity'
import type { TicketPackage } from '../private-sync/types'
import { IndexedDbLedgerStore } from './ledgerStore'

/**
 * Device vault (format 2). One passphrase unlocks everything a device holds:
 *   signing   — the person's own ECDSA P-256 key; every event they create is signed with it
 *   ecdh      — ECDH P-256 key the Master uses to hand this device the unit data key
 *   wallet    — this device's own BSV TESTNET key that pays the few satoshis each record costs
 *   authority — MASTER only: the unit authority key that signs member credentials
 *   unitKey:* — the AES-256 unit data key(s) that encrypt everything the unit writes to chain
 *   ticket:*  — an admission ticket's code, kept by its issuer until the ticket is spent
 *   redeeming:* — a joining device's ticket code and redemption txid, until the network accepts or refuses the redemption
 *   ticketEcdh:* — a device admitted by ticket: the ticket's own ECDH key, which opens unit keys granted to the ticket while it was open
 * Each secret is AES-256-GCM ciphertext under a key derived from the passphrase
 * (PBKDF2-SHA-256, 600k iterations) with the secret's name as additional data. Nothing here is
 * usable without the passphrase, and nothing secret ever leaves the device: people join by a ticket
 * (docs/adr/012), never by copying a key.
 */
export const DEVICE_VAULT_STORAGE_KEY = 'argus.device.v2'
const KDF_ITERATIONS = 600_000
export type DeviceRole = ArgusRole | 'PENDING'
export type UnitInfo = { unitId: string; unitName: string; authorityIdentity: string; currentEpoch: string; epochs: string[]; joinedAt: string }
export type AdmissionRecord = { credential: AuthorityCredential; displayName: string; walletAddress?: string; admittedAt: string }
type SealedSecret = { nonce: string; ct: string }
export type DeviceVaultRecord = {
  version: 2
  kdf: { name: 'PBKDF2-SHA-256'; iterations: number; salt: string }
  secrets: Record<string, SealedSecret>
  signingIdentity: string
  ecdhPublicKey: string
  walletAddress: string
  displayName: string
  role: DeviceRole
  unit?: UnitInfo
  credential?: AuthorityCredential
  /** MASTER only: the Master's own credential chain other devices need to trust key grants it signs. */
  admissions?: AdmissionRecord[]
  /** When a delegated Master admitted this device: that Master's authority-signed credential, so a fresh start can verify this device's own credential before anything syncs. */
  issuerCredential?: AuthorityCredential
  /** Public half of the unit recovery key, when this device holds its private half (the original Master, or a device restored from a recovery file). */
  recoveryPublicKey?: string
  createdAt: string
}
export type UnlockedDevice = {
  record: DeviceVaultRecord
  identity: ArgusIdentityProvider
  authoritySigner?: ArgusIdentityProvider
  ecdhPrivateKey: CryptoKey
  walletWif: string
  unitKeys: Map<string, CryptoKey>
  /** Private half of the unit recovery key: lets a restored Master open every later key generation. */
  recoveryEcdhPrivateKey?: CryptoKey
  /** A device admitted by ticket: the ticket's own ECDH key, for unit keys granted to the ticket before it was redeemed (ADR 012). */
  ticketEcdh?: { ticketId: string; privateKey: CryptoKey }
  /** Kept only in memory while unlocked so an admission can be stored without re-entering the passphrase. */
  vaultKey: CryptoKey
}
/** Everything a unit needs to get its authority back after the Master device is lost. Only ever stored encrypted under a recovery passphrase. */
type RecoveryPayload = { format: 1; unit: Pick<UnitInfo, 'unitId' | 'unitName' | 'authorityIdentity'>; authorityJwk: string; recoveryEcdhJwk: string; recoveryPublicKey: string; unitKeys: Record<string, string>; currentEpoch: string; createdAt: string }
export const RECOVERY_FILE_PREFIX = 'ARGUS-RECOVERY-1:'
type Storage2 = Pick<Storage, 'getItem' | 'setItem'>

const encoder = new TextEncoder(), decoder = new TextDecoder()
const b64url = (bytes: Uint8Array) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
const fromB64url = (value: string) => { const normalized = value.replaceAll('-', '+').replaceAll('_', '/'); return Uint8Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)) }
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer
const randomHex = (bytes: number) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')

export function validatePassphrase(passphrase: string) {
  if (passphrase.length < 12 || !/[a-z]/i.test(passphrase) || !/\d/.test(passphrase)) throw new Error('Use at least 12 characters including a letter and a number.')
}
export function validateDisplayName(name: string) {
  const value = name.trim(); if (!value || value.length > 60) throw new Error('Enter your name or call sign (1–60 characters).'); return value
}
async function deriveVaultKey(passphrase: string, salt: Uint8Array) {
  const material = await crypto.subtle.importKey('raw', buffer(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: buffer(salt), iterations: KDF_ITERATIONS }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
async function seal(key: CryptoKey, name: string, value: string): Promise<SealedSecret> {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: buffer(encoder.encode(name)) }, key, buffer(encoder.encode(value)))
  return { nonce: b64url(nonce), ct: b64url(new Uint8Array(ct)) }
}
async function unseal(key: CryptoKey, name: string, sealed: SealedSecret) {
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buffer(fromB64url(sealed.nonce)), additionalData: buffer(encoder.encode(name)) }, key, buffer(fromB64url(sealed.ct)))
  return decoder.decode(clear)
}
async function newSigningKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  return { identity: `p256:${b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))}`, jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) }
}
async function importSigner(jwk: string, identity: string) {
  const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const publicKey = await crypto.subtle.importKey('spki', buffer(fromB64url(identity.slice(5))), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  return WebCryptoIdentityProvider.fromKeyPair({ privateKey, publicKey }, identity)
}
async function newEcdhKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))), jwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) }
}
const importEcdhPrivate = (jwk: string) => crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
/** The Master keeps its unit key extractable only so it can wrap it for new members; members import it non-extractable. */
const importUnitKey = (raw: string, extractable: boolean) => crypto.subtle.importKey('raw', buffer(fromB64url(raw)), { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt'])
const newWalletWif = () => { const key = PrivateKey.fromRandom(); return { wif: key.toWif([0xef]), address: key.toAddress('testnet') } }
const walletFromWif = (wif: string) => { const key = PrivateKey.fromWif(wif); if (key.toWif([0xef]) !== wif) throw new Error('Only BSV testnet wallet keys are accepted.'); return { wif, address: key.toAddress('testnet') } }
export const epochSecretName = (epochId: string) => `unitKey:${epochId}`

export function loadDeviceVault(storage: Pick<Storage, 'getItem'> = localStorage): DeviceVaultRecord | undefined {
  const raw = storage.getItem(DEVICE_VAULT_STORAGE_KEY); if (!raw) return undefined
  const value = JSON.parse(raw) as Partial<DeviceVaultRecord>
  if (value.version !== 2 || !value.kdf || !value.secrets || !value.signingIdentity || !value.role) throw new Error('The stored A.R.G.U.S. device record is unreadable.')
  return value as DeviceVaultRecord
}
function saveDeviceVault(record: DeviceVaultRecord, storage: Storage2) { storage.setItem(DEVICE_VAULT_STORAGE_KEY, JSON.stringify(record)); return record }

/** walletWif is only for scripted runs (e.g. the live testnet check reusing a faucet-funded key); the app always generates a fresh one. */
async function createDevice(input: { passphrase: string; displayName: string; master?: { unitName: string }; walletWif?: string }, storage: Storage2) {
  validatePassphrase(input.passphrase); const displayName = validateDisplayName(input.displayName)
  if (storage.getItem(DEVICE_VAULT_STORAGE_KEY) || storage.getItem(CADET_VAULT_STORAGE_KEY)) throw new Error('This device is already set up. Unlock it instead.')
  const salt = crypto.getRandomValues(new Uint8Array(16)), vaultKey = await deriveVaultKey(input.passphrase, salt), createdAt = new Date().toISOString()
  const signing = await newSigningKey(), ecdh = await newEcdhKey(), wallet = input.walletWif ? walletFromWif(input.walletWif) : newWalletWif()
  const secrets: Record<string, SealedSecret> = { signing: await seal(vaultKey, 'signing', signing.jwk), ecdh: await seal(vaultKey, 'ecdh', ecdh.jwk), wallet: await seal(vaultKey, 'wallet', wallet.wif) }
  const record: DeviceVaultRecord = { version: 2, kdf: { name: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS, salt: b64url(salt) }, secrets, signingIdentity: signing.identity, ecdhPublicKey: ecdh.publicKey, walletAddress: wallet.address, displayName, role: 'PENDING', createdAt }
  if (input.master) {
    const unitName = input.master.unitName.trim(); if (!unitName || unitName.length > 80) throw new Error('Enter the unit name (1–80 characters).')
    const authority = await newSigningKey(), epoch = 'e1', unitKey = b64url(crypto.getRandomValues(new Uint8Array(32)))
    secrets.authority = await seal(vaultKey, 'authority', authority.jwk)
    secrets[epochSecretName(epoch)] = await seal(vaultKey, epochSecretName(epoch), unitKey)
    const authoritySigner = await importSigner(authority.jwk, authority.identity)
    record.credential = await issueCredential(authoritySigner, { subjectPublicIdentity: signing.identity, role: 'MASTER', permissions: [...ROLE_PERMISSIONS.MASTER], issuedAt: createdAt })
    record.role = 'MASTER'
    record.unit = { unitId: `u-${randomHex(10)}`, unitName, authorityIdentity: authority.identity, currentEpoch: epoch, epochs: [epoch], joinedAt: createdAt }
    record.admissions = []
  }
  saveDeviceVault(record, storage)
  return unlockDevice(record, input.passphrase)
}
/** First device of a unit: creates the unit, its authority key, the first unit data key, and self-issues a MASTER credential. */
export const createMasterDevice = (input: { passphrase: string; displayName: string; unitName: string; walletWif?: string }, storage: Storage2 = localStorage) => createDevice({ passphrase: input.passphrase, displayName: input.displayName, master: { unitName: input.unitName }, ...(input.walletWif ? { walletWif: input.walletWif } : {}) }, storage)
/** Any other device: creates its own keys, then redeems an admission ticket (ticketRedemption.ts) to join the unit. */
export const createJoiningDevice = (input: { passphrase: string; displayName: string; walletWif?: string }, storage: Storage2 = localStorage) => createDevice(input, storage)

const failures = { count: 0, blockedUntil: 0 }
export async function unlockDevice(record: DeviceVaultRecord, passphrase: string): Promise<UnlockedDevice> {
  if (Date.now() < failures.blockedUntil) throw new Error('Too many wrong passphrases. Wait one minute and try again.')
  if (record.version !== 2 || record.kdf.name !== 'PBKDF2-SHA-256' || record.kdf.iterations !== KDF_ITERATIONS) throw new Error('Unsupported device record format.')
  let vaultKey: CryptoKey, signingJwk: string
  try { vaultKey = await deriveVaultKey(passphrase, fromB64url(record.kdf.salt)); signingJwk = await unseal(vaultKey, 'signing', record.secrets.signing) }
  catch (error) { failures.count++; if (failures.count >= 5) { failures.blockedUntil = Date.now() + 60_000; failures.count = 0 } throw new Error('That passphrase is not correct for this device.', { cause: error }) }
  failures.count = 0
  const identity = await importSigner(signingJwk, record.signingIdentity)
  const ecdhPrivateKey = await importEcdhPrivate(await unseal(vaultKey, 'ecdh', record.secrets.ecdh))
  const walletWif = await unseal(vaultKey, 'wallet', record.secrets.wallet)
  const authoritySigner = record.secrets.authority && record.unit ? await importSigner(await unseal(vaultKey, 'authority', record.secrets.authority), record.unit.authorityIdentity) : undefined
  const unitKeys = new Map<string, CryptoKey>()
  for (const epoch of record.unit?.epochs ?? []) { const sealed = record.secrets[epochSecretName(epoch)]; if (sealed) unitKeys.set(epoch, await importUnitKey(await unseal(vaultKey, epochSecretName(epoch), sealed), record.role === 'MASTER')) }
  const recoveryEcdhPrivateKey = record.secrets.recoveryEcdh ? await importEcdhPrivate(await unseal(vaultKey, 'recoveryEcdh', record.secrets.recoveryEcdh)) : undefined
  const ticketEcdhName = Object.keys(record.secrets).find(name => name.startsWith(TICKET_ECDH_PREFIX))
  const ticketEcdh = ticketEcdhName ? { ticketId: ticketEcdhName.slice(TICKET_ECDH_PREFIX.length), privateKey: await importEcdhPrivate(await unseal(vaultKey, ticketEcdhName, record.secrets[ticketEcdhName])) } : undefined
  return { record, identity, ...(authoritySigner ? { authoritySigner } : {}), ecdhPrivateKey, walletWif, unitKeys, ...(recoveryEcdhPrivateKey ? { recoveryEcdhPrivateKey } : {}), ...(ticketEcdh ? { ticketEcdh } : {}), vaultKey }
}

/** Next unit key generation: e<n+1>-<random>, so two Masters rotating at the same moment never collide. The key is extractable only so it can be wrapped for members. */
export async function newUnitKey(device: UnlockedDevice) {
  const highest = Math.max(0, ...(device.record.unit?.epochs ?? []).map(epoch => Number(/^e(\d+)/.exec(epoch)?.[1] ?? 0)))
  const epochId = `e${highest + 1}-${randomHex(4)}`, raw = b64url(crypto.getRandomValues(new Uint8Array(32)))
  return { epochId, raw, key: await importUnitKey(raw, true) }
}
/** Stores a unit key generation sealed under this device's passphrase key and makes it usable now. Masters keep keys extractable to hand them on. */
export async function installUnitKey(device: UnlockedDevice, epochId: string, key: CryptoKey | string, options: { makeCurrent: boolean }, storage: Storage2) {
  const unit = device.record.unit; if (!unit) throw new Error('This device has not joined a unit.')
  const raw = typeof key === 'string' ? key : b64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
  const record: DeviceVaultRecord = { ...device.record, secrets: { ...device.record.secrets, [epochSecretName(epochId)]: await seal(device.vaultKey, epochSecretName(epochId), raw) }, unit: { ...unit, epochs: [...new Set([...unit.epochs, epochId])], currentEpoch: options.makeCurrent ? epochId : unit.currentEpoch } }
  device.unitKeys.set(epochId, await importUnitKey(raw, record.role === 'MASTER'))
  device.record = saveDeviceVault(record, storage)
}
export function setCurrentEpoch(device: UnlockedDevice, epochId: string, storage: Storage2) {
  const unit = device.record.unit; if (!unit || unit.currentEpoch === epochId || !device.unitKeys.has(epochId)) return
  device.record = saveDeviceVault({ ...device.record, unit: { ...unit, currentEpoch: epochId } }, storage)
}
/** A Master changed this device's role (or re-issued its credential). Promotion to Master makes the unit keys re-wrappable. */
export async function updateDeviceCredential(device: UnlockedDevice, credential: AuthorityCredential, storage: Storage2) {
  if (credential.subjectPublicIdentity !== device.record.signingIdentity) throw new Error('That credential belongs to someone else.')
  const record: DeviceVaultRecord = { ...device.record, role: credential.role, credential }
  if (credential.issuedBy === record.unit?.authorityIdentity) delete record.issuerCredential
  device.record = saveDeviceVault(record, storage)
  for (const epoch of record.unit?.epochs ?? []) { const sealed = record.secrets[epochSecretName(epoch)]; if (sealed) device.unitKeys.set(epoch, await importUnitKey(await unseal(device.vaultKey, epochSecretName(epoch), sealed), credential.role === 'MASTER')) }
}

/**
 * Every unit key generation this device holds, raw (32 bytes, base64url), read back from the sealed vault secrets. A ticket carries
 * them for the new member (ADR 012). Read from the secrets and not from the CryptoKeys because an Instructor's copies are
 * imported non-extractable; the vault key is in memory while the device is unlocked.
 */
export async function rawUnitKeys(device: UnlockedDevice): Promise<{ epochId: string; key: string }[]> {
  const unit = device.record.unit; if (!unit) throw new Error('This device has not joined a unit.')
  const keys: { epochId: string; key: string }[] = []
  for (const epochId of unit.epochs) {
    const sealed = device.record.secrets[epochSecretName(epochId)]; if (!sealed) throw new Error(`This device is missing unit key ${epochId}.`)
    keys.push({ epochId, key: await unseal(device.vaultKey, epochSecretName(epochId), sealed) })
  }
  return keys
}

/**
 * The issuer's device keeps each open ticket's code sealed under its passphrase key as `ticket:<ticketId>` (ADR 012): the ticket
 * key is derived from it, and only this device can cancel the ticket. It is dropped once the ticket's funding output is spent.
 */
export const ticketSecretName = (ticketId: string) => `ticket:${ticketId}`
export async function sealTicketSecret(device: UnlockedDevice, ticketId: string, code: string, storage: Storage2) {
  const name = ticketSecretName(ticketId)
  device.record = saveDeviceVault({ ...device.record, secrets: { ...device.record.secrets, [name]: await seal(device.vaultKey, name, code) } }, storage)
}
export async function readTicketSecret(device: UnlockedDevice, ticketId: string): Promise<string | undefined> {
  const sealed = device.record.secrets[ticketSecretName(ticketId)]
  return sealed ? unseal(device.vaultKey, ticketSecretName(ticketId), sealed) : undefined
}
export function forgetTicketSecret(device: UnlockedDevice, ticketId: string, storage: Storage2) {
  const secrets = { ...device.record.secrets }; delete secrets[ticketSecretName(ticketId)]
  device.record = saveDeviceVault({ ...device.record, secrets }, storage)
}
/**
 * A joining device part-way through redeeming a ticket keeps the code and its redemption's txid sealed as `redeeming:<ticketId>` until
 * the network decides, so it resumes with the same transaction after a restart (never a second, conflicting one).
 */
const REDEEMING_PREFIX = 'redeeming:'
export type RedemptionInProgress = { ticketId: string; code: string; txid: string }
export async function sealRedemption(device: UnlockedDevice, redemption: RedemptionInProgress, storage: Storage2) {
  const name = `${REDEEMING_PREFIX}${redemption.ticketId}`
  device.record = saveDeviceVault({ ...device.record, secrets: { ...device.record.secrets, [name]: await seal(device.vaultKey, name, JSON.stringify({ code: redemption.code, txid: redemption.txid })) } }, storage)
}
export async function readRedemption(device: UnlockedDevice): Promise<RedemptionInProgress | undefined> {
  const name = Object.keys(device.record.secrets).find(candidate => candidate.startsWith(REDEEMING_PREFIX)); if (!name) return undefined
  const { code, txid } = JSON.parse(await unseal(device.vaultKey, name, device.record.secrets[name])) as { code: string; txid: string }
  return { ticketId: name.slice(REDEEMING_PREFIX.length), code, txid }
}
const withoutRedemption = (secrets: Record<string, SealedSecret>) => Object.fromEntries(Object.entries(secrets).filter(([name]) => !name.startsWith(REDEEMING_PREFIX)))
export function forgetRedemption(device: UnlockedDevice, storage: Storage2) { device.record = saveDeviceVault({ ...device.record, secrets: withoutRedemption(device.record.secrets) }, storage) }

const TICKET_ECDH_PREFIX = 'ticketEcdh:'
/** Who a rotation grants to while a ticket is open: the ticket itself, through the ECDH key in its TICKET record (ADR 012). */
export const ticketGranteeIdentity = (ticketId: string) => `ticket:${ticketId}`
/**
 * The network accepted this device's redemption of a ticket: it becomes the named person with the ticket's role. Stores the unit keys
 * the ticket carried and the ticket's ECDH key sealed under the passphrase key, takes the ticket credential as its own, and forgets the
 * redemption in progress. Unit keys are kept extractable only for a Master, as everywhere.
 */
export async function completeTicketRedemption(device: UnlockedDevice, input: { ticket: TicketPackage; credential: TicketCredential }, storage: Storage2): Promise<UnlockedDevice> {
  const { record } = device, { ticket, credential } = input, { invitation } = ticket
  if (record.unit) throw new Error('This device already belongs to a unit.')
  if (credential.subjectPublicIdentity !== record.signingIdentity || credential.credentialId !== invitation.ticketId) throw new Error('That redemption belongs to someone else.')
  const secrets = withoutRedemption(record.secrets)
  for (const { epochId, key } of ticket.epochKeys) secrets[epochSecretName(epochId)] = await seal(device.vaultKey, epochSecretName(epochId), key)
  const ecdhName = `${TICKET_ECDH_PREFIX}${invitation.ticketId}`
  secrets[ecdhName] = await seal(device.vaultKey, ecdhName, ticket.ticketEcdhPrivateKey)
  const updated = saveDeviceVault({ ...record, secrets, displayName: invitation.displayName, role: invitation.role, credential, unit: { ...ticket.unit, currentEpoch: ticket.currentEpoch, epochs: ticket.epochKeys.map(entry => entry.epochId), joinedAt: new Date().toISOString() } }, storage)
  const unitKeys = new Map<string, CryptoKey>()
  for (const { epochId, key } of ticket.epochKeys) unitKeys.set(epochId, await importUnitKey(key, invitation.role === 'MASTER'))
  return { ...device, record: updated, unitKeys, ticketEcdh: { ticketId: invitation.ticketId, privateKey: await importEcdhPrivate(ticket.ticketEcdhPrivateKey) } }
}

// ---------- a cadet's phone (docs/adr/013-cadet-channels.md, mw-kmgi38.2) ----------
/**
 * A cadet's phone keeps its own record, apart from the staff device record, under the same passphrase protection (PBKDF2-SHA-256,
 * 600k iterations; AES-256-GCM with the secret's name as additional data):
 *   check     — a fixed text, so a wrong passphrase is refused before anything is stored
 *   redeeming — the ticket code and the signed redemption, until the network accepts or refuses it
 *   cadet     — the CadetDevice, once the network accepted the redemption
 *   notices   — the notices this phone has read, with when each was read (mw-kmgi38.6)
 * It never holds a signing key, a wallet, a unit key, a key grant or a unit credential, and nothing in it is readable without the
 * passphrase: not the cadet's name, not even the cadet's ID.
 */
export const CADET_VAULT_STORAGE_KEY = 'argus.cadet.v1'
/** Everything a cadet's phone holds (ADR 013, "What a cadet phone holds"): its own channel, the unit's notices channel, who it is. */
export type CadetDevice = { cadetId: string; displayName: string; unit: { unitId: string; unitName: string }; channelKey: string; channelAddress: string; noticesKey: string; noticesAddress: string; joinedAt: string }
export type CadetVaultRecord = { version: 1; kind: 'CADET'; kdf: DeviceVaultRecord['kdf']; secrets: Record<string, SealedSecret>; createdAt: string }
/** cadet is absent until the phone's redemption is accepted. */
export type UnlockedCadetDevice = { record: CadetVaultRecord; cadet?: CadetDevice; vaultKey: CryptoKey }
/** A cadet's redemption the network has not decided yet: resent byte for byte after a restart, never rebuilt. */
export type CadetRedemptionInProgress = { ticketId: string; code: string; txid: string; hex: string; joinedAt: string }
const CADET_CHECK = 'argus-cadet-phone'

export function loadCadetVault(storage: Pick<Storage, 'getItem'> = localStorage): CadetVaultRecord | undefined {
  const raw = storage.getItem(CADET_VAULT_STORAGE_KEY); if (!raw) return undefined
  const value = JSON.parse(raw) as Partial<CadetVaultRecord>
  if (value.version !== 1 || value.kind !== 'CADET' || !value.kdf || !value.secrets?.check) throw new Error('The stored A.R.G.U.S. cadet record is unreadable.')
  return value as CadetVaultRecord
}
function saveCadetVault(record: CadetVaultRecord, storage: Storage2) { storage.setItem(CADET_VAULT_STORAGE_KEY, JSON.stringify(record)); return record }
/** A fresh phone's empty cadet record, sealed under its passphrase; it holds a cadet only once a ticket is redeemed. */
export async function createCadetVault(passphrase: string, storage: Storage2 = localStorage): Promise<UnlockedCadetDevice> {
  validatePassphrase(passphrase)
  if (storage.getItem(DEVICE_VAULT_STORAGE_KEY) || storage.getItem(CADET_VAULT_STORAGE_KEY)) throw new Error('This device is already set up. Unlock it instead.')
  const salt = crypto.getRandomValues(new Uint8Array(16)), vaultKey = await deriveVaultKey(passphrase, salt)
  const record = saveCadetVault({ version: 1, kind: 'CADET', kdf: { name: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS, salt: b64url(salt) }, secrets: { check: await seal(vaultKey, 'check', CADET_CHECK) }, createdAt: new Date().toISOString() }, storage)
  return { record, vaultKey }
}
export async function unlockCadetDevice(record: CadetVaultRecord, passphrase: string): Promise<UnlockedCadetDevice> {
  if (Date.now() < failures.blockedUntil) throw new Error('Too many wrong passphrases. Wait one minute and try again.')
  if (record.version !== 1 || record.kdf.name !== 'PBKDF2-SHA-256' || record.kdf.iterations !== KDF_ITERATIONS) throw new Error('Unsupported device record format.')
  let vaultKey: CryptoKey
  try { vaultKey = await deriveVaultKey(passphrase, fromB64url(record.kdf.salt)); if (await unseal(vaultKey, 'check', record.secrets.check) !== CADET_CHECK) throw new Error('check') }
  catch (error) { failures.count++; if (failures.count >= 5) { failures.blockedUntil = Date.now() + 60_000; failures.count = 0 } throw new Error('That passphrase is not correct for this device.', { cause: error }) }
  failures.count = 0
  const cadet = record.secrets.cadet ? JSON.parse(await unseal(vaultKey, 'cadet', record.secrets.cadet)) as CadetDevice : undefined
  return { record, ...(cadet ? { cadet } : {}), vaultKey }
}
export async function sealCadetRedemption(device: UnlockedCadetDevice, redemption: CadetRedemptionInProgress, storage: Storage2) {
  device.record = saveCadetVault({ ...device.record, secrets: { ...device.record.secrets, redeeming: await seal(device.vaultKey, 'redeeming', JSON.stringify(redemption)) } }, storage)
}
export async function readCadetRedemption(device: UnlockedCadetDevice): Promise<CadetRedemptionInProgress | undefined> {
  const sealed = device.record.secrets.redeeming
  return sealed ? JSON.parse(await unseal(device.vaultKey, 'redeeming', sealed)) as CadetRedemptionInProgress : undefined
}
export function forgetCadetRedemption(device: UnlockedCadetDevice, storage: Storage2) {
  const secrets = { ...device.record.secrets }; delete secrets.redeeming
  device.record = saveCadetVault({ ...device.record, secrets }, storage)
}
/** The network accepted the phone's redemption: it keeps the CadetDevice, sealed, and forgets the redemption in progress. */
export async function completeCadetRedemption(device: UnlockedCadetDevice, cadet: CadetDevice, storage: Storage2): Promise<UnlockedCadetDevice> {
  if (device.cadet) throw new Error('This phone already belongs to a cadet.')
  const secrets: Record<string, SealedSecret> = { ...device.record.secrets, cadet: await seal(device.vaultKey, 'cadet', JSON.stringify(cadet)) }; delete secrets.redeeming
  device.record = saveCadetVault({ ...device.record, secrets }, storage)
  device.cadet = cadet
  return device
}

/** A notice a cadet's phone has read from the chain and keeps (ADR 013, mw-kmgi38.6): the record, plus when this phone showed it as read. */
export type StoredNotice = { noticeId: string; text: string; from: string; sentAt: string; readAt?: string }
/** The notices this phone keeps with their read state, as sealed in the cadet record; none before the first is read. Never throws for a damaged entry. */
export async function loadCadetNotices(device: UnlockedCadetDevice): Promise<StoredNotice[]> {
  const sealed = device.record.secrets.notices
  if (!sealed) return []
  try {
    const value = JSON.parse(await unseal(device.vaultKey, 'notices', sealed)) as unknown
    return Array.isArray(value) ? value.filter((entry): entry is StoredNotice => typeof entry?.noticeId === 'string' && typeof entry.text === 'string' && typeof entry.from === 'string' && typeof entry.sentAt === 'string' && (entry.readAt === undefined || typeof entry.readAt === 'string')) : []
  } catch { return [] }
}
/** Keeps the notices, sealed under the passphrase with the rest of the cadet record: their text is not readable in the phone's storage. */
export async function saveCadetNotices(device: UnlockedCadetDevice, notices: readonly StoredNotice[], storage: Storage2) {
  device.record = saveCadetVault({ ...device.record, secrets: { ...device.record.secrets, notices: await seal(device.vaultKey, 'notices', JSON.stringify(notices)) } }, storage)
}

/** SHA-256 fingerprint (16 hex) of the recovery public key, used to name its key grants. */
export async function recoveryFingerprint(publicKey: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer(encoder.encode(publicKey))))
  return Array.from(digest.slice(0, 8), byte => byte.toString(16).padStart(2, '0')).join('')
}
export const recoveryGranteeIdentity = (fingerprint: string) => `recovery:${fingerprint}`
async function recoveryFileKey(passphrase: string, salt: Uint8Array) { return deriveVaultKey(passphrase, salt) }

/**
 * Original Master only (the device holding the unit authority key). Produces a text file,
 * encrypted under its own recovery passphrase, that lets a brand-new device take the Master role
 * back if this one is lost. The recovery key inside it also receives every future unit key
 * generation on chain, so the file stays useful after members are removed.
 */
export async function exportRecoveryFile(device: UnlockedDevice, recoveryPassphrase: string, storage: Storage2) {
  const { record } = device
  if (!device.authoritySigner || !record.unit || !record.secrets.authority) throw new Error('Only the device that holds the unit authority can make a recovery file.')
  validatePassphrase(recoveryPassphrase)
  let recoveryEcdhJwk: string, recoveryPublicKey = record.recoveryPublicKey
  if (record.secrets.recoveryEcdh && recoveryPublicKey) recoveryEcdhJwk = await unseal(device.vaultKey, 'recoveryEcdh', record.secrets.recoveryEcdh)
  else {
    const pair = await newEcdhKey(); recoveryEcdhJwk = pair.jwk; recoveryPublicKey = pair.publicKey
    device.record = saveDeviceVault({ ...record, recoveryPublicKey, secrets: { ...record.secrets, recoveryEcdh: await seal(device.vaultKey, 'recoveryEcdh', recoveryEcdhJwk) } }, storage)
    device.recoveryEcdhPrivateKey = await importEcdhPrivate(recoveryEcdhJwk)
  }
  const unitKeys: Record<string, string> = {}
  for (const epoch of record.unit.epochs) unitKeys[epoch] = await unseal(device.vaultKey, epochSecretName(epoch), record.secrets[epochSecretName(epoch)])
  const payload: RecoveryPayload = { format: 1, unit: { unitId: record.unit.unitId, unitName: record.unit.unitName, authorityIdentity: record.unit.authorityIdentity }, authorityJwk: await unseal(device.vaultKey, 'authority', record.secrets.authority), recoveryEcdhJwk, recoveryPublicKey: recoveryPublicKey!, unitKeys, currentEpoch: record.unit.currentEpoch, createdAt: new Date().toISOString() }
  const salt = crypto.getRandomValues(new Uint8Array(16)), key = await recoveryFileKey(recoveryPassphrase, salt)
  const sealed = await seal(key, RECOVERY_FILE_PREFIX, JSON.stringify(payload))
  const fileText = `${RECOVERY_FILE_PREFIX}${b64url(encoder.encode(JSON.stringify({ unitId: record.unit.unitId, salt: b64url(salt), iterations: KDF_ITERATIONS, ...sealed })))}`
  return { fileText, publicKey: recoveryPublicKey!, fingerprint: await recoveryFingerprint(recoveryPublicKey!) }
}

async function openRecoveryFile(fileText: string, recoveryPassphrase: string): Promise<RecoveryPayload> {
  const text = fileText.trim()
  if (!text.startsWith(RECOVERY_FILE_PREFIX)) throw new Error('This is not an A.R.G.U.S. recovery file.')
  let outer: { unitId?: unknown; salt?: unknown; iterations?: unknown; nonce?: unknown; ct?: unknown }
  try { outer = JSON.parse(decoder.decode(fromB64url(text.slice(RECOVERY_FILE_PREFIX.length)))) as typeof outer } catch (cause) { throw new Error('This recovery file is damaged.', { cause }) }
  if (typeof outer.salt !== 'string' || typeof outer.nonce !== 'string' || typeof outer.ct !== 'string' || outer.iterations !== KDF_ITERATIONS) throw new Error('This recovery file is damaged.')
  let payload: RecoveryPayload
  try { payload = JSON.parse(await unseal(await recoveryFileKey(recoveryPassphrase, fromB64url(outer.salt)), RECOVERY_FILE_PREFIX, { nonce: outer.nonce, ct: outer.ct })) as RecoveryPayload }
  catch (cause) { throw new Error('That recovery passphrase is not correct for this file.', { cause }) }
  if (payload.format !== 1 || payload.unit?.unitId !== outer.unitId || !payload.authorityJwk || !payload.recoveryEcdhJwk || !payload.unitKeys?.[payload.currentEpoch]) throw new Error('This recovery file is damaged.')
  return payload
}

/**
 * Sets up a brand-new device as a Master of an existing unit from a recovery file. The device gets
 * its own new signing, ECDH and wallet keys; only the unit authority, the recovery key and the unit
 * data keys come from the file. It can then remove the lost device and admit people again.
 */
export async function restoreFromRecoveryFile(input: { fileText: string; recoveryPassphrase: string; passphrase: string; displayName: string; walletWif?: string }, storage: Storage2 = localStorage) {
  const payload = await openRecoveryFile(input.fileText, input.recoveryPassphrase)
  validatePassphrase(input.passphrase); const displayName = validateDisplayName(input.displayName)
  if (storage.getItem(DEVICE_VAULT_STORAGE_KEY)) throw new Error('This device is already set up. Erase it first to restore a unit here.')
  const authoritySigner = await importSigner(payload.authorityJwk, payload.unit.authorityIdentity)
  const salt = crypto.getRandomValues(new Uint8Array(16)), vaultKey = await deriveVaultKey(input.passphrase, salt), createdAt = new Date().toISOString()
  const signing = await newSigningKey(), ecdh = await newEcdhKey(), wallet = input.walletWif ? walletFromWif(input.walletWif) : newWalletWif()
  const secrets: Record<string, SealedSecret> = { signing: await seal(vaultKey, 'signing', signing.jwk), ecdh: await seal(vaultKey, 'ecdh', ecdh.jwk), wallet: await seal(vaultKey, 'wallet', wallet.wif), authority: await seal(vaultKey, 'authority', payload.authorityJwk), recoveryEcdh: await seal(vaultKey, 'recoveryEcdh', payload.recoveryEcdhJwk) }
  for (const [epoch, raw] of Object.entries(payload.unitKeys)) secrets[epochSecretName(epoch)] = await seal(vaultKey, epochSecretName(epoch), raw)
  const credential = await issueCredential(authoritySigner, { subjectPublicIdentity: signing.identity, role: 'MASTER', permissions: [...ROLE_PERMISSIONS.MASTER], issuedAt: createdAt })
  const record: DeviceVaultRecord = { version: 2, kdf: { name: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS, salt: b64url(salt) }, secrets, signingIdentity: signing.identity, ecdhPublicKey: ecdh.publicKey, walletAddress: wallet.address, displayName, role: 'MASTER', credential, unit: { ...payload.unit, currentEpoch: payload.currentEpoch, epochs: Object.keys(payload.unitKeys), joinedAt: createdAt }, admissions: [], recoveryPublicKey: payload.recoveryPublicKey, createdAt }
  saveDeviceVault(record, storage)
  return unlockDevice(record, input.passphrase)
}

/** Deletes one IndexedDB database; resolves either way (a database another tab still holds open is deleted once that tab lets go). */
function deleteDatabase(factory: IDBFactory, name: string) {
  return new Promise<void>(resolve => {
    try { const request = factory.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => resolve() } catch { resolve() }
  })
}

/**
 * Erases this device: its record (keys, sealed under the passphrase; on a cadet's phone, the cadet record) and its local stores — the
 * encrypted copy of the unit's history (argus-unit-ledger-<unitId>) and the wallet state
 * (argus-unit-wallet: this browser's device wallets only, one device per browser profile). The
 * unit's history is on chain; re-admission gives a fresh device full access again.
 */
export async function forgetDevice(storage: Pick<Storage, 'getItem' | 'removeItem'> = localStorage, factory: IDBFactory | undefined = globalThis.indexedDB) {
  let unitId: string | undefined
  try { unitId = loadDeviceVault(storage)?.unit?.unitId } catch { /* an unreadable record is erased all the same */ }
  storage.removeItem(DEVICE_VAULT_STORAGE_KEY)
  storage.removeItem(CADET_VAULT_STORAGE_KEY)
  if (!factory) return
  await Promise.all([DEFAULT_WALLET_DB_NAME, ...(unitId ? [IndexedDbLedgerStore.databaseName(unitId)] : [])].map(name => deleteDatabase(factory, name)))
}
