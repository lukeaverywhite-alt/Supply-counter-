import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CadetsView } from './CadetsView'

async function setup() {
  const controller = new DistributedAppController()
  await controller.initialize()
  const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-4F7K', fullName: 'Avery Private' })
  return { controller, projection, cadetId: projection.cadets[0].cadetId }
}
function Harness({ controller, initial, toasts, send, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; send?: Parameters<typeof CadetsView>[0]['sendNotice']; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return <CadetsView projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} onIssue={() => undefined} onReturn={() => undefined} {...(send ? { sendNotice: send } : {})} />
}
const openDrawer = () => { fireEvent.click(screen.getByRole('button', { name: /C-4F7K/ })); return screen.getByRole('dialog', { name: 'C-4F7K' }) }

describe('Message this cadet (mw-kmgi38.5)', () => {
  it('a cadet without a channel shows This cadet has no phone yet and offers no send', async () => {
    const { controller, projection } = await setup(), send = vi.fn()
    render(<Harness controller={controller} initial={projection} toasts={[]} send={send} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Message this cadet' }))
    expect(within(drawer).getByText('This cadet has no phone yet')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Send' })).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('a cadet with a channel gets the text sent to them alone and the toast Message sent to <code>', async () => {
    const { controller, projection, cadetId } = await setup(), send = vi.fn(async () => ({ noticeId: 'n', published: true })), toasts: string[] = []
    await controller.createCadetChannel(cadetId)
    render(<Harness controller={controller} initial={projection} toasts={toasts} send={send} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Message this cadet' }))
    fireEvent.change(within(drawer).getByLabelText('Message to this cadet'), { target: { value: 'Come to supply Thursday' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(toasts).toEqual(['Message sent to C-4F7K']))
    expect(send).toHaveBeenCalledWith({ cadetId }, 'Come to supply Thursday')
  })

  it('shows no Message action without notices.send, or on a screen with no way to send', async () => {
    const { controller, projection, cadetId } = await setup()
    await controller.createCadetChannel(cadetId)
    const view = render(<Harness controller={controller} initial={projection} toasts={[]} send={vi.fn()} can={permission => permission !== 'notices.send'} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Message this cadet' })).toBeNull()
    view.unmount()
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Message this cadet' })).toBeNull()
  })
})
