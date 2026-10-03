import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import type { NoticeProjection } from '../../distributed/types'
import { NoticesPanel } from './NoticesPanel'

const notice = (noticeId: string, text: string, sentAt: string, sentBy = 'boss', audience: NoticeProjection['audience'] = 'all'): NoticeProjection => ({ noticeId, audience, text, sentBy, sentAt, eventId: `e-${noticeId}` })
// The projection lists newest first.
const projection = (notices: NoticeProjection[]) => ({ notices, cadets: [{ cadetId: 'cadet_1', cadetCode: 'C-4F7K' }] }) as unknown as ArgusAppProjection
const names = (id: string) => ({ boss: 'Chief', me: 'You' })[id] ?? 'Unit member'
const panel = (props: Partial<Parameters<typeof NoticesPanel>[0]> = {}) => render(<NoticesPanel projection={projection([])} memberName={names} canSend send={vi.fn(async () => ({ noticeId: 'n', published: true }))} close={() => undefined} notify={() => undefined} {...props} />)

describe('Notices panel (mw-kmgi38.5)', () => {
  it('has the labels Notices, Notice to all cadets, Send and Sent notices', () => {
    panel()
    expect(screen.getByRole('dialog', { name: 'Notices' })).toBeInTheDocument()
    expect(screen.getByLabelText('Notice to all cadets')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sent notices' })).toBeInTheDocument()
    expect(screen.getByText('No notices have been sent.')).toBeInTheDocument()
  })

  it('sends the text to all cadets, clears the box and says Notice sent', async () => {
    const send = vi.fn(async () => ({ noticeId: 'n', published: true })), notify = vi.fn()
    panel({ send, notify })
    fireEvent.change(screen.getByLabelText('Notice to all cadets'), { target: { value: '  Military ball: bring your SDBs ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Notice sent'))
    expect(send).toHaveBeenCalledWith('all', 'Military ball: bring your SDBs')
    expect(screen.getByLabelText('Notice to all cadets')).toHaveValue('')
  })

  it('says so when the notice is saved but the network has not taken it yet', async () => {
    const notify = vi.fn()
    panel({ send: vi.fn(async () => ({ noticeId: 'n', published: false })), notify })
    fireEvent.change(screen.getByLabelText('Notice to all cadets'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Notice saved. It goes out to cadets when the network is reachable.'))
  })

  it('shows a refusal in words, for example text over 500 characters, and keeps the text', async () => {
    const send = vi.fn(async () => { throw new Error('A notice can be at most 500 characters.') }), notify = vi.fn()
    panel({ send, notify })
    fireEvent.change(screen.getByLabelText('Notice to all cadets'), { target: { value: 'x'.repeat(501) } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A notice can be at most 500 characters.')
    expect(notify).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Notice to all cadets')).toHaveValue('x'.repeat(501))
  })

  it('hides the box and Send for a role without notices.send, and still lists what was sent', () => {
    panel({ canSend: false, projection: projection([notice('n1', 'Military ball', '2026-10-03T12:00:00.000Z')]) })
    expect(screen.queryByLabelText('Notice to all cadets')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    expect(screen.getByText('Only a Master, an Instructor or a Supply Officer can send notices.')).toBeInTheDocument()
    expect(within(screen.getByRole('list', { name: 'Sent notices' })).getByText('Military ball')).toBeInTheDocument()
  })

  it('lists sent notices in the order given (newest first) with sender, time and audience', () => {
    panel({ projection: projection([notice('n2', 'Come to supply Thursday', '2026-10-04T15:30:00.000Z', 'me', { cadetId: 'cadet_1' }), notice('n1', 'Military ball: bring your SDBs', '2026-10-03T12:00:00.000Z')]) })
    const items = within(screen.getByRole('list', { name: 'Sent notices' })).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Come to supply Thursday')
    expect(items[0]).toHaveTextContent('You')
    expect(items[0]).toHaveTextContent('To cadet C-4F7K')
    expect(items[0]).toHaveTextContent(new Date('2026-10-04T15:30:00.000Z').toLocaleString())
    expect(items[1]).toHaveTextContent('Military ball: bring your SDBs')
    expect(items[1]).toHaveTextContent('Chief')
    expect(items[1]).toHaveTextContent('To all cadets')
  })
})
