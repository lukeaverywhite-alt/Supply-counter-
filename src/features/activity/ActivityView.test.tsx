import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from '../../App'
import { FakeChain } from '../../chain/fakeChain'
import { MemoryWalletStateStore } from '../../chain/walletStore'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import { canonicalize, sha256 } from '../../distributed/canonical'
import type { DistributedEventType, StoredEvent } from '../../distributed/types'
import { DEFAULT_SETTINGS, LocalSettingsStorage, SETTINGS_KEY } from '../../settings'
import { GENESIS_CATALOG } from '../../stage3/domain'
import { MemoryLedgerStore } from '../../unit/ledgerStore'
import { UnitRuntime } from '../../unit/runtime'
import { joinByTicket } from '../../test/joinByTicket'
import { createMasterDevice } from '../../unit/vault'
import { ActivityView } from './ActivityView'
import { describeActivity } from './activityModel'

const PT_SHORTS = GENESIS_CATALOG.find(item => item.name === 'PT Shorts')!.catalogId
const memoryStorage = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) } }
const TXID = 'ab'.repeat(32)

/** Stock received, a cadet (with a private name) issued size S, then the size corrected to M. */
async function history() {
  const controller = new DistributedAppController()
  await controller.initialize()
  let projection = await controller.addCatalogSizes(PT_SHORTS, ['S', 'M'])
  const [small, medium] = ['S', 'M'].map(size => projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === size)!.entityId)
  await controller.receiveStock(small, 3)
  await controller.receiveStock(medium, 3)
  projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', fullName: 'Very Private Name' })
  const cadet = projection.cadets[0]
  projection = await controller.issueTransaction({ transactionId: 'issue-1', cadetId: cadet.cadetId, lines: [{ lineId: 'l1', itemId: small, quantity: 1 }] })
  const propertyId = projection.cadets[0].currentProperty[0].propertyId
  projection = await controller.correctIssuedSize({ cadetId: cadet.cadetId, propertyId, toItemId: medium, reason: 'Too small at fitting' })
  const byType = (type: DistributedEventType) => projection.events.filter(record => record.event.eventType === type)
  return { projection, cadetCode: cadet.cadetCode!, issue: byType('ITEM_ISSUED')[0], correction: byType('PROPERTY_CORRECTED')[0], receipts: byType('INVENTORY_RECEIVED') }
}

/** The same history as a testnet device would hold it: the issue mined, a receipt refused once, the correction still queued. */
function onTestnet(projection: ArgusAppProjection, delivery: Record<string, Partial<StoredEvent>>): ArgusAppProjection {
  return { ...projection, sync: { ...projection.sync, mode: 'remote' }, events: projection.events.map(record => ({ ...record, syncStatus: 'SYNCHRONIZED', auditStatus: 'BROADCAST', transactionId: TXID, ...delivery[record.event.eventId] })) }
}
const entry = (name: RegExp) => screen.getByRole('listitem', { name })

