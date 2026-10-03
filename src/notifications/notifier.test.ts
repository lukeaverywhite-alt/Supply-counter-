import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DistributedAppController } from '../distributed/appIntegration'
import type { SupplyAlert } from '../stage3/readiness'
import type { ClosedAppSummary } from './policy'
import { DAY, HOUR, MINUTE } from './policy'
import type { DeviceNotification, NotificationEnvironment } from './environment'
import { DeviceNotifier, HISTORY_KEY, NotificationHistoryStore } from './notifier'
import { deliverNotificationOpen, resetNotificationRouting } from './routing'
import { useDeviceNotifications, type DeviceNotificationOptions } from './useDeviceNotifications'

const NOW = new Date(2026, 8, 27, 14, 30).getTime()
const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), values } }

function fakeEnvironment(overrides: Partial<NotificationEnvironment> = {}) {
  const shown: DeviceNotification[] = [], closed: string[][] = [], summaries: Array<ClosedAppSummary | undefined> = []
  let visible = true
  const environment: NotificationEnvironment = {
    permission: () => 'granted',
    requestPermission: async () => 'granted',
    visible: () => visible,
    platform: () => ({ ios: false, standalone: false }),
    show: async notification => { shown.push(notification); return true },
    close: async tags => { closed.push([...tags]) },
    closedAppSupport: async () => 'available',
    setClosedAppChecks: async enabled => enabled,
    writeSummary: async summary => { summaries.push(summary) },
    ...overrides,
  }
  return { environment, shown, closed, summaries, setVisible: (value: boolean) => { visible = value } }
}

const outOfStock: SupplyAlert = { id: 'out-of-stock', severity: 'critical', title: '2 sizes out of stock', detail: 'PT Shorts · M, PT Shirt · L', target: { tab: 'inventory' }, fingerprint: 'test' }
const emptyCalendar = { calendar: [] }

afterEach(() => resetNotificationRouting())

describe('DeviceNotifier', () => {
  it('shows one generic notification for a condition that arises in a background tab, then withdraws it when the app is opened', () => {
    const fake = fakeEnvironment(), storage = memoryStorage()
    const notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(storage))
    notifier.evaluate({ alerts: [], projection: emptyCalendar, now: NOW })
    fake.setVisible(false)
    notifier.evaluate({ alerts: [], projection: emptyCalendar, now: NOW + MINUTE })
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + 2 * MINUTE })
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + 3 * MINUTE })
    expect(fake.shown).toEqual([{ tag: 'out-of-stock', title: 'A.R.G.U.S.: sizes out of stock', body: '2 stocked sizes out of stock while cadets hold that size. Open A.R.G.U.S. to see Inventory.', alertId: 'out-of-stock', target: { tab: 'inventory' } }])
    const stored = storage.values.get(HISTORY_KEY)!
    expect(stored).toContain('out-of-stock')
    expect(stored).not.toMatch(/PT Shorts|sizes out of stock/)

    fake.setVisible(true)
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + HOUR })
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + HOUR + MINUTE })
    expect(fake.closed).toEqual([['out-of-stock']])
  })

  it('does not treat what was on screen when the person left as news', () => {
    const fake = fakeEnvironment()
    const notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(memoryStorage()))
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW })
    fake.setVisible(false)
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + MINUTE })
    notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + 2 * DAY })
    expect(fake.shown).toEqual([])
  })

  it('remembers what it showed across reloads, so a reopened tab does not repeat it', () => {
    const storage = memoryStorage(), first = fakeEnvironment()
    first.setVisible(false)
    const seen = new NotificationHistoryStore(storage)
    seen.save({ lastOpenedAt: NOW - HOUR, raised: {}, notified: {} })
    new DeviceNotifier(first.environment, seen).evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW })
    expect(first.shown).toHaveLength(1)
    const second = fakeEnvironment()
    second.setVisible(false)
    new DeviceNotifier(second.environment, new NotificationHistoryStore(storage)).evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW + 2 * HOUR })
    expect(second.shown).toEqual([])
  })

  it('does nothing without notification permission', () => {
    const fake = fakeEnvironment({ permission: () => 'denied' })
    fake.setVisible(false)
    const notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(memoryStorage()))
    expect(notifier.evaluate({ alerts: [outOfStock], projection: emptyCalendar, now: NOW })).toBeUndefined()
    expect(fake.shown).toEqual([])
  })

  it('keeps a closed-app summary only while closed-app checks are registered, and deletes it when turned off', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(NOW + 10 * DAY).toISOString() })
    const fake = fakeEnvironment()
    const notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(memoryStorage()))
    expect(await notifier.setEnabled(true)).toBe(true)
    notifier.evaluate({ alerts: [], projection, now: NOW })
    notifier.evaluate({ alerts: [], projection, now: NOW + MINUTE })
    expect(fake.summaries).toHaveLength(1)
    expect(fake.summaries[0]!.items.map(item => item.label)).toEqual(Array(6).fill('AMI preparation task'))
    fake.setVisible(false)
    notifier.evaluate({ alerts: [], projection, now: NOW + 2 * MINUTE })
    expect(fake.summaries).toHaveLength(2)
    expect(fake.summaries[1]!.lastOpenedAt).toBe(NOW + 2 * MINUTE)
    await notifier.setEnabled(false)
    expect(fake.summaries.at(-1)).toBeUndefined()

    const unsupported = fakeEnvironment({ setClosedAppChecks: async () => false })
    const plain = new DeviceNotifier(unsupported.environment, new NotificationHistoryStore(memoryStorage()))
    expect(await plain.setEnabled(true)).toBe(false)
    plain.evaluate({ alerts: [], projection, now: NOW })
    expect(unsupported.summaries).toEqual([])
  })
})

