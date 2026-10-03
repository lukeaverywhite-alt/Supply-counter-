import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeviceNotifier } from '../notifications/notifier'
import type { NoticeRecord } from '../unit/cadetPublisher'
import { loadCadetNotices, saveCadetNotices, type StoredNotice, type UnlockedCadetDevice } from '../unit/vault'

/** Newest first; of equal times, by ID so every phone orders alike. */
const newestFirst = (a: StoredNotice, b: StoredNotice) => b.sentAt.localeCompare(a.sentAt) || a.noticeId.localeCompare(b.noticeId)

/** Adds the notices this phone has not kept before, unread; the ones it has are left as they are (read state included). */
export function mergeNotices(kept: readonly StoredNotice[], read: readonly NoticeRecord[]): { notices: StoredNotice[]; added: StoredNotice[] } {
  const have = new Set(kept.map(notice => notice.noticeId)), added: StoredNotice[] = []
  for (const notice of read) if (!have.has(notice.noticeId)) { have.add(notice.noticeId); added.push({ noticeId: notice.noticeId, text: notice.text, from: notice.from, sentAt: notice.sentAt }) }
  return { notices: [...kept, ...added].sort(newestFirst), added: added.sort(newestFirst) }
}

export type CadetNotices = { notices: StoredNotice[]; unread: number; markAllRead: () => void }

/**
 * The notices this phone keeps (sealed in the cadet vault, so read state survives a reload) and what a poll found. Each notice the phone
 * sees for the first time is kept unread and handed to the device notifier once; one it already keeps never is again. Saving is best
 * effort: a phone that cannot save shows the notices as unread again after a reload, nothing worse.
 */
export function useCadetNotices(device: UnlockedCadetDevice, storage: Pick<Storage, 'getItem' | 'setItem'>, found: readonly NoticeRecord[] | undefined, notifier: DeviceNotifier, unitName: string): CadetNotices {
  const [kept, setKept] = useState<StoredNotice[] | undefined>()
  const latest = useRef<StoredNotice[]>([]), saving = useRef<Promise<void>>(Promise.resolve())
  const commit = useCallback((next: StoredNotice[]) => {
    latest.current = next; setKept(next)
    saving.current = saving.current.then(() => saveCadetNotices(device, next, storage)).catch(() => undefined)
  }, [device, storage])
  useEffect(() => { let alive = true; void loadCadetNotices(device).catch(() => []).then(loaded => { if (alive) { latest.current = loaded; setKept(loaded) } }); return () => { alive = false } }, [device])
  const ready = kept !== undefined
  useEffect(() => {
    if (!ready || !found) return
    const { notices, added } = mergeNotices(latest.current, found)
    if (!added.length) return
    commit(notices)
    for (const notice of added) notifier.notify({ id: `notice:${notice.noticeId}`, title: unitName, body: notice.text })
  }, [ready, found, notifier, unitName, commit])
  const markAllRead = useCallback(() => {
    if (!latest.current.some(notice => !notice.readAt)) return
    const readAt = new Date().toISOString()
    commit(latest.current.map(notice => notice.readAt ? notice : { ...notice, readAt }))
  }, [commit])
  const notices = useMemo(() => kept ?? [], [kept])
  return { notices, unread: notices.filter(notice => !notice.readAt).length, markAllRead }
}
