import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../../chain/fakeChain'
import { MemoryWalletStateStore } from '../../chain/walletStore'
import type { ArgusAppProjection } from '../../distributed/appIntegration'
import { joinByTicket, memoryStorage } from '../../test/joinByTicket'
import { MemoryLedgerStore } from '../ledgerStore'
import { UnitRuntime, type IssuedTicket, type UnitStatus } from '../runtime'
import { createMasterDevice } from '../vault'
import { TicketsPanel } from './TicketsPanel'

/** The panel as the app mounts it: the projection follows the runtime. */
function Harness({ runtime, notify = () => undefined }: { runtime: UnitRuntime; notify?: (message: string) => void }) {
  const [projection, setProjection] = useState<ArgusAppProjection>()
  useEffect(() => { void runtime.controller.project().then(setProjection); return runtime.onProjection(setProjection) }, [runtime])
  return projection ? <TicketsPanel runtime={runtime} projection={projection} close={() => undefined} notify={notify} /> : null
}
const roleOptions = () => within(screen.getByLabelText('Role')).getAllByRole('option').map(option => option.textContent)

afterEach(() => { Reflect.deleteProperty(navigator, 'share'); Reflect.deleteProperty(navigator, 'clipboard') })

describe('Tickets panel on real devices over a (fake) BSV testnet chain', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let master: UnitRuntime, instructor: UnitRuntime
  beforeAll(async () => {
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
    master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    instructor = (await joinByTicket(master, chain, 'Lt Jones', 'INSTRUCTOR', { satoshis: 30_000 })).runtime
    await instructor.syncNow(); await master.syncNow(); chain.mine()
  })

  it('a Master makes a cadet ticket: a QR, the code in groups, Copy; it is listed with name, role and days left; Cancel moves it to cancelled', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const notify = vi.fn()
    render(<Harness runtime={master} notify={notify} />)
    expect(await screen.findByRole('dialog', { name: 'Tickets' })).toBeInTheDocument()
    expect(roleOptions()).toEqual(['Supply Assistant', 'Supply Officer', 'Instructor', 'Master'])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chris Cadet' } })
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'SUPPLY_OFFICER' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make ticket' }))

    const qr = await screen.findByRole('img', { name: 'Ticket QR code for Chris Cadet' }, { timeout: 60_000 })
    expect(qr).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/))
    const code = screen.getByLabelText('Ticket code').textContent!
    expect(code).toMatch(/^([0-9A-Z]{5}-){5}[0-9A-Z]{5}$/)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code))
    expect(await screen.findByRole('button', { name: 'Code copied ✓' })).toBeInTheDocument()
    // no share sheet on this browser: no Share button
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()

    const out = screen.getByRole('list', { name: 'Tickets out' })
    const row = within(out).getByText('Chris Cadet').closest('li')!
    expect(row).toHaveTextContent('Supply Officer')
    expect(row).toHaveTextContent('7 days left')
    // the form is empty again, ready for the next person
    expect(screen.getByLabelText('Name')).toHaveValue('')

    await master.syncNow(); chain.mine()
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel ticket for Chris Cadet' }))
    await waitFor(() => expect(within(screen.getByLabelText('Past tickets')).getByText('Chris Cadet').closest('li')).toHaveTextContent('Cancelled'), { timeout: 60_000 })
    expect(screen.queryByRole('list', { name: 'Tickets out' })).toBeNull()
    expect(screen.getByText('No tickets are out.')).toBeInTheDocument()
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('Chris Cadet'))
  })

  it('an Instructor’s role picker offers only the cadet roles, and the Instructor makes a ticket that a Master sees but cannot cancel', async () => {
    const view = render(<Harness runtime={instructor} />)
    await screen.findByRole('dialog', { name: 'Tickets' })
    expect(roleOptions()).toEqual(['Supply Assistant', 'Supply Officer'])
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Eli Eff' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make ticket' }))
    await screen.findByRole('img', { name: 'Ticket QR code for Eli Eff' }, { timeout: 60_000 })
    expect(within(screen.getByRole('list', { name: 'Tickets out' })).getByText('Eli Eff').closest('li')).toHaveTextContent('Supply Assistant')
    view.unmount()

    await instructor.syncNow(); chain.mine(); await master.syncNow()
    render(<Harness runtime={master} />)
    const row = (await within(await screen.findByRole('list', { name: 'Tickets out' })).findByText('Eli Eff')).closest('li')!
    expect(row).toHaveTextContent('Made by Lt Jones')
    expect(within(row).queryByRole('button', { name: /Cancel ticket/ })).toBeNull()
  })

  it('folds tickets that were used, cancelled or have expired, and says when none are out', async () => {
    render(<Harness runtime={master} />)
    const past = await screen.findByLabelText('Past tickets')
    // the two Instructor/Officer joins in set-up were redeemed: shown as used, not as open
    expect(within(past).getByText('Lt Jones').closest('li')).toHaveTextContent('Used')
    expect(past.closest('details')).toHaveTextContent(/Used, cancelled or expired \(\d+\)/)
  })
})

