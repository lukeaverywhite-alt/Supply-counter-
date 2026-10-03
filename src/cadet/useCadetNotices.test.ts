import { describe, expect, it } from 'vitest'
import { mergeNotices } from './useCadetNotices'

const notice = (noticeId: string, sentAt: string, over = {}) => ({ noticeId, text: `text ${noticeId}`, from: 'Chief', sentAt, ...over })

describe('mergeNotices', () => {
  it('adds only notices not kept before, unread, newest first, and leaves the read state of kept ones', () => {
    const kept = [{ ...notice('a', '2026-10-01T00:00:00.000Z'), readAt: '2026-10-02T00:00:00.000Z' }]
    const { notices, added } = mergeNotices(kept, [notice('a', '2026-10-01T00:00:00.000Z'), notice('b', '2026-10-03T00:00:00.000Z'), notice('c', '2026-10-02T00:00:00.000Z')])
    expect(added.map(entry => entry.noticeId)).toEqual(['b', 'c'])
    expect(notices.map(entry => entry.noticeId)).toEqual(['b', 'c', 'a'])
    expect(notices.find(entry => entry.noticeId === 'a')!.readAt).toBe('2026-10-02T00:00:00.000Z')
    expect(added.every(entry => entry.readAt === undefined)).toBe(true)
  })
  it('finds nothing new when everything read is already kept', () => {
    const kept = [notice('a', '2026-10-01T00:00:00.000Z')]
    expect(mergeNotices(kept, [notice('a', '2026-10-01T00:00:00.000Z')]).added).toEqual([])
  })
})
