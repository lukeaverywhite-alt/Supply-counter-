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

export type HistoryPage = { envelopes: unknown[]; cursor: string; hasMore?: boolean }
export type PublishResult = { accepted: true; duplicate: boolean; sequence: number }
export type ProviderHealth = { ok: boolean; provider: string; protocolVersion: number }
export interface PrivateHistoryProvider {
  readonly name: string
  publish(envelope: EncryptedArgusEnvelope): Promise<void | PublishResult>
  getSince(cursor?: string): Promise<HistoryPage>
  getByEventId(eventId: string): Promise<unknown | undefined>
  health?(): Promise<ProviderHealth>
}
