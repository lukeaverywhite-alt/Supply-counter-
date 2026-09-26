import { P2PKH, PrivateKey, SatoshisPerKilobyte, Transaction } from '@bsv/sdk'
import type { TestnetWalletStatus, TestnetWalletStatusProvider } from './ArgusWalletAdapter'

const STORAGE_KEY = 'argus:testnet-wallet:v1'
const API = 'https://api.whatsonchain.com/v1/bsv/test'
const TESTNET_FEE_MODEL = new SatoshisPerKilobyte(100)
const encoder = new TextEncoder()

type Vault = { version: 1; salt: string; iv: string; ciphertext: string; address: string; createdAt: string; recentTransactions?: TestnetWalletStatus['recentTransactions'] }
export type WalletBackup = { format: 'ARGUS_TESTNET_WALLET_BACKUP'; version: 1; network: 'BSV_TESTNET'; address: string; createdAt: string; backupId: string; kdf: { name: 'PBKDF2-SHA-256'; iterations: 600000; salt: string }; cipher: { name: 'AES-256-GCM'; nonce: string }; ciphertext: string }
type Utxo = { tx_hash: string; tx_pos: number; value: number; height?: number }

const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

async function passwordKey(password: string, salt: Uint8Array, usage: KeyUsage[]) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: 310_000 }, material, { name: 'AES-GCM', length: 256 }, false, usage)
}

async function backupKey(password: string, salt: Uint8Array, usage: KeyUsage[]) {
  validatePassword(password)
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: 600_000 }, material, { name: 'AES-GCM', length: 256 }, false, usage)
}

/** An app-owned, testnet-only wallet. Its key is encrypted at rest and held in memory only while unlocked. */
export class EmbeddedTestnetWallet implements TestnetWalletStatusProvider {
  private key?: PrivateKey
  private operation?: Promise<unknown>
  private failedUnlocks = 0
  private unlockBlockedUntil = 0

  constructor(private readonly storage: Pick<Storage, 'getItem'|'setItem'> = localStorage, private readonly fetcher: typeof fetch = fetch) {}

  isCreated() { return this.storage.getItem(STORAGE_KEY) !== null }

  async getNetwork() { return { network: 'testnet' as const } }

  /** BRC-100-compatible subset consumed by EncryptedEventTestnetAdapter. */
  async createAction(args: { outputs: Array<{ lockingScript: string; satoshis: number }> }) {
    if (args.outputs.length !== 1 || args.outputs[0].satoshis !== 1) throw new Error('The embedded wallet only publishes one-satoshi A.R.G.U.S. data outputs.')
    const result = await this.createDataTransaction(args.outputs[0].lockingScript)
    return { txid: result.transactionId, tx: result.tx }
  }

