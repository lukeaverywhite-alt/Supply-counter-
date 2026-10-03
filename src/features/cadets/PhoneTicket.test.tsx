import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import type { IssuedCadetTicket } from '../../unit/runtime'
import { CadetsView } from './CadetsView'
import type { PhoneTicketMaker } from './PhoneTicketPanel'
import { ticketWaiting } from './phoneTicket'

const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2-34567'
async function setup() {
  const controller = new DistributedAppController()
  await controller.initialize()
  const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-4F7K', fullName: 'Avery Private' })
  return { controller, projection, cadetId: projection.cadets[0].cadetId }
}
const issued = (cadetId: string): IssuedCadetTicket => ({ ticketId: 't-0123456789abcdef0123', code: CODE, cadetId, displayName: 'Avery Private', ticketAddress: 'addr', channelAddress: 'chan', issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
function Harness({ controller, initial, toasts, make, replace, phoneLine, send, can = () => true }: { controller: DistributedAppController; initial: ArgusAppProjection; toasts: string[]; make?: PhoneTicketMaker; replace?: PhoneTicketMaker; phoneLine?: (cadetId: string) => Promise<string>; send?: Parameters<typeof CadetsView>[0]['sendNotice']; can?: (permission: ArgusPermission) => boolean }) {
  const [projection, setProjection] = useState(initial)
  return <CadetsView projection={projection} controller={controller} can={can} onProjection={setProjection} notify={message => toasts.push(message)} onIssue={() => undefined} onReturn={() => undefined} {...(make ? { makePhoneTicket: make } : {})} {...(replace ? { replacePhone: replace } : {})} {...(phoneLine ? { phoneLine } : {})} {...(send ? { sendNotice: send } : {})} />
}
const openDrawer = () => { fireEvent.click(screen.getByRole('button', { name: /C-4F7K/ })); return screen.getByRole('dialog', { name: 'C-4F7K' }) }

afterEach(() => { Reflect.deleteProperty(navigator, 'share'); Reflect.deleteProperty(navigator, 'clipboard') })

describe('Make phone ticket in the cadet drawer (mw-kmgi38.13)', () => {
  it('a cadet with no ticket offers Make phone ticket; tapping it shows the code, a QR and Copy, labelled by cadet ID and never the name', async () => {
    const { controller, projection, cadetId } = await setup(), toasts: string[] = []
    const make = vi.fn(async (id: string) => ({ ticket: issued(id), waiting: false }))
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={make} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByText('Phone ticket ready for C-4F7K')).toBeInTheDocument()
    expect(make).toHaveBeenCalledWith(cadetId)
    expect(within(drawer).getByLabelText('Ticket code')).toHaveTextContent(CODE)
    expect(await within(drawer).findByRole('img', { name: 'Ticket QR code for C-4F7K' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE))
    expect(await within(drawer).findByRole('button', { name: 'Code copied ✓' })).toBeInTheDocument()
    expect(toasts).toEqual(['Phone ticket made for C-4F7K.'])
    expect(drawer).not.toHaveTextContent('Avery Private')
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hide' }))
    expect(within(drawer).queryByLabelText('Ticket code')).toBeNull()
  })

  it('a refused ticket (no coins, say) shows the reason and leaves Make phone ticket to try again', async () => {
    const { controller, projection } = await setup()
    const make = vi.fn(async () => { throw new Error('This device does not have enough testnet coins') })
    render(<Harness controller={controller} initial={projection} toasts={[]} make={make} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('not have enough testnet coins')
    expect(within(drawer).getByRole('button', { name: 'Make phone ticket' })).toBeEnabled()
  })

  it('offline, the drawer and the toast say the ticket is saved here and goes out when the network is reachable', async () => {
    const { controller, projection } = await setup(), toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={async id => ({ ticket: issued(id), waiting: true })} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Make phone ticket' }))
    expect(await within(drawer).findByText(/saved on this phone and goes out when the network is reachable/)).toBeInTheDocument()
    expect(toasts[0]).toMatch(/^Phone ticket for C-4F7K is saved on this phone and goes out when the network is reachable/)
  })

  it('shows no Make phone ticket without cadets.admit, or on a screen with no way to make one', async () => {
    const { controller, projection } = await setup()
    const view = render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} can={permission => permission !== 'cadets.admit'} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
    view.unmount()
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    expect(within(openDrawer()).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
  })

  it('a cadet who has a ticket shows when and by whom, no Make phone ticket and no code again; Message this cadet then sends', async () => {
    const { controller, cadetId } = await setup(), toasts: string[] = []
    const send = vi.fn(async () => ({ noticeId: 'n', published: true }))
    await controller.createCadetChannel(cadetId)
    const { channelAddress } = (await controller.technicalState()).cadetChannels[0]
    await controller.recordCadetTicketIssued({ ticketId: 't-0123456789abcdef0123', cadetId, ticketAddress: channelAddress, channelAddress, issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
    const make = vi.fn()
    render(<Harness controller={controller} initial={await controller.project()} toasts={toasts} make={make} send={send} />)
    const drawer = openDrawer()
    expect(await within(drawer).findByText(`Phone ticket made ${new Date('2026-10-03T12:00:00.000Z').toLocaleDateString()} by You`)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
    expect(within(drawer).queryByLabelText('Ticket code')).toBeNull()
    expect(make).not.toHaveBeenCalled()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Message this cadet' }))
    fireEvent.change(within(drawer).getByLabelText('Message to this cadet'), { target: { value: 'Come to supply Thursday' } })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(toasts).toEqual(['Message sent to C-4F7K']))
    expect(send).toHaveBeenCalledWith({ cadetId }, 'Come to supply Thursday')
  })

  it('a ticket waits when the phone is offline, the network errored or the wallet needs coins, and not when synced or syncing', () => {
    expect(ticketWaiting({ state: 'offline' })).toBe(true)
    expect(ticketWaiting({ state: 'error' })).toBe(true)
    expect(ticketWaiting({ state: 'synced', needsFunding: { address: 'a', spendable: 0, needed: 1 } })).toBe(true)
    expect(ticketWaiting({ state: 'synced' })).toBe(false)
    expect(ticketWaiting({ state: 'syncing' })).toBe(false)
  })

  it('staff without cadets.admit still see that a ticket was made, but are offered no way to make one', async () => {
    const { controller, cadetId } = await setup()
    await controller.createCadetChannel(cadetId)
    const { channelAddress } = (await controller.technicalState()).cadetChannels[0]
    await controller.recordCadetTicketIssued({ ticketId: 't-0123456789abcdef0123', cadetId, ticketAddress: channelAddress, channelAddress, issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } })
    render(<Harness controller={controller} initial={await controller.project()} toasts={[]} make={vi.fn()} can={permission => permission !== 'cadets.admit'} />)
    const drawer = openDrawer()
    expect(await within(drawer).findByText(/^Phone ticket made .* by You$/)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Make phone ticket' })).toBeNull()
  })
})

const TICKET = { ticketId: 't-0123456789abcdef0123', issuedAt: '2026-10-03T12:00:00.000Z', expiresAt: '2026-10-10T12:00:00.000Z', funding: { txid: 'f'.repeat(64), vout: 0, satoshis: 1000 } }
async function setupWithTicket() {
  const { controller, cadetId } = await setup()
  await controller.createCadetChannel(cadetId)
  const { channelAddress } = (await controller.technicalState()).cadetChannels[0]
  await controller.recordCadetTicketIssued({ ...TICKET, cadetId, ticketAddress: channelAddress, channelAddress })
  return { controller, cadetId, projection: await controller.project() }
}

describe('Replace phone in the cadet drawer (mw-kmgi38.16)', () => {
  it('offers Replace phone only once the cadet has a ticket, and only with cadets.admit and a way to replace', async () => {
    const fresh = await setup(), replace = vi.fn()
    const view = render(<Harness controller={fresh.controller} initial={fresh.projection} toasts={[]} make={vi.fn()} replace={replace} />)
    const first = openDrawer()
    await within(first).findByRole('button', { name: 'Make phone ticket' })
    expect(within(first).queryByRole('button', { name: 'Replace phone' })).toBeNull()
    view.unmount()
    const { controller, projection } = await setupWithTicket()
    const withTicket = render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} replace={replace} />)
    expect(await within(openDrawer()).findByRole('button', { name: 'Replace phone' })).toBeInTheDocument()
    withTicket.unmount()
    const noRight = render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} replace={replace} can={permission => permission !== 'cadets.admit'} />)
    const drawer = openDrawer()
    await within(drawer).findByText(/^Phone ticket made /)
    expect(within(drawer).queryByRole('button', { name: 'Replace phone' })).toBeNull()
    noRight.unmount()
    render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} />)
    const bare = openDrawer()
    await within(bare).findByText(/^Phone ticket made /)
    expect(within(bare).queryByRole('button', { name: 'Replace phone' })).toBeNull()
  })

  it('asks once, then replaces: the new code and QR show as Make phone ticket does, and the replace function ran once', async () => {
    const { controller, projection, cadetId } = await setupWithTicket(), toasts: string[] = []
    const replace = vi.fn(async (id: string) => ({ ticket: issued(id), waiting: false }))
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={vi.fn()} replace={replace} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Replace phone' }))
    expect(within(drawer).getByText('Replace this cadet\'s phone? The old phone stops getting updates.')).toBeInTheDocument()
    expect(replace).not.toHaveBeenCalled()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Yes, replace phone' }))
    expect(await within(drawer).findByText('Phone ticket ready for C-4F7K')).toBeInTheDocument()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(cadetId)
    expect(within(drawer).getByLabelText('Ticket code')).toHaveTextContent(CODE)
    expect(await within(drawer).findByRole('img', { name: 'Ticket QR code for C-4F7K' })).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/))
    expect(within(drawer).getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(toasts).toEqual(['Phone replaced for C-4F7K. The old phone stops getting updates.'])
    expect(drawer).not.toHaveTextContent('Avery Private')
  })

  it('cancelling the question calls nothing and leaves Replace phone to ask again', async () => {
    const { controller, projection } = await setupWithTicket(), toasts: string[] = []
    const replace = vi.fn()
    render(<Harness controller={controller} initial={projection} toasts={toasts} make={vi.fn()} replace={replace} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Replace phone' }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Keep this phone' }))
    expect(replace).not.toHaveBeenCalled()
    expect(within(drawer).queryByText(/The old phone stops getting updates/)).toBeNull()
    expect(within(drawer).getByRole('button', { name: 'Replace phone' })).toBeEnabled()
    expect(toasts).toEqual([])
  })

  it('a refused replacement shows the reason and the question can be asked again', async () => {
    const { controller, projection } = await setupWithTicket()
    const replace = vi.fn(async () => { throw new Error('This device does not have enough testnet coins') })
    render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} replace={replace} />)
    const drawer = openDrawer()
    fireEvent.click(await within(drawer).findByRole('button', { name: 'Replace phone' }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Yes, replace phone' }))
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('not have enough testnet coins')
    expect(within(drawer).getByRole('button', { name: 'Replace phone' })).toBeEnabled()
  })
})

