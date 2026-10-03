import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { channelAddress } from '../blockchain/anchor'
import { FakeChain } from '../chain/fakeChain'
import type { CadetDevice } from '../unit/vault'
import { CADET_POLL_MS, useCadetPoller } from './CadetPoller'

const OWN_KEY = 'ab'.repeat(32), NOTICES_KEY = 'cd'.repeat(32), OWN = channelAddress(OWN_KEY), NOTICES = channelAddress(NOTICES_KEY)
const cadet: CadetDevice = { cadetId: 'cad-1', displayName: 'Avery Private', unit: { unitId: 'u-1', unitName: 'Bethel NJROTC' }, channelKey: OWN_KEY, channelAddress: OWN, noticesKey: NOTICES_KEY, noticesAddress: NOTICES, joinedAt: '2026-10-03T00:00:00.000Z' }

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }) })
afterEach(() => { vi.useRealTimers() })

describe('the cadet poller on the wire (mw-kmgi38.15)', () => {
  it('one poll is one scan of the cadet’s own address, never the shared notices address, every 25 minutes', async () => {
    const chain = new FakeChain(), scanned: string[] = []
    const confirmed = chain.confirmedHistory.bind(chain), unconfirmed = chain.unconfirmedHistory.bind(chain)
    chain.confirmedHistory = async (address, options) => { scanned.push(`confirmed ${address}`); return confirmed(address, options) }
    chain.unconfirmedHistory = async address => { scanned.push(`unconfirmed ${address}`); return unconfirmed(address) }
    const { result } = renderHook(() => useCadetPoller(cadet, chain))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.loaded).toBe(true)
    // One scan: the address's confirmed history and its mempool list, once each, and nothing at the notices address.
    expect(scanned).toEqual([`confirmed ${OWN}`, `unconfirmed ${OWN}`])
    expect(CADET_POLL_MS).toBe(25 * 60_000)
    await act(async () => { await vi.advanceTimersByTimeAsync(CADET_POLL_MS - 1) })
    expect(scanned).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(scanned).toEqual([`confirmed ${OWN}`, `unconfirmed ${OWN}`, `confirmed ${OWN}`, `unconfirmed ${OWN}`])
  })
})
