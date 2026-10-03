import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChainApi } from '../chain/types'
import type { NotificationEnvironment } from '../notifications/environment'
import type { CadetView } from '../distributed/types'
import { readCadetChannel } from '../unit/cadetPublisher'
import type { CadetDevice, UnlockedCadetDevice } from '../unit/vault'
import { CadetApp } from './CadetApp'
import { CADET_POLL_MS } from './CadetPoller'
import { formatWhen } from './format'

vi.mock('../unit/cadetPublisher', () => ({ readCadetChannel: vi.fn() }))
const read = vi.mocked(readCadetChannel)
/** What one scan of the cadet's own channel finds: the newest record, if any, and the notices. */
const found = (view?: CadetView, notices: Awaited<ReturnType<typeof readCadetChannel>>['notices'] = []) => ({ ...(view ? { view } : {}), notices })

const cadet: CadetDevice = { cadetId: 'cad-1', displayName: 'Avery Private', unit: { unitId: 'u-1', unitName: 'Bethel NJROTC' }, channelKey: 'k', channelAddress: 'a', noticesKey: 'n', noticesAddress: 'na', joinedAt: '2026-10-03T00:00:00.000Z' }
const device = { cadet } as UnlockedCadetDevice
const api = {} as ChainApi
const view = (over: Partial<CadetView> = {}): CadetView => ({ cadetId: 'cad-1', cadetCode: 'C-4F7K', fullName: 'Avery Private', sizes: {}, have: [], stillNeeded: [], version: 1, updatedAt: '2026-10-03T14:05:00.000Z', ...over })
const gear = view({ have: [{ itemId: 'i1', label: 'Gold PT Shirt', size: 'M', quantity: 2, issuedAt: '2026-10-01T00:00:00.000Z' }, { itemId: 'i2', label: 'PT Shorts', size: 'L', quantity: 1, issuedAt: '2026-10-01T00:00:00.000Z' }], stillNeeded: [{ label: 'Belt', size: '34', quantity: 1 }, { label: 'Name Tag', quantity: 3 }] })
const open = (onLeave = vi.fn()) => { render(<CadetApp device={device} api={api} onLeave={onLeave} />); return onLeave }
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }); read.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('cadet mode: My gear', () => {
  it('shows the unit, the cadet, the code, what they have with size and quantity, and what is still needed', async () => {
    read.mockResolvedValue(found(gear))
    open(); await settle()
    expect(screen.getByText('Bethel NJROTC')).toBeInTheDocument()
    expect(screen.getAllByText('Cadet').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'My gear' })).toBeInTheDocument()
    expect(screen.getByText('Avery Private')).toBeInTheDocument()
    expect(screen.getByText('C-4F7K')).toBeInTheDocument()
    const have = screen.getByRole('region', { name: 'Have' }), needed = screen.getByRole('region', { name: 'Still needed' })
    expect(have).toHaveTextContent('Gold PT Shirt'); expect(have).toHaveTextContent('Size M'); expect(have).toHaveTextContent('Qty 2')
    expect(have).toHaveTextContent('PT Shorts'); expect(have).toHaveTextContent('Size L'); expect(have).toHaveTextContent('Qty 1')
    expect(needed).toHaveTextContent('Belt'); expect(needed).toHaveTextContent('Size 34'); expect(needed).toHaveTextContent('Name Tag'); expect(needed).toHaveTextContent('Qty 3')
    expect(screen.getByText(`Updated ${formatWhen(gear.updatedAt)}`)).toBeInTheDocument()
    expect(screen.queryByText('Nothing issued yet')).toBeNull()
    expect(screen.queryByText('Nothing still needed')).toBeNull()
  })

  it('says so when nothing is issued and nothing is needed', async () => {
    read.mockResolvedValue(found(view()))
    open(); await settle()
    expect(screen.getByText('Nothing issued yet')).toBeInTheDocument()
    expect(screen.getByText('Nothing still needed')).toBeInTheDocument()
  })

  it('says the counter has published nothing yet, rather than "nothing issued", before the first record', async () => {
    read.mockResolvedValue(found())
    open(); await settle()
    expect(screen.getByText('Avery Private')).toBeInTheDocument()
    expect(screen.getByText(/has not published your gear yet/)).toBeInTheDocument()
    expect(screen.queryByText('Nothing issued yet')).toBeNull()
  })

  it('a newer record after Refresh replaces the old lines', async () => {
    read.mockResolvedValueOnce(found(gear))
    open(); await settle()
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
    read.mockResolvedValueOnce(found(view({ version: 2, updatedAt: '2026-10-03T16:30:00.000Z', have: [{ itemId: 'i3', label: 'Utility Cover', size: '7', quantity: 1, issuedAt: '2026-10-03T00:00:00.000Z' }], stillNeeded: [] })))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle()
    expect(screen.queryByText(/Gold PT Shirt/)).toBeNull()
    expect(screen.getByText(/Utility Cover/)).toBeInTheDocument()
    expect(screen.getByText('Nothing still needed')).toBeInTheDocument()
    expect(screen.getByText(`Updated ${formatWhen('2026-10-03T16:30:00.000Z')}`)).toBeInTheDocument()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('offline: keeps the last record on screen and says "Last updated <time>"', async () => {
    read.mockResolvedValueOnce(found(gear))
    open(); await settle()
    read.mockRejectedValueOnce(new Error('Failed to fetch'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle()
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
    expect(screen.getByText(`Last updated ${formatWhen(gear.updatedAt)}`)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/could not reach the network/i)
  })

  it('offline before any record: says so and offers Refresh', async () => {
    read.mockRejectedValueOnce(new Error('Failed to fetch'))
    open(); await settle()
    expect(screen.getByRole('status')).toHaveTextContent(/could not reach the network/i)
    read.mockResolvedValueOnce(found(gear))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle()
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
    expect(screen.queryByText(/could not reach the network/i)).toBeNull()
  })

  it('has no staff tabs and no unit screen', async () => {
    read.mockResolvedValue(found(gear))
    open(); await settle()
    for (const word of ['Count', 'Inventory', 'Cadets', 'Activity', 'More']) expect(screen.queryByText(word)).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
  })
})

describe('the poller', () => {
  it('reads once on mount and once per 25 minutes, and not at 15 seconds or at 5 minutes', async () => {
    read.mockResolvedValue(found(gear))
    open(); await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({ cadet }, api)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(CADET_POLL_MS - 15_000 - 5 * 60_000 - 1) })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(CADET_POLL_MS) })
    expect(read).toHaveBeenCalledTimes(3)
    expect(CADET_POLL_MS).toBe(25 * 60_000)
  })

  it('a poll is one scan: the record and the notices come from the same read of the cadet’s own channel', async () => {
    read.mockResolvedValue(found(gear, [{ noticeId: 'n1', text: 'Military ball', sentAt: '2026-10-03T00:00:00.000Z', from: 'Chief' }]))
    open(); await settle()
    expect(read).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Notices/ })).toHaveTextContent('1')
  })

  it('a scan that cannot reach the network marks the poll offline and keeps the gear', async () => {
    read.mockResolvedValueOnce(found(gear))
    open(); await settle()
    read.mockRejectedValueOnce(new Error('Failed to fetch'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle()
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/could not reach the network/i)
  })

  it('reads again when the tab becomes visible, and not when it is hidden', async () => {
    read.mockResolvedValue(found(gear))
    open(); await settle()
    const visibility = vi.spyOn(document, 'visibilityState', 'get')
    visibility.mockReturnValue('hidden'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
    expect(read).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible'); await act(async () => { document.dispatchEvent(new Event('visibilitychange')) }); await settle()
    expect(read).toHaveBeenCalledTimes(2)
    visibility.mockRestore()
  })

  it('stops reading when the screen is gone', async () => {
    read.mockResolvedValue(found(gear))
    open(); await settle()
    cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(CADET_POLL_MS * 2) })
    document.dispatchEvent(new Event('visibilitychange')); await settle()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('does not start a second read while one is still out', async () => {
    let finish: (value: CadetView) => void = () => undefined
    read.mockReturnValueOnce(new Promise(resolve => { finish = view => resolve(found(view)) }))
    open(); await settle()
    document.dispatchEvent(new Event('visibilitychange')); await settle()
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => { finish(gear); await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByText(/Gold PT Shirt/)).toBeInTheDocument()
  })
})

