import { PrivateKey, PublicKey, Signature } from '@bsv/sdk'

/**
 * What the 128-bit ticket secret turns into (ADR 012): HKDF-SHA-256 with the secret as key material and the salt
 * `ARGUS-TICKET-1` gives a one-use secp256k1 ticket key (whose testnet address is where every record about the ticket
 * lives) and an AES-256-GCM wrapping key (which encrypts those records). Anyone holding the code derives the same
 * keys; nobody without it can link the address to a unit.
 */
const SALT = new TextEncoder().encode('ARGUS-TICKET-1')
const encoder = new TextEncoder()
/** The order of the secp256k1 group: a private scalar must be in 1 .. N-1. */
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export type TicketKeys = {
  /** Spends the funding output: only the issuer's device (which keeps the secret sealed) and the redeeming device ever hold it. */
  privateKey: PrivateKey
  /** k1: and the compressed public key in hex. */
  publicIdentity: string
  /** The ticket's testnet P2PKH address. */
  address: string
  /** AES-256-GCM key for every record at the ticket address; not extractable. */
  wrappingKey: CryptoKey
}

async function hkdf(secret: Uint8Array<ArrayBuffer>, info: string) {
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: encoder.encode(info) }, material, 256))
}

/** The private key for 32 bytes read big-endian, or undefined when the scalar is zero or not below the curve order. */
export function ticketKeyScalar(bytes: Uint8Array): PrivateKey | undefined {
  const scalar = bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n)
  if (scalar === 0n || scalar >= CURVE_ORDER) return undefined
  return PrivateKey.fromString(Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''), 'hex')
}

export async function deriveTicketKeys(secret: Uint8Array): Promise<TicketKeys> {
  if (secret.length !== 16) throw new Error('A ticket secret is 16 bytes.')
  const material = Uint8Array.from(secret)
  let privateKey: PrivateKey | undefined
  // Odds of needing a second round are about 2^-128; the loop exists so the derivation is total.
  for (let round = 0; !privateKey; round++) privateKey = ticketKeyScalar(await hkdf(material, round ? `ticket-key/${round}` : 'ticket-key'))
  const wrappingKey = await crypto.subtle.importKey('raw', await hkdf(material, 'ticket-wrap'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  return { privateKey, publicIdentity: `k1:${privateKey.toPublicKey().toDER('hex') as string}`, address: privateKey.toAddress('testnet'), wrappingKey }
}

/** t- and 20 random hex digits. */
export const newTicketId = () => `t-${Array.from(crypto.getRandomValues(new Uint8Array(10)), byte => byte.toString(16).padStart(2, '0')).join('')}`

const b64url = (bytes: Uint8Array | number[]) => { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') }
/**
 * A random P-256 ECDH key pair made for one ticket (ADR 012, "How members admitted by ticket get later rotations"): the
 * public half (SPKI, base64url) goes in the unit's TICKET_ISSUED fact so a rotation can grant to the ticket while it is
 * open; the private half (JWK JSON) rides in the ciphertext of the TICKET record.
 */
export async function newTicketEcdhKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair
  return { publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))), privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) }
}

const fromB64url = (value: string) => { const normalized = value.replaceAll('-', '+').replaceAll('_', '/'); return Array.from(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)) }
/** The ticket key's signature over a text (canonical JSON): `k1sig:` and the base64url DER of a low-S secp256k1 signature of its SHA-256. */
export const signWithTicketKey = (privateKey: PrivateKey, message: string) => `k1sig:${b64url(privateKey.sign(message, 'utf8').toDER() as number[])}`
/** Whether `signature` is the ticket key `k1:<hex>`'s signature over exactly `message`. Never throws: anything malformed is false. */
export function verifyTicketSignature(publicIdentity: string, message: string, signature: string) {
  if (!/^k1:0[23][0-9a-f]{64}$/.test(publicIdentity) || !signature.startsWith('k1sig:')) return false
  try { return PublicKey.fromString(publicIdentity.slice(3)).verify(message, Signature.fromDER(fromB64url(signature.slice(6))), 'utf8') } catch { return false }
}