describe('Tickets panel with a stand-in device', () => {
  const issued = (extra: Partial<IssuedTicket> = {}): IssuedTicket => ({ ticketId: 't-1', code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-3456', displayName: 'Dee Dee', role: 'SUPPLY_ASSISTANT', ticketAddress: 'maddr', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt: '2026-10-08T00:00:00.000Z', funding: { txid: 'a'.repeat(64), vout: 0, satoshis: 2000 }, ...extra })
  const status = (extra: Partial<UnitStatus> = {}) => ({ holdsAuthority: true, revoked: false, ...extra }) as UnitStatus
  const fake = (role: string, runtime: Record<string, unknown> = {}, extra: Partial<UnitStatus> = {}) => ({ device: { record: { role, signingIdentity: 'me', displayName: 'Me' } }, status: () => status(extra), ...runtime }) as unknown as UnitRuntime
  const projection = { tickets: [], members: [] } as unknown as ArgusAppProjection
  const panel = (runtime: UnitRuntime, notify = () => undefined) => render(<TicketsPanel runtime={runtime} projection={projection} close={() => undefined} notify={notify} />)

  it('a Master who does not hold the unit authority cannot offer a Master ticket', () => {
    panel(fake('MASTER', {}, { holdsAuthority: false }))
    expect(roleOptions()).toEqual(['Supply Assistant', 'Supply Officer', 'Instructor'])
  })

  it('a Supply Officer is told only a Master or an Instructor makes tickets, and gets no form', () => {
    panel(fake('SUPPLY_OFFICER'))
    expect(screen.getByText('Only a Master or an Instructor can make tickets.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Make ticket' })).toBeNull()
  })

  it('offers Share when the browser has a share sheet, and shares the code with the person’s name', async () => {
    const share = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    panel(fake('MASTER', { issueTicket: vi.fn(async () => issued()) }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Dee Dee' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make ticket' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await waitFor(() => expect(share).toHaveBeenCalledWith({ title: 'A.R.G.U.S. ticket for Dee Dee', text: expect.stringContaining('ABCDE-FGHJK-MNPQR-STVWX-YZ012-3456') }))
  })

  it('shows why a ticket could not be made, in the words the runtime gave, and keeps the name typed', async () => {
    const issueTicket = vi.fn(async () => { throw new Error('This device’s testnet wallet has only 12 spendable satoshis.') })
    panel(fake('MASTER', { issueTicket }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Dee Dee ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make ticket' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('only 12 spendable satoshis')
    expect(issueTicket).toHaveBeenCalledWith('Dee Dee', 'SUPPLY_ASSISTANT')
    expect(screen.getByLabelText('Name')).toHaveValue('  Dee Dee ')
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('counts days with the one-day rule and says nothing is out when the list is empty', () => {
    const open = (ticketId: string, displayName: string, expiresAt: string) => ({ ticketId, displayName, role: 'SUPPLY_OFFICER', status: 'OPEN', issuedBy: 'me', issuedAt: '2026-10-01T00:00:00.000Z', expiresAt })
    const future = new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(), soon = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const view = render(<TicketsPanel runtime={fake('MASTER')} projection={{ tickets: [open('t-1', 'Ann', future), open('t-2', 'Bea', soon)], members: [] } as unknown as ArgusAppProjection} close={() => undefined} notify={() => undefined} />)
    expect(screen.getByText('Ann').closest('li')).toHaveTextContent('2 days left')
    expect(screen.getByText('Bea').closest('li')).toHaveTextContent('1 day left')
    view.unmount()
    panel(fake('MASTER'))
    expect(screen.getByText('No tickets are out.')).toBeInTheDocument()
  })
})