describe('useDeviceNotifications', () => {
  it('notifies for an event that falls behind while the tab is hidden, and routes a notification click to its target', async () => {
    const controller = new DistributedAppController()
    const quiet = await controller.initialize()
    const fake = fakeEnvironment()
    const onOpen = vi.fn()
    let clock = NOW
    const props: DeviceNotificationOptions = { enabled: true, projection: quiet, onOpen, environment: fake.environment, storage: memoryStorage(), clock: () => clock }
    const { rerender } = renderHook(options => useDeviceNotifications(options), { initialProps: props })
    await act(async () => { await Promise.resolve() })
    act(() => {
      fake.setVisible(false)
      clock += MINUTE
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const behind = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(NOW + 2 * DAY).toISOString() })
    clock += MINUTE
    rerender({ ...props, projection: behind })
    expect(fake.shown).toHaveLength(1)
    expect(fake.shown[0]).toMatchObject({ title: 'A.R.G.U.S.: AMI in 2 days — 5 preparation tasks overdue', target: { tab: 'calendar' } })

    act(() => deliverNotificationOpen({ alertId: fake.shown[0].tag, target: { tab: 'calendar' } }))
    expect(onOpen).toHaveBeenCalledWith({ tab: 'calendar' })
    expect(fake.closed.at(-1)).toEqual([fake.shown[0].tag])
  })

  it('stays silent and removes closed-app checks while the setting is off', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    const projection = await controller.createCalendarEvent({ kind: 'AMI', startsAt: new Date(Date.now() + 2 * DAY).toISOString() })
    const setClosedAppChecks = vi.fn(async (enabled: boolean) => enabled)
    const fake = fakeEnvironment({ setClosedAppChecks })
    fake.setVisible(false)
    renderHook(() => useDeviceNotifications({ enabled: false, projection, onOpen: () => undefined, environment: fake.environment, storage: memoryStorage() }))
    await act(async () => { await Promise.resolve() })
    expect(fake.shown).toEqual([])
    expect(setClosedAppChecks).toHaveBeenCalledWith(false)
    expect(fake.summaries).toEqual([undefined])
  })
})

describe('DeviceNotifier.notify (a cadet’s new notice, mw-kmgi38.6)', () => {
  const notice = { id: 'notice:n1', title: 'Bethel NJROTC', body: 'Military ball: bring your SDBs' }
  it('shows one notification with the unit as title and the text as body, and never a second for the same id', () => {
    const fake = fakeEnvironment(), notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(memoryStorage()))
    expect(notifier.notify(notice)).toBe(true)
    expect(notifier.notify(notice)).toBe(false)
    expect(notifier.notify({ ...notice, id: 'notice:n2', body: 'Another' })).toBe(true)
    expect(fake.shown).toEqual([{ tag: 'notice:n1', title: 'Bethel NJROTC', body: 'Military ball: bring your SDBs' }, { tag: 'notice:n2', title: 'Bethel NJROTC', body: 'Another' }])
  })
  it('shows nothing unless notifications are allowed', () => {
    for (const permission of ['denied', 'default', 'unsupported'] as const) {
      const fake = fakeEnvironment({ permission: () => permission }), notifier = new DeviceNotifier(fake.environment, new NotificationHistoryStore(memoryStorage()))
      expect(notifier.notify(notice)).toBe(false)
      expect(fake.shown).toEqual([])
    }
  })
})
