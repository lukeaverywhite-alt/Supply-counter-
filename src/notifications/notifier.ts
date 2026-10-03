import type { ArgusAppProjection } from '../distributed/appIntegration'
import { browserNotificationEnvironment, type NotificationEnvironment } from './environment'
import {
  MINUTE,
  acknowledgedIds,
  closedAppSummary,
  emptyHistory,
  markOpened,
  planDeviceNotifications,
  type AlertInput,
  type NotificationHistory,
  type PolicyDecision,
} from './policy'

export const HISTORY_KEY = 'argus.notifications.v1'
type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Device-local notification history in localStorage: alert ids, hashes and times only. */
export class NotificationHistoryStore {
  constructor(private readonly storage: KeyValueStorage | undefined = globalThis.localStorage) {}
  load(): NotificationHistory {
    try {
      const parsed = JSON.parse(this.storage?.getItem(HISTORY_KEY) ?? 'null') as Partial<NotificationHistory> | null
      if (!parsed || typeof parsed !== 'object') return emptyHistory()
      const numbers = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {}).filter(([, at]) => typeof at === 'number')) as Record<string, number>
      const raised = Object.fromEntries(Object.entries(parsed.raised && typeof parsed.raised === 'object' ? parsed.raised : {})
        .filter(([, entry]) => entry && typeof entry.fingerprint === 'string' && typeof entry.raisedAt === 'number'))
      return { ...(typeof parsed.lastOpenedAt === 'number' ? { lastOpenedAt: parsed.lastOpenedAt } : {}), raised, notified: numbers(parsed.notified) }
    } catch { return emptyHistory() }
  }
  save(history: NotificationHistory) { try { this.storage?.setItem(HISTORY_KEY, JSON.stringify(history)) } catch { /* storage full or blocked */ } }
}

const SUMMARY_REFRESH_MS = 10 * MINUTE

/**
 * Applies the policy against a real (or fake) browser: persists history, shows and withdraws
 * notifications, and keeps the closed-app summary current while closed-app checks are registered.
 */
export class DeviceNotifier {
  private history: NotificationHistory
  private savedStructure = ''
  private savedOpenedAt = 0
  private readonly withdrawn = new Set<string>()
  private wasVisible: boolean
  private closedAppChecks = false
  private summaryItems = ''
  private summaryWrittenAt = 0
  private readonly announced = new Set<string>()

  constructor(private readonly environment: NotificationEnvironment = browserNotificationEnvironment, private readonly store = new NotificationHistoryStore()) {
    this.history = store.load()
    this.remember(this.history)
    this.wasVisible = environment.visible()
  }

  /** Turns the feature on (registering closed-app checks where supported) or off (removing them and the summary). */
  async setEnabled(enabled: boolean) {
    if (enabled) { this.closedAppChecks = await this.environment.setClosedAppChecks(true); return this.closedAppChecks }
    this.closedAppChecks = false
    this.summaryItems = ''
    await this.environment.setClosedAppChecks(false)
    await this.environment.writeSummary(undefined)
    return false
  }

  evaluate(input: { alerts: readonly AlertInput[]; projection: Pick<ArgusAppProjection, 'calendar'>; now: number; acknowledged?: ReadonlySet<string> }): PolicyDecision | undefined {
    if (this.environment.permission() !== 'granted') return undefined
    const visible = this.environment.visible()
    // Leaving the screen counts as having just seen everything that is on it.
    const leaving = this.wasVisible && !visible
    if (leaving) this.history = markOpened(this.history, input.now)
    this.wasVisible = visible
    const decision = planDeviceNotifications({ ...input, visible, history: this.history })
    this.commit(decision.history)
    for (const candidate of decision.notify) {
      this.withdrawn.delete(candidate.id)
      void this.environment.show({ tag: candidate.id, title: candidate.title, body: candidate.body, alertId: candidate.id, target: candidate.target })
    }
    const close = decision.withdraw.filter(tag => !this.withdrawn.has(tag))
    for (const tag of close) this.withdrawn.add(tag)
    if (close.length) void this.environment.close(close)
    this.refreshSummary(input.projection, input.now, acknowledgedIds(input.alerts, input.acknowledged), leaving)
    return decision
  }

  /**
   * One device notification for something that is not a supply alert (a cadet's new notice, mw-kmgi38.6), while the app is open.
   * Never twice for the same id in this session; nothing at all unless the person has allowed notifications. Returns whether it was shown.
   */
  notify(notice: { id: string; title: string; body: string }): boolean {
    if (this.environment.permission() !== 'granted' || this.announced.has(notice.id)) return false
    this.announced.add(notice.id)
    void this.environment.show({ tag: notice.id, title: notice.title, body: notice.body })
    return true
  }

  /** The person opened A.R.G.U.S. from a notification: stop escalating and clear what is showing. */
  markOpened(tag: string, now: number) {
    this.commit(markOpened(this.history, now))
    this.withdrawn.add(tag)
    void this.environment.close([tag])
  }

  private refreshSummary(projection: Pick<ArgusAppProjection, 'calendar'>, now: number, acknowledged: ReadonlySet<string>, force: boolean) {
    if (!this.closedAppChecks) return
    const summary = closedAppSummary(projection, now, this.history.lastOpenedAt ?? now, acknowledged)
    const items = JSON.stringify(summary.items)
    if (!force && items === this.summaryItems && now - this.summaryWrittenAt < SUMMARY_REFRESH_MS) return
    this.summaryItems = items
    this.summaryWrittenAt = now
    void this.environment.writeSummary(summary)
  }

  /** Persists only real changes; the "last opened" time alone is written at most once a minute. */
  private commit(history: NotificationHistory) {
    this.history = history
    const structure = JSON.stringify({ raised: history.raised, notified: history.notified })
    const openedAt = history.lastOpenedAt ?? 0
    if (structure === this.savedStructure && openedAt - this.savedOpenedAt < MINUTE) return
    this.store.save(history)
    this.remember(history)
  }

  private remember(history: NotificationHistory) {
    this.savedStructure = JSON.stringify({ raised: history.raised, notified: history.notified })
    this.savedOpenedAt = history.lastOpenedAt ?? 0
  }
}
