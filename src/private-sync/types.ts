export type EncryptedArgusEnvelope = {
  protocol: 'ARGUS_PRIVATE_EVENT'
  protocolVersion: 1
  organizationId: string
  eventId: string
  epochId: string
  senderPublicIdentity: string
  algorithm: 'AES-256-GCM'
  nonce: string
  ciphertext: string
  ciphertextHash: string
  signature: string
}

export type HistoryPage = { envelopes: unknown[]; cursor: string }
export interface PrivateHistoryProvider {
  readonly name: string
  publish(envelope: EncryptedArgusEnvelope): Promise<void>
  getSince(cursor?: string): Promise<HistoryPage>
  getByEventId(eventId: string): Promise<unknown | undefined>
}
