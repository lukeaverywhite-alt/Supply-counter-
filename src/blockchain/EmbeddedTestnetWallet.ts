import { P2PKH, PrivateKey, Transaction } from '@bsv/sdk'
import type { TestnetWalletStatus, TestnetWalletStatusProvider } from './ArgusWalletAdapter'

const STORAGE_KEY = 'argus:testnet-wallet:v1'
const API = 'https://api.whatsonchain.com/v1/bsv/test'
const encoder = new TextEncoder()

type Vault = { version: 1; salt: string; iv: string; ciphertext: string; address: string; createdAt: string; recentTransactions?: TestnetWalletStatus['recentTransactions'] }
type Utxo = { tx_hash: string; tx_pos: number; value: number; height?: number }

const bytesToBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0))

async function passwordKey(password: string, salt: Uint8Array, usage: KeyUsage[]) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: 310_000 }, material, { name: 'AES-GCM', length: 256 }, false, usage)
}

/** An app-owned, testnet-only wallet. Its key is encrypted at rest and held in memory only while unlocked. */
export class EmbeddedTestnetWallet implements TestnetWalletStatusProvider {
  private key?: PrivateKey
  private operation?: Promise<unknown>

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
    const vault = this.readVault()
    let privateKey: PrivateKey
    try {
      const key = await passwordKey(password, base64ToBytes(vault.salt), ['decrypt'])
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(vault.iv) }, key, base64ToBytes(vault.ciphertext))
      privateKey = PrivateKey.fromWif(new TextDecoder().decode(plaintext))
      if (privateKey.toAddress('testnet') !== vault.address) throw new Error('Wallet address mismatch.')
    } catch { throw new Error('The wallet password is incorrect or the encrypted wallet is damaged.') }
    // Network status is intentionally outside the decrypt catch: an outage must
    // never be misreported as a wrong password or damaged key vault.
    this.key = privateKey
    return this.getStatus()
  }

  lock() { this.key = undefined }

  async getStatus(): Promise<TestnetWalletStatus> {
    if (!this.isCreated()) return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'EMBEDDED', recentTransactions: [], requiresSetup: true }
    const vault = this.readVault()
    const recentTransactions = vault.recentTransactions ?? []
    if (!this.key) return { network: 'TESTNET', connection: 'DISCONNECTED', mode: 'EMBEDDED', receivingAddress: vault.address, recentTransactions, requiresUnlock: true }
    try {
      const utxos = await this.utxos(vault.address)
      return { network: 'TESTNET', connection: 'CONNECTED', mode: 'EMBEDDED', receivingAddress: vault.address, balanceSatoshis: utxos.reduce((sum, output) => sum + output.value, 0), recentTransactions }
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
    await transaction.fee(); await transaction.sign()
    const response = await this.fetcher(`${API}/tx/raw`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: transaction.toHex() }) })
    if (!response.ok) throw new Error(`Testnet broadcast was rejected (${response.status}).`)
    const body = await response.json() as string | { txid?: string }
    const transactionId = typeof body === 'string' ? body : body.txid
    if (!transactionId || !/^[0-9a-f]{64}$/i.test(transactionId)) throw new Error('Broadcaster did not return a valid transaction ID.')
    const vault = this.readVault()
    vault.recentTransactions = [{ transactionId, status: 'BROADCAST' as const }, ...(vault.recentTransactions ?? []).filter(item => item.transactionId !== transactionId)].slice(0, 10)
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

function validatePassword(password: string) {
  if (password.length < 12) throw new Error('Use at least 12 characters for the wallet password.')
}
