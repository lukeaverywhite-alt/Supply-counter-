import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FakeChain } from '../../chain/fakeChain'
import { MemoryWalletStateStore } from '../../chain/walletStore'
import { memoryStorage } from '../../test/joinByTicket'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { MemoryLedgerStore } from '../ledgerStore'
import { UnitRuntime } from '../runtime'
import { CADET_VAULT_STORAGE_KEY, DEVICE_VAULT_STORAGE_KEY, createMasterDevice, loadCadetVault } from '../vault'
import { UnitGate } from './UnitGate'

const PASS = 'cadet locker 9'
const SHIRT = GENESIS_CATALOG.find(item => item.name === 'Gold PT Shirt')!.catalogId

describe('the gate: a cadet ticket opens cadet mode (mw-kmgi38.4)', { timeout: 240_000 }, () => {
  const chain = new FakeChain()
  let master: UnitRuntime, cadetId: string, code: string, reopenCode: string, mismatchCode: string, staffCode: string, shirts: string
  const options = () => ({ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore() })
  afterEach(() => { cleanup() })
  beforeAll(async () => {
    const device = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(device.record.walletAddress, 600_000, { confirmed: true })
    master = await UnitRuntime.open(device, { ...options(), storage: memoryStorage() })
    cadetId = (await master.controller.createCadet({ gender: 'Female', nsLevel: 'NS2', status: 'ACTIVE', fullName: 'Avery Private', cadetCode: 'C-4F7K' })).cadets[0].cadetId
    await master.controller.addCatalogSizes(SHIRT, ['M'])
    shirts = (await master.controller.project()).inventory.find(item => item.catalogId === SHIRT)!.entityId
    await master.controller.receiveStock(shirts, 10, 'Shipment')
    code = (await master.issueCadetTicket(cadetId)).code
    for (const [name, cadetCode] of [['Blake Reopen', 'C-9J2Q'], ['Casey Mismatch', 'C-7M3R']]) {
      const id = (await master.controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', fullName: name, cadetCode })).cadets.find(cadet => cadet.fullName === name)!.cadetId
      const issued = (await master.issueCadetTicket(id)).code
      if (name === 'Blake Reopen') reopenCode = issued; else mismatchCode = issued
    }
    staffCode = (await master.issueTicket('Pat Officer', 'SUPPLY_OFFICER')).code
    await master.syncNow(); chain.mine()
    await master.controller.issueTransaction({ transactionId: 'issue-1', cadetId, lines: [{ lineId: 'l', itemId: shirts, quantity: 2 }] })
    await master.publishAllCadetRecords(); chain.mine()
  })

  const gate = (storage = memoryStorage()) => {
    render(<UnitGate runtimeOptions={options()} storage={storage}>{runtime => <p>Staff app: {runtime.device.record.displayName}</p>}</UnitGate>)
    return storage
  }
  const enterCode = async (text: string) => {
    fireEvent.click(await screen.findByRole('button', { name: /I have a ticket/ }))
    fireEvent.change(screen.getByLabelText('Ticket code'), { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: 'Check ticket' }))
  }
  const join = async (ticketCode: string, name: string, storage = memoryStorage()) => {
    gate(storage)
    await enterCode(ticketCode)
    expect(await screen.findByText(`Cadet ticket for ${name}`)).toBeInTheDocument()
    expect(screen.getByText(/Bethel NJROTC/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    return storage
  }

  it('a cadet ticket code shows "Cadet ticket for <name>", asks the passphrase twice, and opens My gear with the published record', async () => {
    const storage = await join(code, 'Avery Private')
    expect(await screen.findByRole('heading', { name: 'My gear' })).toBeInTheDocument()
    const have = await screen.findByRole('region', { name: 'Have' })
    await waitFor(() => expect(have).toHaveTextContent('Gold PT Shirt'))
    expect(have).toHaveTextContent('Size M'); expect(have).toHaveTextContent('Qty 2')
    expect(screen.getByText('C-4F7K')).toBeInTheDocument()
    expect(screen.queryByText(/Staff app/)).toBeNull()
    for (const word of ['Count', 'Inventory', 'Cadets', 'Activity', 'More']) expect(screen.queryByText(word)).toBeNull()
    expect(loadCadetVault(storage)).toBeDefined()
    expect(storage.getItem(DEVICE_VAULT_STORAGE_KEY)).toBeNull()
  })

  it('refuses mismatching passphrases without redeeming', async () => {
    const storage = memoryStorage()
    gate(storage)
    await enterCode(mismatchCode)
    await screen.findByText('Cadet ticket for Casey Mismatch')
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: PASS + 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Join unit' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The passphrases do not match.')
    expect(storage.getItem(CADET_VAULT_STORAGE_KEY)).toBeNull()
  })

  it('a phone that already joined asks for its passphrase when reopened, then shows My gear; Leave this unit wipes it and returns to the welcome step', async () => {
    const storage = await join(reopenCode, 'Blake Reopen')
    await screen.findByRole('heading', { name: 'My gear' })
    cleanup()
    gate(storage)
    expect(await screen.findByRole('heading', { name: 'Unlock A.R.G.U.S.' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'wrong passphrase 1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('That passphrase is not correct for this device.')
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: PASS } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('heading', { name: 'My gear' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Leave this unit' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Yes, leave this unit' })) })
    expect(await screen.findByRole('heading', { name: 'Set up this device' })).toBeInTheDocument()
    expect(storage.getItem(CADET_VAULT_STORAGE_KEY)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'My gear' })).toBeNull()
  })

  it('a staff ticket still joins as before, on the same screen', async () => {
    gate()
    await enterCode(staffCode)
    expect(await screen.findByText('Ticket for Pat Officer')).toBeInTheDocument()
    expect(screen.queryByText(/Cadet ticket for/)).toBeNull()
  })

  it('a cadet ticket already used is refused in plain words', async () => {
    const storage = memoryStorage()
    gate(storage)
    await enterCode(code)
    expect(await screen.findByRole('alert')).toHaveTextContent('This ticket was already used on another device.')
    expect(storage.getItem(CADET_VAULT_STORAGE_KEY)).toBeNull()
  })
})