describe('Settings: notifications', () => {
  const environment = (permission: NotificationEnvironment['permission'] extends () => infer P ? P : never) => {
    const requestPermission = vi.fn(async () => 'granted' as const)
    return { permission: () => permission, requestPermission, visible: () => true } as unknown as NotificationEnvironment
  }
  it('offers to allow notifications when the phone has not been asked, and says so once allowed', async () => {
    read.mockResolvedValue(found(gear))
    const env = environment('default')
    render(<CadetApp device={device} api={api} notificationEnvironment={env} onLeave={vi.fn()} />); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' })) })
    expect(env.requestPermission).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveTextContent('Device notifications are on')
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull()
  })

  it('when notifications are blocked it says the badge still shows and offers nothing to press', async () => {
    read.mockResolvedValue(found(gear))
    render(<CadetApp device={device} api={api} notificationEnvironment={environment('denied')} onLeave={vi.fn()} />); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('dialog', { name: 'Settings' })).toHaveTextContent('blocked')
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull()
  })
})

describe('Settings: Leave this unit', () => {
  it('opens a Settings sheet, asks before leaving, and only then wipes', async () => {
    read.mockResolvedValue(found(gear))
    const onLeave = open(); await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const sheet = screen.getByRole('dialog', { name: 'Settings' })
    expect(sheet).toHaveTextContent('Bethel NJROTC')
    fireEvent.click(screen.getByRole('button', { name: 'Leave this unit' }))
    expect(onLeave).not.toHaveBeenCalled()
    expect(screen.getByText(/erases this phone/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Keep my place' }))
    expect(onLeave).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Leave this unit' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, leave this unit' })) })
    expect(onLeave).toHaveBeenCalledTimes(1)
  })

  it('closes without leaving', async () => {
    read.mockResolvedValue(found(gear))
    const onLeave = open(); await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onLeave).not.toHaveBeenCalled()
  })
})
