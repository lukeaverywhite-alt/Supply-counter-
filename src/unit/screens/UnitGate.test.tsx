import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FakeChain } from '../../chain/fakeChain'
import { MemoryWalletStateStore } from '../../chain/walletStore'
import { memoryStorage } from '../../test/joinByTicket'
import { MemoryLedgerStore } from '../ledgerStore'
import { UnitRuntime } from '../runtime'
import { loadDeviceVault, createMasterDevice } from '../vault'
import * as ticketQr from '../ticketQr'
import { UnitGate } from './UnitGate'

vi.mock('../ticketQr', async importOriginal => ({ ...(await importOriginal<typeof import('../ticketQr')>()), ticketCodeFromQrImage: vi.fn() }))

const PASS = 'cadet locker 9'
const spaced = (code: string) => `  ${code.toLowerCase().replaceAll('-', ' ')}  `

describe('the identity gate: I have a ticket', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let master: UnitRuntime
  const codes = {} as Record<'open' | 'cancelled' | 'scanned', string>
  const options = () => ({ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() })
  beforeAll(async () => {
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
    master = await UnitRuntime.open(device, { ...options(), storage: memoryStorage() })
    for (const [key, name] of [['open', 'Pat Cadet'], ['cancelled', 'Cy Cancelled'], ['scanned', 'Sam Scanned']] as const) codes[key] = (await master.issueTicket(name, 'SUPPLY_OFFICER')).code
    await master.syncNow(); chain.mine()
    const cancelled = await master.tickets(), id = cancelled.find(entry => entry.displayName === 'Cy Cancelled')!.ticketId
    await master.cancelTicket(id); await master.syncNow(); chain.mine()
  })

  const gate = (storage = memoryStorage()) => {
    render(<UnitGate runtimeOptions={options()} storage={storage}>{runtime => <p>In as {runtime.device.record.displayName}, {runtime.device.record.role}</p>}</UnitGate>)
    return storage
  }
  const enterCode = async (code: string) => {
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.change(screen.getByLabelText('Ticket code'), { target: { value: code } })
    fireEvent.click(screen.getByRole('button', { name: 'Check ticket' }))
  }

  it('offers a ticket and no join code: the old Join my unit path and the admission code are gone', async () => {
    gate()
    expect(await screen.findByRole('button', { name: /I have a ticket/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Create a new unit/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Join my unit/ })).toBeNull()
    expect(screen.queryByLabelText(/Admission code|join code/i)).toBeNull()
  })

  it('accepts a typed code with spaces and lower case and shows who it is for before anything is made', async () => {
    gate()
    await enterCode(spaced(codes.open))
    expect(await screen.findByText('Ticket for Pat Cadet')).toBeInTheDocument()
    expect(screen.getByText(/Supply Officer · Bethel NJROTC · made by Chief/)).toBeInTheDocument()
    // checking spent nothing and kept nothing on this device
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows "This ticket was cancelled." word for word for a cancelled ticket, and keeps nothing on the device', async () => {
    const storage = gate()
    await enterCode(spaced(codes.cancelled))
    expect(await screen.findByRole('alert')).toHaveTextContent('This ticket was cancelled.')
    expect(loadDeviceVault(storage)).toBeUndefined()
  })

  it('says in plain words when what was typed is not a ticket code', async () => {
    gate()
    await enterCode('https://example.com/join, not a ticket!')
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not a ticket code.')
  })

  it('reads a ticket from a QR picture too', async () => {
    vi.mocked(ticketQr.ticketCodeFromQrImage).mockResolvedValueOnce(codes.scanned)
    gate()
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.change(screen.getByLabelText('Ticket QR image'), { target: { files: [new File(['x'], 'qr.png', { type: 'image/png' })] } })
    expect(await screen.findByText('Ticket for Sam Scanned')).toBeInTheDocument()
    expect(screen.getByLabelText('Ticket code')).toHaveValue(codes.scanned)
  })

  it('tells the person when the picture holds no QR, and lets them type instead', async () => {
    vi.mocked(ticketQr.ticketCodeFromQrImage).mockRejectedValueOnce(new Error('No QR code was found in that image. Try a clearer, closer picture.'))
    gate()
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.change(screen.getByLabelText('Ticket QR image'), { target: { files: [new File(['x'], 'qr.png', { type: 'image/png' })] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('No QR code was found in that image.')
    expect(screen.getByLabelText('Ticket code')).toBeInTheDocument()
  })

  it('joins with the ticket: the device is in with the ticket’s name and role, and the same ticket is then refused as used', async () => {
    const storage = gate()
    await enterCode(codes.open)
    await screen.findByText('Ticket for Pat Cadet')
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'different pass 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The passphrases do not match.')
    expect(loadDeviceVault(storage)).toBeUndefined()
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByText('In as Pat Cadet, SUPPLY_OFFICER', {}, { timeout: 120_000 })).toBeInTheDocument()
    expect(loadDeviceVault(storage)).toMatchObject({ role: 'SUPPLY_OFFICER', displayName: 'Pat Cadet', unit: { unitName: 'Bethel NJROTC' } })

    document.body.innerHTML = ''
    const second = gate()
    await enterCode(codes.open)
    expect(await screen.findByRole('alert')).toHaveTextContent('This ticket was already used on another device.')
    expect(loadDeviceVault(second)).toBeUndefined()
  })

  it('keeps a redemption the network has not answered, says so, and finishes it with Try again', async () => {
    const code = (await master.issueTicket('Pia Pending', 'SUPPLY_ASSISTANT')).code
    await master.syncNow(); chain.mine()
    const storage = gate()
    await enterCode(code)
    await screen.findByText('Ticket for Pia Pending')
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    chain.failNextBroadcasts('ambiguous', 50)
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByText('Finishing joining', {}, { timeout: 120_000 })).toBeInTheDocument()
    expect(loadDeviceVault(storage)).toMatchObject({ role: 'PENDING', displayName: 'Pia Pending' })
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Still waiting for the network. Try again in a moment.')).toBeInTheDocument()
    chain.clearInjectedFailures()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('In as Pia Pending, SUPPLY_ASSISTANT', {}, { timeout: 120_000 })).toBeInTheDocument()
    expect(loadDeviceVault(storage)).toMatchObject({ role: 'SUPPLY_ASSISTANT', unit: { unitName: 'Bethel NJROTC' } })
  })

  it('goes back to the first screen from the ticket entry', async () => {
    gate()
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Create a new unit/ })).toBeInTheDocument())
  })
})
