import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../chain/fakeChain'
import { MemoryWalletStateStore } from '../chain/walletStore'
import type { DeviceNotification, DevicePermission, NotificationEnvironment } from '../notifications/environment'
import { DeviceNotifier } from '../notifications/notifier'
import { memoryStorage } from '../test/joinByTicket'
import { MemoryLedgerStore } from '../unit/ledgerStore'
import { UnitRuntime } from '../unit/runtime'
import { CADET_VAULT_STORAGE_KEY, completeCadetRedemption, createCadetVault, createMasterDevice, loadCadetVault, unlockCadetDevice, type CadetDevice, type UnlockedCadetDevice } from '../unit/vault'
import { CadetApp } from './CadetApp'

const PASS = 'cadet locker 9'

function fakeEnvironment(permission: DevicePermission = 'granted') {
  const shown: DeviceNotification[] = []
  const environment: NotificationEnvironment = {
    permission: () => permission, requestPermission: async () => permission, visible: () => true, platform: () => ({ ios: false, standalone: false }),
    show: async notification => { shown.push(notification); return true }, close: async () => undefined,
    closedAppSupport: async () => 'available', setClosedAppChecks: async enabled => enabled, writeSummary: async () => undefined,
  }
  return { environment, shown }
}

describe('cadet mode: Notices (ADR 013, mw-kmgi38.6)', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let master: UnitRuntime, avery: CadetDevice, blake: CadetDevice
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 600_000, { confirmed: true })
    master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    const ids = []
    for (const [fullName, cadetCode] of [['Avery Private', 'C-T001'], ['Blake Private', 'C-T002']]) {
      const state = await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName, cadetCode })
      const id = state.cadets.find(cadet => cadet.fullName === fullName)!.cadetId
      await master.controller.createCadetChannel(id); ids.push(id)
    }
    await master.controller.createNoticesKey()
    const state = await master.controller.technicalState(), notices = state.noticesChannel!
    const phone = (cadetId: string, displayName: string): CadetDevice => {
      const channel = state.cadetChannels.find(entry => entry.cadetId === cadetId)!
      return { cadetId, displayName, unit: { unitId: 'u-1', unitName: 'Bethel NJROTC' }, channelKey: channel.channelKey, channelAddress: channel.channelAddress, noticesKey: notices.key, noticesAddress: notices.address, joinedAt: '2026-10-03T00:00:00.000Z' }
    }
    avery = phone(ids[0], 'Avery Private'); blake = phone(ids[1], 'Blake Private')
    vi.useRealTimers()
  })
  afterEach(() => { cleanup(); vi.useRealTimers() })

  const send = async (audience: 'all' | { cadetId: string }, text: string) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // the publisher's retry timer must not outlive the test
    try { expect((await master.sendNotice(audience, text)).published).toBe(true) } finally { vi.useRealTimers() }
  }
  /** A phone: a real vault on a memory store, so what it keeps survives a "reload" (unlock again from the stored record). */
  async function phone(cadet: CadetDevice, storage = memoryStorage()) {
    const fresh = await createCadetVault(PASS, storage)
    return { storage, device: await completeCadetRedemption(fresh, cadet, storage) }
  }
  const reload = async (storage: ReturnType<typeof memoryStorage>) => unlockCadetDevice(loadCadetVault(storage)!, PASS)
  const open = (device: UnlockedCadetDevice, storage: ReturnType<typeof memoryStorage>, env = fakeEnvironment()) => {
    render(<CadetApp device={device} api={chain} storage={storage} notificationEnvironment={env.environment} onLeave={() => undefined} />)
    return env
  }
  /** One more poll, waited for: Refresh reads "Refreshing…" until it ends. */
  const refresh = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }))
    await screen.findByRole('button', { name: 'Refreshing…' }).catch(() => undefined)
    await screen.findByRole('button', { name: 'Refresh' }); await act(async () => undefined)
  }
  const notices = () => screen.getByRole('button', { name: /^Notices/ })

  it('a notice to all appears marked New with a badge of 1 and the banner "1 new notice"; opening Notices clears both and the read state survives a reload', async () => {
    await send('all', 'Military ball: bring your SDBs')
    const { device, storage } = await phone(avery)
    const env = open(device, storage)
    expect(await screen.findByText('1 new notice')).toBeInTheDocument()
    expect(within(notices()).getByText('1')).toBeInTheDocument()
    expect(env.shown).toEqual([expect.objectContaining({ title: 'Bethel NJROTC', body: 'Military ball: bring your SDBs' })])

    fireEvent.click(notices())
    expect(screen.getByRole('heading', { name: 'Notices' })).toBeInTheDocument()
    const list = screen.getByRole('list', { name: 'Notices' })
    expect(within(list).getByText('Military ball: bring your SDBs')).toBeInTheDocument()
    expect(within(list).getByText('Chief')).toBeInTheDocument()
    expect(within(list).getByText('New')).toBeInTheDocument()
    expect(screen.queryByText('No notices yet')).toBeNull()
    // Back to My gear: read, so no badge and no banner.
    fireEvent.click(screen.getByRole('button', { name: 'My gear' }))
    expect(screen.queryByText('1 new notice')).toBeNull()
    expect(within(notices()).queryByText('1')).toBeNull()
    await refresh()
    expect(screen.queryByText('1 new notice')).toBeNull()
    expect(env.shown).toHaveLength(1)
    // The phone is "reloaded": a new unlock of the stored vault, a new screen.
    cleanup()
    const again = await reload(storage), second = open(again, storage)
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument()
    await act(async () => undefined)
    expect(screen.queryByText('1 new notice')).toBeNull()
    expect(within(notices()).queryByText('1')).toBeNull()
    fireEvent.click(notices())
    expect(within(screen.getByRole('list', { name: 'Notices' })).getByText('Military ball: bring your SDBs')).toBeInTheDocument()
    expect(screen.queryByText('New')).toBeNull()
    expect(second.shown).toHaveLength(0)
  })

  it('a note to this cadet appears too, a note to another cadet does not, and a second poll does not notify again', async () => {
    await send({ cadetId: avery.cadetId }, 'Come to supply Thursday')
    await send({ cadetId: blake.cadetId }, 'Blake only: your belt is in')
    const { device, storage } = await phone(avery)
    const notify = vi.spyOn(DeviceNotifier.prototype, 'notify')
    const env = open(device, storage)
    await screen.findByText('2 new notices')
    fireEvent.click(notices())
    const list = screen.getByRole('list', { name: 'Notices' })
    expect(within(list).getByText('Come to supply Thursday')).toBeInTheDocument()
    expect(within(list).getByText('Military ball: bring your SDBs')).toBeInTheDocument()
    expect(screen.queryByText(/Blake only/)).toBeNull()
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(env.shown.map(shown => shown.body).sort()).toEqual(['Come to supply Thursday', 'Military ball: bring your SDBs'])
    expect(notify).toHaveBeenCalledTimes(2)
    // Newest first: the note to Avery was sent after the notice to all.
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Come to supply Thursday')
    fireEvent.click(screen.getByRole('button', { name: 'My gear' }))
    await refresh(); await refresh()
    expect(notify).toHaveBeenCalledTimes(2)
    expect(env.shown).toHaveLength(2)
    // Blake's phone sees Blake's note, not Avery's.
    cleanup(); notify.mockRestore()
    const other = await phone(blake)
    open(other.device, other.storage)
    await screen.findByText('2 new notices')
    fireEvent.click(notices())
    expect(screen.getByText('Blake only: your belt is in')).toBeInTheDocument()
    expect(screen.queryByText('Come to supply Thursday')).toBeNull()
  })

  it('a phone with notification permission denied still shows the badge and banner, and shows no device notification', async () => {
    const { device, storage } = await phone(avery)
    const env = open(device, storage, fakeEnvironment('denied'))
    expect(await screen.findByText('2 new notices')).toBeInTheDocument()
    expect(within(notices()).getByText('2')).toBeInTheDocument()
    expect(env.shown).toEqual([])
    // Tapping the banner opens Notices.
    fireEvent.click(screen.getByRole('button', { name: '2 new notices' }))
    expect(screen.getByRole('heading', { name: 'Notices' })).toBeInTheDocument()
  })

  it('says "No notices yet" when there are none', async () => {
    const chainOfNone = new FakeChain()
    const { device, storage } = await phone(avery)
    render(<CadetApp device={device} api={chainOfNone} storage={storage} notificationEnvironment={fakeEnvironment().environment} onLeave={() => undefined} />)
    await screen.findByText(/published your gear yet/)
    expect(within(notices()).queryByText('0')).toBeNull()
    fireEvent.click(notices())
    expect(screen.getByText('No notices yet')).toBeInTheDocument()
  })

  it('keeps nothing readable in the phone’s storage: the notices are sealed in the cadet vault', async () => {
    const { device, storage } = await phone(avery)
    open(device, storage)
    await screen.findByText('2 new notices')
    await waitFor(() => expect(storage.getItem(CADET_VAULT_STORAGE_KEY)).toContain('"notices"'))
    expect([...storage.values.values()].filter(value => /Military ball|Come to supply/.test(value))).toEqual([])
  })
})