describe('the drawer\'s phone line (mw-kmgi38.16)', () => {
  it('says No phone yet before the cadet joins and Phone: joined <date> after', async () => {
    const { controller, projection } = await setupWithTicket()
    let line = 'No phone yet'
    const phoneLine = vi.fn(async () => line)
    const first = render(<Harness controller={controller} initial={projection} toasts={[]} phoneLine={phoneLine} />)
    expect(await within(openDrawer()).findByText('No phone yet')).toBeInTheDocument()
    first.unmount()
    line = 'Phone: joined 2026-10-04'
    render(<Harness controller={controller} initial={projection} toasts={[]} phoneLine={phoneLine} />)
    expect(await within(openDrawer()).findByText('Phone: joined 2026-10-04')).toBeInTheDocument()
  })

  it('reads the line again after a replacement, since the new channel has no phone', async () => {
    const { controller, projection } = await setupWithTicket()
    let line = 'Phone: joined 2026-10-04'
    const phoneLine = vi.fn(async () => line)
    const replace = vi.fn(async (id: string) => { line = 'No phone yet'; return { ticket: issued(id), waiting: false } })
    render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} replace={replace} phoneLine={phoneLine} />)
    const drawer = openDrawer()
    expect(await within(drawer).findByText('Phone: joined 2026-10-04')).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Replace phone' }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Yes, replace phone' }))
    expect(await within(drawer).findByText('No phone yet')).toBeInTheDocument()
  })

  it('shows no phone line when the screen cannot read one (the demo)', async () => {
    const { controller, projection } = await setup()
    render(<Harness controller={controller} initial={projection} toasts={[]} make={vi.fn()} />)
    const drawer = openDrawer()
    await within(drawer).findByRole('button', { name: 'Make phone ticket' })
    expect(within(drawer).queryByText(/^Phone: joined|^No phone yet$/)).toBeNull()
  })
})
