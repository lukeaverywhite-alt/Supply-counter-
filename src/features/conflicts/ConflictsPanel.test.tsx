import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AuthorizationService, ROLE_PERMISSIONS, issueCredential } from '../../auth/authorization'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { MockIdentityProvider } from '../../identity/identity'
import { MemoryRepository } from '../../storage/repository'
import { MockSyncProvider } from '../../sync/mock'
import { ConflictsPanel } from './ConflictsPanel'
import { describeEvent } from './conflictModel'

const NAMES: Record<string, string> = { 'mock:officer-a': 'Chief Ames', 'mock:officer-b': 'Petty Officer Bell' }
const memberName = (identity: string) => NAMES[identity] ?? 'Unit member'

/** Two officers' devices sharing one sync provider. */
async function pair() {
  const root = new MockIdentityProvider('root'), authorization = new AuthorizationService(await root.getPublicIdentity(), root), provider = new MockSyncProvider()
  const controllers: DistributedAppController[] = []
  for (const name of ['officer-a', 'officer-b']) {
    const identity = new MockIdentityProvider(name)
    await authorization.acceptCredential(await issueCredential(root, { subjectPublicIdentity: await identity.getPublicIdentity(), role: 'SUPPLY_OFFICER', permissions: [...ROLE_PERMISSIONS.SUPPLY_OFFICER], issuedAt: '2026-01-01T00:00:00.000Z' }))
    const controller = new DistributedAppController(new MemoryRepository(), { identity, authorization, provider, organizationId: 'unit-conflicts' })
    await controller.initialize(); controllers.push(controller)
  }
  return controllers
}

