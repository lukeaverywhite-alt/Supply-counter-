import type { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import type { ArgusRole } from '../distributed/types'
import { MemoryLedgerStore } from '../unit/ledgerStore'
import { UnitRuntime } from '../unit/runtime'
import { redeemTicket } from '../unit/ticketRedemption'
import { createJoiningDevice } from '../unit/vault'

export const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) }, values } }

/**
 * A new person joins a unit the only way there is: the issuer makes a ticket, the person's fresh device redeems its code from the
 * chain, and the device is opened. The issuer's wallet must hold testnet coins (a ticket carries starter satoshis).
 */
export async function joinByTicket(issuer: UnitRuntime, chain: FakeChain, name: string, role: ArgusRole, options: { satoshis?: number; passphrase?: string; store?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>; ledger?: MemoryLedgerStore } = {}) {
  const store = options.store ?? memoryStorage(), ledger = options.ledger ?? new MemoryLedgerStore()
  const pending = await createJoiningDevice({ passphrase: options.passphrase ?? 'another pass 77', displayName: name }, store)
  const ticket = await issuer.issueTicket(name, role, options.satoshis ? { satoshis: options.satoshis } : {})
  await issuer.syncNow(); chain.mine()
  const runtimeOptions = { api: chain, ledger, walletStore: new MemoryWalletStateStore(), storage: store }
  const redeemed = await redeemTicket(pending, ticket.code, runtimeOptions)
  if (redeemed.status !== 'ACTIVE') throw new Error('The ticket was not accepted by the fake chain.')
  const runtime = await UnitRuntime.open(redeemed.device, runtimeOptions)
  return { device: redeemed.device, runtime, store, ledger, ticket }
}
