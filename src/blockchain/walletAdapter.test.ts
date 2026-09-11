import { describe, expect, it } from 'vitest'
import { assertTestnetOnly, UnconfiguredTestnetWalletAdapter } from './ArgusWalletAdapter'
describe('Stage 2.5 testnet wallet boundary', () => {
  it('fails closed for mainnet and unsupported network values', () => { expect(() => assertTestnetOnly('MAINNET')).toThrow(/mainnet is disabled/); expect(() => assertTestnetOnly('mock')).toThrow(/TESTNET/) })
  it('never fabricates a TXID when an external test wallet is absent', async () => { await expect(new UnconfiguredTestnetWalletAdapter().createTestnetAuditTransaction({ protocol: 'ARGUS_AUDIT', protocolVersion: 1, organizationOpaqueId: 'org-test', eventId: 'event-test', eventType: 'ITEM_ISSUED', opaqueEntityId: 'item-test', eventHash: '00'.repeat(32), timestamp: new Date(0).toISOString(), signerPublicReference: 'development-test-identity' })).rejects.toThrow(/no TXID/) })
})