/** Only one Medium Female SDB Jacket; both officers issue it offline to different cadets. */
async function lastJacketConflict() {
  const [a, b] = await pair()
  let projection = await a.project()
  const jacket = projection.catalog.find(item => item.name === 'Female SDB Jacket')!
  projection = await a.addCatalogSizes(jacket.catalogId, ['M'])
  const medium = projection.inventory.find(item => item.catalogId === jacket.catalogId)!.entityId
  await a.receiveStock(medium, 1)
  await a.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-AAAA' })
  projection = await a.createCadet({ gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-BBBB' })
  const cadetId = (code: string) => projection.cadets.find(cadet => cadet.cadetCode === code)!.cadetId
  await b.sync()
  a.setOnline(false); b.setOnline(false)
  await a.issueTransaction({ transactionId: 'tx-a', cadetId: cadetId('C-AAAA'), lines: [{ lineId: 'jacket', itemId: medium, quantity: 1 }] }, { eventId: 'issue-a' })
  await b.issueTransaction({ transactionId: 'tx-b', cadetId: cadetId('C-BBBB'), lines: [{ lineId: 'jacket', itemId: medium, quantity: 1 }] }, { eventId: 'issue-b' })
  a.setOnline(true); b.setOnline(true)
  await a.sync(); await b.sync(); await a.sync()
  return { a, b, cadetB: cadetId('C-BBBB'), medium }
}

function Harness({ controller, initial, can = () => true, toasts }: { controller: DistributedAppController; initial: ArgusAppProjection; can?: (permission: ArgusPermission) => boolean; toasts: string[] }) {
  const [projection, setProjection] = useState(initial)
  return <ConflictsPanel projection={projection} controller={controller} can={can} memberName={memberName} close={() => undefined} onProjection={setProjection} notify={message => toasts.push(message)} />
}

describe('ConflictsPanel (spec §23)', () => {
  it('describes the competing values in catalog and calendar edit conflicts', () => {
    const projection = {
      events: [
        { event: { eventId: 'catalog-edit', eventType: 'CATALOG_ITEM_UPDATED', timestamp: '2026-01-02T03:04:00.000Z', actorPublicIdentity: 'mock:officer-a', payload: { name: 'Dress Jacket', reorderAt: 4 } } },
        { event: { eventId: 'calendar-edit', eventType: 'CALENDAR_EVENT_UPDATED', timestamp: '2026-01-02T03:05:00.000Z', actorPublicIdentity: 'mock:officer-b', payload: { title: 'AMI Inspection', startsAt: '2026-04-10T14:00:00.000Z', baseRevisions: {} } } },
      ],
      transactions: [], cadets: [], conflicts: [], rejected: [],
    } as unknown as ArgusAppProjection

    expect(describeEvent(projection, 'catalog-edit', memberName).label).toBe('Catalog edit: name = “Dress Jacket”, low-stock threshold = “4”')
    expect(describeEvent(projection, 'calendar-edit', memberName).label).toBe('Calendar edit: title = “AMI Inspection”, date and time = “2026-04-10T14:00:00.000Z”')
  })

  it('shows the impossible state, the losing cadet and the competing events, then records the chosen outcome', async () => {
    const { b, cadetB, medium } = await lastJacketConflict()
    const toasts: string[] = []
    render(<Harness controller={b} initial={await b.project()} toasts={toasts} />)
    const conflict = screen.getByRole('article', { name: 'Open conflict' })

    expect(within(conflict).getByRole('group', { name: 'Resulting impossible state' })).toHaveTextContent('Would leave −1 Female SDB Jacket · M (0 on hand, 1 requested)')
    expect(within(conflict).getByText('C-BBBB')).toBeInTheDocument()
    expect(within(conflict).getByText(/this cadet’s transaction was not applied/)).toBeInTheDocument()
    const [first, second] = within(conflict).getAllByRole('listitem').filter(item => item.textContent?.startsWith('Issue'))
    expect(first).toHaveTextContent('Issue to C-AAAA: 1 × Female SDB Jacket · M')
    expect(first).toHaveTextContent('Chief Ames')
    expect(within(first).getByText('Applied')).toBeInTheDocument()
    expect(second).toHaveTextContent('Issue to C-BBBB: 1 × Female SDB Jacket · M')
    expect(second).toHaveTextContent('Petty Officer Bell')
    expect(within(second).getByText('Not applied')).toBeInTheDocument()

    // An explicit outcome: record the losing issue as Still Needed for C-BBBB.
    expect(within(conflict).getByRole('radio', { name: /Keep as is/ })).toBeChecked()
    fireEvent.click(within(conflict).getByRole('radio', { name: /Record as Still Needed for C-BBBB/ }))
    const save = within(conflict).getByRole('button', { name: 'Record resolution' })
    expect(save).toBeDisabled()
    fireEvent.change(within(conflict).getByLabelText('Resolution'), { target: { value: 'Shelf empty; C-BBBB gets the next delivery' } })
    fireEvent.click(save)
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Open conflict' })).toBeNull())
    expect(toasts).toEqual(['Conflict resolved: the items were recorded as Still Needed for C-BBBB.'])
    expect(screen.getByText('Recorded as Still Needed')).toBeInTheDocument()

    const after = await b.project()
    expect(after.conflicts[0]).toMatchObject({ status: 'RESOLVED', outcome: 'RECORD_STILL_NEEDED' })
    expect(after.stillNeeded).toEqual([expect.objectContaining({ cadetId: cadetB, itemId: medium, displayLabel: 'Female SDB Jacket', size: 'M', source: 'CONFLICT_RESOLUTION' })])
  })

  it('shows the conflict but no resolution controls without conflicts.resolve', async () => {
    const { a } = await lastJacketConflict()
    render(<Harness controller={a} initial={await a.project()} can={permission => permission !== 'conflicts.resolve'} toasts={[]} />)
    const conflict = screen.getByRole('article', { name: 'Open conflict' })
    expect(within(conflict).getByRole('group', { name: 'Resulting impossible state' })).toBeInTheDocument()
    expect(within(conflict).queryByRole('radio')).toBeNull()
    expect(within(conflict).queryByRole('button', { name: 'Record resolution' })).toBeNull()
    expect(within(conflict).getByText('A Supply Officer or the Master resolves conflicts.')).toBeInTheDocument()
  })
})