describe('Activity / audit view (spec §36)', () => {
  it('shows sync status and verification as separate plain labels, the affected record, the correction link and the audit hash', async () => {
    const { projection, cadetCode, issue, correction, receipts } = await history()
    const view = onTestnet(projection, {
      [issue.event.eventId]: { auditStatus: 'CONFIRMED', blockHeight: 1760183 },
      [correction.event.eventId]: { syncStatus: 'QUEUED', auditStatus: 'PENDING', transactionId: undefined },
      [receipts[0].event.eventId]: { syncStatus: 'FAILED', auditStatus: 'FAILED', transactionId: undefined, lastError: 'FakeChain: injected rejected.' },
    })
    const { container } = render(<ActivityView projection={view} memberName={() => 'Chief'} />)

    const issued = entry(new RegExp(`^Issued 1 item to ${cadetCode}`))
    expect(within(issued).getByText('SYNCHRONIZED')).toBeInTheDocument()
    expect(within(issued).getByText('VERIFIED in block 1760183')).toBeInTheDocument()
    expect(within(issued).getByText(`${cadetCode} · PT Shorts · S ×1`)).toBeInTheDocument()
    expect(await within(issued).findByText(await sha256(canonicalize(issue.event)))).toBeInTheDocument()
    expect(within(issued).getByText('BSV testnet')).toBeInTheDocument()

    const corrected = entry(/^Corrected issued size/)
    expect(within(corrected).getByText('QUEUED')).toBeInTheDocument()
    expect(within(corrected).getByText('not yet on chain')).toBeInTheDocument()
    expect(within(corrected).getByText(/\(PT Shorts · S → PT Shorts · M\)/)).toBeInTheDocument()
    fireEvent.click(within(corrected).getByRole('link', { name: `Issued 1 item to ${cadetCode}` }))
    expect(document.activeElement).toBe(issued)
    expect(within(issued).getByRole('link', { name: /^Corrected issued size/ })).toBeInTheDocument()

    const failed = screen.getAllByRole('listitem', { name: /^Received 3 × PT Shorts · S/ })[0]
    expect(within(failed).getByText('FAILED')).toBeInTheDocument()
    expect(within(failed).getByText('FakeChain: injected rejected.')).toBeInTheDocument()

    // Only verified-in-a-block records count as verified.
    expect(within(screen.getByRole('region', { name: 'A.R.G.U.S. distributed system' })).getByText('VERIFIED').parentElement).toHaveTextContent('VERIFIED1')
    // Cadets appear by cadet ID only; names, reasons and keys never appear.
    expect(container.textContent).not.toMatch(/Very Private Name|Too small at fitting/)
  })

  it('mock mode shows every record as LOCAL, never verified', async () => {
    const { projection } = await history()
    render(<ActivityView projection={projection} memberName={() => 'You'} />)
    const entries = screen.getAllByRole('listitem')
    expect(entries).toHaveLength(projection.events.length)
    for (const item of entries) {
      expect(within(item).getByText('LOCAL')).toBeInTheDocument()
      expect(within(item).getByText('not on a blockchain (demo)')).toBeInTheDocument()
    }
    expect(screen.queryByText(/VERIFIED in block/)).not.toBeInTheDocument()
  })

  it('describes every event type in plain words with an affected record, and never exposes key material', async () => {
    const { projection } = await history()
    const ALL: Record<DistributedEventType, true> = { INVENTORY_ITEM_CREATED: true, INVENTORY_ITEM_UPDATED: true, INVENTORY_RECEIVED: true, CATALOG_ITEM_CREATED: true, CATALOG_ITEM_UPDATED: true, CATALOG_SIZES_ADDED: true, ITEM_ISSUED: true, ITEM_RETURNED: true, INVENTORY_COUNT_SUBMITTED: true, COUNT_SESSION_CREATED: true, COUNT_CONTRIBUTED: true, COUNT_CORRECTED: true, COUNT_RECOUNTED: true, COUNT_SESSION_SUBMITTED: true, COUNT_SESSION_REOPENED: true, COUNT_SESSION_RECONCILED: true, COUNT_SESSION_CANCELLED: true, AUTHORITY_GRANTED: true, ADMISSION_CONFIRMED: true, AUTHORITY_REVOKED: true, ROLE_CHANGED: true, CONFLICT_DETECTED: true, CONFLICT_RESOLVED: true, RECORD_CORRECTED: true, CADET_CREATED: true, CADET_UPDATED: true, BUNDLE_CREATED: true, BUNDLE_UPDATED: true, BUNDLE_DEACTIVATED: true, STILL_NEEDED_ADDED: true, STILL_NEEDED_UPDATED: true, STILL_NEEDED_CANCELLED: true, STILL_NEEDED_FULFILLED: true, CALENDAR_EVENT_CREATED: true, CALENDAR_EVENT_UPDATED: true, CALENDAR_TASK_ADDED: true, CALENDAR_TASK_UPDATED: true, CALENDAR_TASK_REMOVED: true, CALENDAR_ATTENDEES_ADDED: true, CALENDAR_ATTENDEES_REMOVED: true, CALENDAR_BUNDLES_ADDED: true, CALENDAR_BUNDLES_REMOVED: true, TASK_COMPLETED: true, PROPERTY_CORRECTED: true, ANNUAL_ROLLOVER_COMPLETED: true, CADETS_IMPORTED: true, UNIT_KEY_ROTATED: true, RECOVERY_KEY_REGISTERED: true, TICKET_ISSUED: true, TICKET_CANCELLED: true, TICKET_REDEEMED: true, CADET_CHANNEL_CREATED: true, CADET_CHANNEL_ROTATED: true, CADET_NOTICES_KEY_CREATED: true, CADET_TICKET_ISSUED: true, NOTICE_SENT: true }
    const base = projection.events[0]
    for (const eventType of Object.keys(ALL) as DistributedEventType[]) {
      const payload = eventType === 'UNIT_KEY_ROTATED' ? { epochId: 'e2', previousEpoch: 'e1', reason: 'REVOCATION', grants: [{ wrappedKey: 'SECRET-WRAPPED-KEY' }], grantorEcdhPublicKey: 'ECDH-KEY' }
        : eventType.startsWith('CADET_CHANNEL_') ? { cadetId: 'unknown-entity', channelKey: 'SECRET-WRAPPED-KEY', channelAddress: 'ECDH-KEY', reason: 'Replace phone' }
        : eventType === 'CADET_NOTICES_KEY_CREATED' ? { key: 'SECRET-WRAPPED-KEY', address: 'ECDH-KEY' } : {}
      const described = describeActivity(projection, { ...base, event: { ...base.event, eventType, entityId: 'unknown-entity', payload } }, () => 'Chief')
      expect(described.title, eventType).not.toBe(eventType.replaceAll('_', ' ').toLowerCase())
      expect(described.record.label.length, eventType).toBeGreaterThan(0)
      expect(JSON.stringify(described)).not.toMatch(/SECRET-WRAPPED-KEY|ECDH-KEY/)
    }
    expect(describeActivity(projection, { ...base, event: { ...base.event, eventType: 'UNIT_KEY_ROTATED', entityId: 'e2', payload: { reason: 'REVOCATION' } } }, () => 'Chief')).toMatchObject({ title: 'Unit key replaced', record: { kind: 'Unit key' } })
    const member = { publicIdentity: 'member-1', displayName: 'Jordan', role: 'SUPPLY_OFFICER' as const, credentialId: 'c1', issuedAt: '', admittedBy: '', admittedEventId: '', status: 'ACTIVE' as const }
    expect(describeActivity({ ...projection, members: [member] }, { ...base, event: { ...base.event, eventType: 'ROLE_CHANGED', entityId: 'member-1', payload: { credential: { role: 'SUPPLY_OFFICER' } } } }, () => 'Jordan').title).toBe('Jordan is now Supply Officer')
    expect(describeActivity({ ...projection, members: [member] }, { ...base, event: { ...base.event, eventType: 'ROLE_CHANGED', entityId: 'member-1', payload: { credential: { role: 'SUPPLY_OFFICER', credentialId: 'reissued-0fa848ee632ef3162421933aac5eda0b' } } } }, () => 'Jordan').title).toBe('Jordan has the current Supply Officer permissions')
  })

  it('describes tickets by the person they are for, never by their code or keys', async () => {
    const { projection } = await history()
    const base = projection.events[0]
    const ticket = { ticketId: 't-00000000000000000001', ticketAddress: 'mrcNu71ztWjAQA6ww9kHiW3zBWSQidHXTQ', ticketEcdhPublicKey: 'ECDH-KEY', displayName: 'Chris Cadet', role: 'SUPPLY_ASSISTANT' as const, issuedAt: '', expiresAt: '', funding: { txid: 'ab'.repeat(32), vout: 0, satoshis: 2000 }, issuedBy: 'x', issuedEventId: 'e', status: 'OPEN' as const }
    const describe = (eventType: 'TICKET_ISSUED' | 'TICKET_CANCELLED' | 'TICKET_REDEEMED', payload: Record<string, unknown>) => describeActivity({ ...projection, tickets: [ticket] }, { ...base, event: { ...base.event, eventType, entityId: ticket.ticketId, payload } }, () => 'Chief')
    expect(describe('TICKET_ISSUED', { displayName: 'Chris Cadet', role: 'SUPPLY_ASSISTANT', ticketEcdhPublicKey: 'ECDH-KEY' })).toMatchObject({ title: 'Made a ticket for Chris Cadet as Supply Assistant', record: { kind: 'Ticket', label: 'Chris Cadet' } })
    expect(describe('TICKET_CANCELLED', { reason: 'CANCELLED' }).title).toBe('Cancelled the ticket for Chris Cadet')
    expect(describe('TICKET_CANCELLED', { reason: 'EXPIRED' }).title).toBe('Closed the expired ticket for Chris Cadet')
    expect(describe('TICKET_REDEEMED', {}).title).toBe('Chris Cadet used their ticket')
    expect(JSON.stringify(describe('TICKET_ISSUED', { displayName: 'Chris Cadet', role: 'SUPPLY_ASSISTANT', ticketEcdhPublicKey: 'ECDH-KEY' }))).not.toContain('ECDH-KEY')
  })

  it('names the item and what changed for item edits (minor 3)', async () => {
    const controller = new DistributedAppController()
    await controller.initialize()
    let projection = await controller.addCatalogSizes(PT_SHORTS, ['L'])
    const large = projection.inventory.find(item => item.catalogId === PT_SHORTS && item.variant === 'L')!.entityId
    await controller.updateCatalogItem(PT_SHORTS, { niin: '8415-01-234-5678' })
    projection = await controller.updateInventoryItem(large, { reorderAt: 2 })
    const titles = projection.events.map(record => describeActivity(projection, record, () => 'You').title)
    expect(titles).toContain('Updated NIIN of PT Shorts')
    expect(titles).toContain('Updated low-stock level of PT Shorts · L')
    expect(titles.some(title => /item details/i.test(title))).toBe(false)
  })
})

