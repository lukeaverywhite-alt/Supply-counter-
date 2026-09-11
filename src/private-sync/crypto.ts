import { canonicalize, sha256 } from '../distributed/canonical'
import type { ArgusIdentityProvider } from '../identity/identity'
import type { SignedArgusEvent } from '../distributed/types'
import type { KeyDistributionService } from './keys'
import { parseEncryptedEnvelope, parseSignedEvent } from './schema'
import type { EncryptedArgusEnvelope } from './types'

const encoder = new TextEncoder(), decoder = new TextDecoder()
const bytesToBase64 = (bytes: Uint8Array) => { let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte) }); return btoa(binary) }
const base64ToBytes = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0))
const authenticatedHeader = (value: Pick<EncryptedArgusEnvelope, 'protocol' | 'protocolVersion' | 'organizationId' | 'eventId' | 'epochId' | 'senderPublicIdentity' | 'algorithm' | 'nonce'>) => canonicalize(value)

export async function encryptEvent(event: SignedArgusEvent, sender: ArgusIdentityProvider, keys: KeyDistributionService): Promise<EncryptedArgusEnvelope> {
  const epochId = keys.currentEpoch(), senderPublicIdentity = await sender.getPublicIdentity(), nonceBytes = crypto.getRandomValues(new Uint8Array(12))
  if (event.actorPublicIdentity !== senderPublicIdentity) throw new Error('Envelope sender must be the event signer.')
  const header = { protocol: 'ARGUS_PRIVATE_EVENT' as const, protocolVersion: 1 as const, organizationId: event.organizationId, eventId: event.eventId, epochId, senderPublicIdentity, algorithm: 'AES-256-GCM' as const, nonce: bytesToBase64(nonceBytes) }
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonceBytes, additionalData: encoder.encode(authenticatedHeader(header)), tagLength: 128 }, await keys.keyFor(senderPublicIdentity, epochId), encoder.encode(JSON.stringify(event)))
  const ciphertext = bytesToBase64(new Uint8Array(encrypted)), ciphertextHash = await sha256(base64ToBytes(ciphertext))
  return { ...header, ciphertext, ciphertextHash, signature: await sender.sign(canonicalize({ ...header, ciphertextHash })) }
}

export async function decryptEvent(input: unknown, recipientIdentity: string, verifier: ArgusIdentityProvider, keys: KeyDistributionService): Promise<SignedArgusEvent> {
  const envelope = parseEncryptedEnvelope(input)
  if (await sha256(base64ToBytes(envelope.ciphertext)) !== envelope.ciphertextHash) throw new Error('Encrypted envelope ciphertext hash mismatch.')
  const { ciphertext, signature, ...signed } = envelope
  if (!(await verifier.verify(canonicalize(signed), signature, envelope.senderPublicIdentity))) throw new Error('Invalid encrypted envelope sender signature.')
  let plaintext: ArrayBuffer
  const header = { protocol: envelope.protocol, protocolVersion: envelope.protocolVersion, organizationId: envelope.organizationId, eventId: envelope.eventId, epochId: envelope.epochId, senderPublicIdentity: envelope.senderPublicIdentity, algorithm: envelope.algorithm, nonce: envelope.nonce }
  try { plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.nonce), additionalData: encoder.encode(authenticatedHeader(header)), tagLength: 128 }, await keys.keyFor(recipientIdentity, envelope.epochId), base64ToBytes(ciphertext)) }
  catch { throw new Error('Authenticated envelope decryption failed.') }
  const event = parseSignedEvent(JSON.parse(decoder.decode(plaintext)))
  if (event.eventId !== envelope.eventId || event.organizationId !== envelope.organizationId || event.actorPublicIdentity !== envelope.senderPublicIdentity) throw new Error('Envelope metadata does not match its signed event.')
  return event
}
