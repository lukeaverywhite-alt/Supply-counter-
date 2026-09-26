import { describe, expect, it } from 'vitest'
import { createWalletRuntime } from './walletRuntime'

describe('wallet runtime composition', () => {
  it('shares one embedded provider across status and transaction publication', () => {
    const runtime = createWalletRuntime('embedded-testnet', { storage: { getItem:()=>null, setItem:()=>undefined } as unknown as Storage })
    expect(runtime.wallet).toBe(runtime.transactionWallet)
  })
  it('never silently substitutes a mock', async () => {
    const runtime = createWalletRuntime(undefined)
    expect(runtime.mode).toBe('unconfigured')
    expect((await runtime.wallet.getStatus()).mode).toBe('UNCONFIGURED')
  })
})