describe('Activity access (spec §4 audit.read)', { timeout: 120_000 }, () => {
  it('is hidden from a Supply Assistant — no tab, no dashboard tile, and a saved default of Activity lands on Home', async () => {
    const chain = new FakeChain()
    const options = () => ({ api: chain, ledger: new MemoryLedgerStore(), walletStore: new MemoryWalletStateStore(), storage: memoryStorage() })
    const masterDevice = await createMasterDevice({ passphrase: 'supply closet 42', displayName: 'Chief', unitName: 'Bethel NJROTC' }, memoryStorage())
    chain.fund(masterDevice.record.walletAddress, 100_000, { confirmed: true })
    const master = await UnitRuntime.open(masterDevice, options())
    const assistantStorage = memoryStorage()
    await joinByTicket(master, chain, 'Casey', 'SUPPLY_ASSISTANT', { store: assistantStorage })
    const preferences = memoryStorage()
    preferences.setItem(SETTINGS_KEY, JSON.stringify({ ...DEFAULT_SETTINGS, defaultSection: 'activity' }))

    render(<App runtimeOptions={options()} storage={assistantStorage} settingsStorage={new LocalSettingsStorage(preferences)} />)
    fireEvent.change(await screen.findByLabelText('Passphrase'), { target: { value: 'another pass 77' } })
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }))
    expect(await screen.findByRole('button', { name: 'Signed in as Casey, Supply Assistant' }, { timeout: 20_000 })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Home', level: 1 })).toBeInTheDocument()
    const tiles = screen.getByRole('navigation', { name: 'Dashboard navigation' })
    expect(within(tiles).queryByRole('button', { name: /Activity/ })).not.toBeInTheDocument()
    fireEvent.click(within(tiles).getByRole('button', { name: /Inventory/ }))
    const primary = await screen.findByRole('navigation', { name: 'Primary navigation' })
    expect(within(primary).getByRole('button', { name: 'Inventory' })).toBeInTheDocument()
    expect(within(primary).queryByRole('button', { name: 'Activity' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(within(screen.getByLabelText('Default section')).queryByRole('option', { name: 'Activity' })).not.toBeInTheDocument()
  })
})
