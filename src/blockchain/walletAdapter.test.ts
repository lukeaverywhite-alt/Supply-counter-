import { describe, expect, it } from 'vitest'
import type { WalletInterface } from '@bsv/sdk'
import { assertTestnetOnly, Brc100TestnetWalletProvider, UnconfiguredTestnetWalletAdapter } from './ArgusWalletAdapter'
describe('Stage 2.5 testnet wallet boundary', () => {
  it('connects to an authorized testnet BRC-100 wallet and derives a faucet address', async () => {
    const wallet = { isAuthenticated: async()=>({authenticated:true as const}), getNetwork:async()=>({network:'testnet' as const}), getPublicKey:async()=>({publicKey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}), listActions:async()=>({totalActions:1,actions:[{txid:'a'.repeat(64),status:'unproven'}]}) } as unknown as WalletInterface
    expect(await new Brc100TestnetWalletProvider(wallet).getStatus()).toMatchObject({ connection:'CONNECTED', mode:'LIVE', receivingAddress:'mrCDrCybB6J1vRfbwM5hemdJz73FwDBC8r', recentTransactions:[{transactionId:'a'.repeat(64),status:'BROADCAST'}] })
  })
  it('fails closed when the connected wallet is on mainnet', async () => {
    const wallet = { isAuthenticated: async()=>({authenticated:true as const}), getNetwork:async()=>({network:'mainnet' as const}) } as unknown as WalletInterface
    expect(await new Brc100TestnetWalletProvider(wallet).getStatus()).toMatchObject({ connection:'ERROR', error:expect.stringMatching(/mainnet/i) })
  })
  it('fails closed for mainnet and unsupported network values', () => { expect(() => assertTestnetOnly('MAINNET')).toThrow(/mainnet is disabled/); expect(() => assertTestnetOnly('mock')).toThrow(/TESTNET/) })
  it('never fabricates a TXID when an external test wallet is absent', async () => { await expect(new UnconfiguredTestnetWalletAdapter().createTestnetAuditTransaction({ protocol: 'ARGUS_AUDIT', protocolVersion: 1, organizationOpaqueId: 'org-test', eventId: 'event-test', eventType: 'ITEM_ISSUED', opaqueEntityId: 'item-test', eventHash: '00'.repeat(32), timestamp: new Date(0).toISOString(), signerPublicReference: 'development-test-identity' })).rejects.toThrow(/no TXID/) })
})