  async create(password: string) {
    if (this.isCreated()) throw new Error('A testnet wallet already exists on this device.')
    validatePassword(password)
    const privateKey = PrivateKey.fromRandom(), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
    const key = await passwordKey(password, salt, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(privateKey.toWif([0xef])))
    const vault: Vault = { version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)), address: privateKey.toAddress('testnet'), createdAt: new Date().toISOString(), recentTransactions: [] }
    this.storage.setItem(STORAGE_KEY, JSON.stringify(vault))
    this.key = privateKey
    return this.getStatus()
  }

  async unlock(password: string) {
    if (Date.now() < this.unlockBlockedUntil) throw new Error('Wallet unlock is temporarily rate-limited. Wait one minute before retrying.')
    const vault = this.readVault()
    let privateKey: PrivateKey
    try {
      const key = await passwordKey(password, base64ToBytes(vault.salt), ['decrypt'])
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(vault.iv) }, key, base64ToBytes(vault.ciphertext))
      privateKey = PrivateKey.fromWif(new TextDecoder().decode(plaintext))
      if (privateKey.toAddress('testnet') !== vault.address) throw new Error('Wallet address mismatch.')
    } catch (error) {
      this.failedUnlocks += 1
      if (this.failedUnlocks >= 5) this.unlockBlockedUntil = Date.now() + 60_000
      throw new Error('The wallet password is incorrect or the encrypted wallet is damaged.', { cause: error })
    }
    // Network status is intentionally outside the decrypt catch: an outage must
    // never be misreported as a wrong password or damaged key vault.
    this.key = privateKey
    this.failedUnlocks = 0
    this.unlockBlockedUntil = 0
    return this.getStatus()
  }

  lock() { this.key = undefined }

  async exportBackup(password: string): Promise<string> {
    if (!this.key) throw new Error('Unlock the wallet before exporting a recovery package.')
    const vault = this.readVault(), salt = crypto.getRandomValues(new Uint8Array(16)), nonce = crypto.getRandomValues(new Uint8Array(12))
    const backupId = crypto.randomUUID(), key = await backupKey(password, salt, ['encrypt'])
    const header = { format: 'ARGUS_TESTNET_WALLET_BACKUP' as const, version: 1 as const, network: 'BSV_TESTNET' as const, address: vault.address, createdAt: new Date().toISOString(), backupId }
    const payload = { wif: this.key.toWif([0xef]), walletCreatedAt: vault.createdAt }
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(JSON.stringify(header)) }, key, encoder.encode(JSON.stringify(payload)))
    const result: WalletBackup = { ...header, kdf: { name: 'PBKDF2-SHA-256', iterations: 600000, salt: bytesToBase64(salt) }, cipher: { name: 'AES-256-GCM', nonce: bytesToBase64(nonce) }, ciphertext: bytesToBase64(new Uint8Array(ciphertext)) }
    return JSON.stringify(result, null, 2)
  }

  async inspectBackup(serialized: string, password: string) {
    const backup = parseBackup(serialized)
    try {
      const header = { format: backup.format, version: backup.version, network: backup.network, address: backup.address, createdAt: backup.createdAt, backupId: backup.backupId }
      const key = await backupKey(password, base64ToBytes(backup.kdf.salt), ['decrypt'])
      const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(backup.cipher.nonce), additionalData: encoder.encode(JSON.stringify(header)) }, key, base64ToBytes(backup.ciphertext))
      const payload = JSON.parse(new TextDecoder().decode(clear)) as { wif: string; walletCreatedAt: string }
      const recovered = PrivateKey.fromWif(payload.wif)
      if (recovered.toAddress('testnet') !== backup.address) throw new Error('address mismatch')
      const current = this.isCreated() ? this.readVault() : undefined
      return { address: backup.address, currentAddress: current?.address, backupId: backup.backupId, createdAt: backup.createdAt, walletCreatedAt: payload.walletCreatedAt, rollbackWarning: Boolean(current && new Date(payload.walletCreatedAt) < new Date(current.createdAt)) }
    } catch { throw new Error('The backup password is incorrect or the recovery package failed authentication.') }
  }

  async recoverBackup(serialized: string, password: string, confirmation: { address: string; replaceExisting?: boolean; currentWalletBackedUp?: boolean; allowRollback?: boolean }) {
    const details = await this.inspectBackup(serialized, password)
    if (confirmation.address !== details.address) throw new Error('Type the recovered public address exactly to confirm recovery.')
    if (details.currentAddress && (!confirmation.replaceExisting || !confirmation.currentWalletBackedUp)) throw new Error('Replacing a wallet requires explicit confirmation and acknowledgement that the current wallet was backed up.')
    if (details.rollbackWarning && !confirmation.allowRollback) throw new Error('This is an older wallet backup. Explicit rollback confirmation is required.')
    const backup = parseBackup(serialized), header = { format: backup.format, version: backup.version, network: backup.network, address: backup.address, createdAt: backup.createdAt, backupId: backup.backupId }
    const key = await backupKey(password, base64ToBytes(backup.kdf.salt), ['decrypt'])
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(backup.cipher.nonce), additionalData: encoder.encode(JSON.stringify(header)) }, key, base64ToBytes(backup.ciphertext))
    const payload = JSON.parse(new TextDecoder().decode(clear)) as { wif: string; walletCreatedAt: string }
    const recovered = PrivateKey.fromWif(payload.wif), salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12)), vaultKey = await passwordKey(password, salt, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, encoder.encode(recovered.toWif([0xef])))
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)), address: details.address, createdAt: payload.walletCreatedAt, recentTransactions: [] } satisfies Vault))
    this.key = recovered
    return this.getStatus()
  }

  async getStatus(): Promise<TestnetWalletStatus> {
    if (!this.isCreated()) return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'EMBEDDED', recentTransactions: [], requiresSetup: true }
    const vault = this.readVault()
    const recentTransactions = vault.recentTransactions ?? []
    if (!this.key) return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'EMBEDDED', receivingAddress: vault.address, recentTransactions, requiresUnlock: true }
    try {
      const utxos = await this.utxos(vault.address)
      const confirmed = utxos.filter(output => (output.height ?? 0) > 0).reduce((sum, output) => sum + output.value, 0)
      const unconfirmed = utxos.filter(output => !output.height || output.height <= 0).reduce((sum, output) => sum + output.value, 0)
      return { network: 'TESTNET', connection: 'CONNECTED', mode: 'EMBEDDED', receivingAddress: vault.address, balanceSatoshis: confirmed, unconfirmedBalanceSatoshis: unconfirmed, recentTransactions }
    } catch (error) {
      return { network: 'TESTNET', connection: 'ERROR', mode: 'EMBEDDED', receivingAddress: vault.address, recentTransactions, error: error instanceof Error ? error.message : 'Could not reach the BSV testnet service.' }
    }
  }

  /** Builds, signs, and broadcasts one data output using faucet-funded P2PKH UTXOs. */
  async createDataTransaction(lockingScriptHex: string) {
    if (this.operation) throw new Error('Another wallet transaction is already in progress.')
    const operation = this.buildAndBroadcast(lockingScriptHex)
    this.operation = operation
    try { return await operation } finally { this.operation = undefined }
  }

  private async buildAndBroadcast(lockingScriptHex: string) {
    const privateKey = this.key
    if (!privateKey) throw new Error('Unlock the testnet wallet before publishing data.')
    if (!/^(?:[0-9a-f]{2})+$/i.test(lockingScriptHex)) throw new Error('Data locking script must be hexadecimal.')
    const address = privateKey.toAddress('testnet'), utxos = await this.utxos(address)
    if (!utxos.length) throw new Error('This wallet has no spendable testnet coins. Fund its faucet address first.')
    const transaction = new Transaction()
    for (const output of utxos) {
      const response = await this.fetcher(`${API}/tx/${output.tx_hash}/hex`)
      if (!response.ok) throw new Error(`Could not load funding transaction (${response.status}).`)
      transaction.addInput({ sourceTransaction: Transaction.fromHex(await response.text()), sourceOutputIndex: output.tx_pos, unlockingScriptTemplate: new P2PKH().unlock(privateKey) })
    }
    transaction.addOutput({ satoshis: 1, lockingScript: (await import('@bsv/sdk')).LockingScript.fromHex(lockingScriptHex) })
    transaction.addOutput({ change: true, lockingScript: new P2PKH().lock(address) })
    // A deterministic fee model avoids an unrelated mainnet policy lookup and
    // keeps every network request on the explicitly configured testnet API.
    await transaction.fee(TESTNET_FEE_MODEL); await transaction.sign()
    const response = await this.fetcher(`${API}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: transaction.toHex() }) })
    if (!response.ok) throw new Error(`Testnet broadcast was rejected (${response.status}).`)
    const body = await response.json() as string | { txid?: string }
    const transactionId = typeof body === 'string' ? body : body.txid
    if (!transactionId || !/^[0-9a-f]{64}$/i.test(transactionId)) throw new Error('Broadcaster did not return a valid transaction ID.')
    const vault = this.readVault()
    vault.recentTransactions = [{ transactionId, status: 'BROADCAST' as const, timestamp: new Date().toISOString() }, ...(vault.recentTransactions ?? []).filter(item => item.transactionId !== transactionId)].slice(0, 10)
    this.storage.setItem(STORAGE_KEY, JSON.stringify(vault))
    return { transactionId, tx: transaction.toBinary() }
  }

  private async utxos(address: string) {
    const response = await this.fetcher(`${API}/address/${address}/unspent`)
    if (!response.ok) throw new Error(`Could not read the testnet wallet balance (${response.status}).`)
    const value = await response.json()
    if (!Array.isArray(value)) throw new Error('The testnet balance service returned an invalid response.')
    return value as Utxo[]
  }

  private readVault() {
    const raw = this.storage.getItem(STORAGE_KEY)
    if (!raw) throw new Error('Create the testnet wallet first.')
    let value: Vault
    try { value = JSON.parse(raw) as Vault } catch { throw new Error('The encrypted wallet record is invalid.') }
    if (value.version !== 1 || !value.address || !value.salt || !value.iv || !value.ciphertext) throw new Error('The encrypted wallet record is invalid.')
    if (value.recentTransactions !== undefined && (!Array.isArray(value.recentTransactions) || value.recentTransactions.some(item => !/^[0-9a-f]{64}$/i.test(item.transactionId)))) throw new Error('The encrypted wallet record is invalid.')
    return value
  }
}

function parseBackup(serialized: string): WalletBackup {
  let value: WalletBackup
  try { value = JSON.parse(serialized) as WalletBackup } catch { throw new Error('The recovery package is not valid JSON.') }
  if (value.format !== 'ARGUS_TESTNET_WALLET_BACKUP' || value.version !== 1 || value.network !== 'BSV_TESTNET' || !value.address || !value.backupId || value.kdf?.iterations !== 600000 || value.cipher?.name !== 'AES-256-GCM' || !value.ciphertext) throw new Error('Unsupported or damaged A.R.G.U.S. wallet backup.')
  return value
}

function validatePassword(password: string) {
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error('Use at least 12 characters including a letter and number for the wallet password.')
}
