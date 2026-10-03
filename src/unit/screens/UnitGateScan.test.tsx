import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FakeChain } from '../../chain/fakeChain'
import { MemoryWalletStateStore } from '../../chain/walletStore'
import { installFakePictures, phonePhoto, pictureFile, ticketQrRaster } from '../../test/qrPhoto'
import { memoryStorage } from '../../test/joinByTicket'
import { MemoryLedgerStore } from '../ledgerStore'
import { UnitRuntime } from '../runtime'
import { createMasterDevice } from '../vault'
import { UnitGate } from './UnitGate'

// Unlike UnitGate.test.tsx, the QR reader here is the real one: only the browser's picture and canvas are stood in for.
describe('the identity gate reads a photographed ticket QR end to end', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let master: UnitRuntime, code: string, remove: () => void
  beforeAll(async () => {
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 400_000, { confirmed: true })
    master = await UnitRuntime.open(device, { api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    code = (await master.issueTicket('Quinn Scanner', 'SUPPLY_OFFICER')).code
    await master.syncNow(); chain.mine()
  })
  beforeEach(() => { remove = installFakePictures() })
  afterEach(() => remove())

  const gate = () => render(<UnitGate runtimeOptions={{ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() }} storage={memoryStorage()}>{runtime => <p>In as {runtime.device.record.displayName}, {runtime.device.record.role}</p>}</UnitGate>)
  const pick = async (file: File) => {
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.change(screen.getByLabelText('Ticket QR image'), { target: { files: [file] } })
  }

  it('a photo of the QR on the Master’s screen fills in the code, shows who the ticket is for, and joins', async () => {
    gate()
    await pick(pictureFile(phonePhoto(await ticketQrRaster(code), 3200)))
    expect(await screen.findByText('Ticket for Quinn Scanner', {}, { timeout: 90_000 })).toBeInTheDocument()
    expect(screen.getByLabelText('Ticket code')).toHaveValue(code)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'scanner pass 31' } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'scanner pass 31' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByText('In as Quinn Scanner, SUPPLY_OFFICER', {}, { timeout: 120_000 })).toBeInTheDocument()
  })

  it('a picture with no QR in it gives the plain refusal', async () => {
    gate()
    await pick(pictureFile({ width: 2400, height: 1800, data: new Uint8ClampedArray(2400 * 1800 * 4).fill(180) }, 'wall.jpg'))
    expect(await screen.findByRole('alert')).toHaveTextContent('No QR code was found in that image. Try a clearer, closer picture.')
  })
})
