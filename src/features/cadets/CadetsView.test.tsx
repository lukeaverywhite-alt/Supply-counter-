import { useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SupplyWorkflow } from '../../components/SupplyWorkflow'
import { DistributedAppController, type ArgusAppProjection } from '../../distributed/appIntegration'
import type { ArgusPermission } from '../../distributed/types'
import { CADET_CODE_PATTERN } from '../../stage3/domain'
import { CadetsView } from './CadetsView'

const NAME = 'Jordan Rivera'
const NAME_LABEL = 'Name (optional · encrypted)'

async function setup() {
  const controller = new DistributedAppController()
  const projection = await controller.initialize()
  return { controller, projection }
}

type HarnessProps = {
  controller: DistributedAppController
  initial: ArgusAppProjection
  toasts: string[]
  can?: (permission: ArgusPermission) => boolean
}

/** Mirrors how App hosts the view: it owns the projection, toasts and the issue/return workflow. */
function Harness({ controller, initial, toasts, can = () => true }: HarnessProps) {
  const [projection, setProjection] = useState(initial)
  const [workflow, setWorkflow] = useState<{ mode: 'ISSUE' | 'RETURN'; cadetId: string }>()
  return (
    <>
      <CadetsView
        projection={projection}
        controller={controller}
        can={can}
        onProjection={setProjection}
        notify={message => toasts.push(message)}
        onIssue={cadetId => setWorkflow({ mode: 'ISSUE', cadetId })}
        onReturn={cadetId => setWorkflow({ mode: 'RETURN', cadetId })}
      />
      {workflow && (
        <SupplyWorkflow
          mode={workflow.mode}
          projection={projection}
          controller={controller}
          selectedCadetId={workflow.cadetId}
          onClose={() => setWorkflow(undefined)}
          onChanged={setProjection}
        />
      )}
    </>
  )
}

async function addCadetThroughUi(input: { gender: 'Male' | 'Female'; name?: string; nsLevel?: string; sizes?: Record<string, string> }) {
  fireEvent.click(screen.getByRole('button', { name: 'Add cadet' }))
  const form = screen.getByRole('form', { name: 'Add cadet' })
  fireEvent.change(within(form).getByLabelText('Gender'), { target: { value: input.gender } })
  if (input.nsLevel) fireEvent.change(within(form).getByLabelText('NS level'), { target: { value: input.nsLevel } })
  if (input.name) fireEvent.change(within(form).getByLabelText(NAME_LABEL), { target: { value: input.name } })
  for (const [item, size] of Object.entries(input.sizes ?? {})) fireEvent.change(within(form).getByLabelText(`${item} size`), { target: { value: size } })
  fireEvent.click(within(form).getByRole('button', { name: 'Add cadet' }))
  await waitFor(() => expect(screen.queryByRole('form', { name: 'Add cadet' })).not.toBeInTheDocument())
}

const codeFromToast = (toasts: string[]) => /^Cadet (\S+) added\.$/.exec(toasts.at(-1) ?? '')?.[1] ?? ''
const cadetCard = (code: string) => screen.getByRole('button', { name: new RegExp(code) })

describe('CadetsView privacy and records', () => {
  it('adds a named cadet through the UI but lists, titles and announces it only by cadet ID until "Show name"', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    expect(screen.getByText('Cadets are shown by cadet ID. Names are encrypted and only shown when you choose to reveal them.')).toBeInTheDocument()
    expect(screen.getByText('No cadets yet.')).toBeInTheDocument()

    await addCadetThroughUi({ gender: 'Female', name: NAME, nsLevel: 'NS2' })
    const code = codeFromToast(toasts)
    expect(code).toMatch(CADET_CODE_PATTERN)
    expect(toasts).toEqual([`Cadet ${code} added.`])
    expect((await controller.project()).cadets[0]).toMatchObject({ cadetCode: code, fullName: NAME, nsLevel: 'NS2' })

    const card = cadetCard(code)
    expect(card).toHaveTextContent('NS2 · Female · ACTIVE')
    expect(card).toHaveTextContent('INCOMPLETE · 8 needed')
    expect(screen.queryByText(NAME)).toBeNull()
    expect(document.body.innerHTML).not.toContain(NAME)

    fireEvent.click(card)
    const drawer = screen.getByRole('dialog', { name: code })
    expect(within(drawer).queryByText(NAME)).toBeNull()
    expect(document.body.innerHTML).not.toContain(NAME)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Show name' }))
    expect(within(drawer).getByText(NAME)).toBeInTheDocument()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Hide name' }))
    expect(screen.queryByText(NAME)).toBeNull()

    // The reveal is per drawer session: closing re-hides it.
    fireEvent.click(within(drawer).getByRole('button', { name: 'Show name' }))
    fireEvent.click(within(drawer).getByLabelText('Close panel'))
    expect(screen.queryByText(NAME)).toBeNull()
    fireEvent.click(cadetCard(code))
    expect(screen.getByRole('dialog', { name: code })).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain(NAME)
  })

  it('finds a cadet by name, code or NS level but shows only the cadet ID', async () => {
    const { controller } = await setup()
    await controller.createCadet({ fullName: NAME, gender: 'Male', nsLevel: 'NS3', status: 'ACTIVE' })
    const projection = await controller.createCadet({ fullName: 'Casey Bennett', gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE' })
    const jordan = projection.cadets.find(cadet => cadet.fullName === NAME)!
    const casey = projection.cadets.find(cadet => cadet.fullName === 'Casey Bennett')!
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    const search = screen.getByLabelText('Search cadets')

    fireEvent.change(search, { target: { value: 'rivera' } })
    expect(cadetCard(jordan.cadetCode!)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(casey.cadetCode!) })).toBeNull()
    expect(screen.queryByText(/Jordan|Rivera/)).toBeNull()
    expect(document.body.innerHTML).not.toContain(NAME)

    fireEvent.change(search, { target: { value: casey.cadetCode!.toLowerCase() } })
    expect(cadetCard(casey.cadetCode!)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(jordan.cadetCode!) })).toBeNull()

    fireEvent.change(search, { target: { value: 'NS3' } })
    expect(cadetCard(jordan.cadetCode!)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: new RegExp(casey.cadetCode!) })).toBeNull()

    fireEvent.change(search, { target: { value: 'nobody by this name' } })
    expect(screen.getByText('No matching cadets')).toBeInTheDocument()
  })

  it('filters by status with ACTIVE / INACTIVE / ALL chips', async () => {
    const { controller } = await setup()
    await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-AAAA' })
    const projection = await controller.createCadet({ gender: 'Female', nsLevel: 'NS4', status: 'INACTIVE', cadetCode: 'C-BBBB' })
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    expect(cadetCard('C-AAAA')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /C-BBBB/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Inactive/ }))
    expect(cadetCard('C-BBBB')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /C-AAAA/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^All/ }))
    expect(cadetCard('C-AAAA')).toBeInTheDocument()
    expect(cadetCard('C-BBBB')).toBeInTheDocument()
  })

  it('does not mark a cadet ready when standard-issue items have not been issued', async () => {
    const { controller } = await setup()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-GAPS' })
    render(<Harness controller={controller} initial={projection} toasts={[]} />)

    const card = cadetCard('C-GAPS')
    expect(card).toHaveTextContent('INCOMPLETE')
    expect(card).not.toHaveTextContent('READY')
  })

  it('adds a cadet without a name, validates a cadet ID override and keeps the form open on failure', async () => {
    const { controller, projection } = await setup()
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add cadet' }))
    const form = screen.getByRole('form', { name: 'Add cadet' })
    const submit = within(form).getByRole('button', { name: 'Add cadet' })

    fireEvent.click(submit)
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose a gender.')
    fireEvent.change(within(form).getByLabelText('Gender'), { target: { value: 'Male' } })
    fireEvent.change(within(form).getByLabelText('Cadet ID (optional)'), { target: { value: 'X-1' } })
    fireEvent.click(submit)
    expect(within(form).getByRole('alert')).toHaveTextContent(/Cadet IDs look like C-4F7K/)
    expect((await controller.project()).cadets).toHaveLength(0)

    fireEvent.change(within(form).getByLabelText('Cadet ID (optional)'), { target: { value: ' c-7k4m ' } })
    const failing = vi.spyOn(controller, 'createCadet').mockRejectedValueOnce(new Error('Missing permission: cadets.manage'))
    fireEvent.click(submit)
    expect(await within(form).findByText('Missing permission: cadets.manage')).toBeInTheDocument()
    expect(screen.getByRole('form', { name: 'Add cadet' })).toBeInTheDocument()
    expect(within(form).getByLabelText('Cadet ID (optional)')).toHaveValue(' c-7k4m ')
    failing.mockRestore()

    fireEvent.click(submit)
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add cadet' })).not.toBeInTheDocument())
    expect(toasts).toEqual(['Cadet C-7K4M added.'])
    expect((await controller.project()).cadets[0]).toMatchObject({ cadetCode: 'C-7K4M', fullName: '', gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', sizes: {} })

    fireEvent.click(cadetCard('C-7K4M'))
    fireEvent.click(screen.getByRole('button', { name: 'Show name' }))
    expect(screen.getByText('No name recorded')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Close panel'))

    // A blank cadet ID is generated automatically.
    await addCadetThroughUi({ gender: 'Female' })
    const generated = codeFromToast(toasts)
    expect(generated).toMatch(CADET_CODE_PATTERN)
    expect(generated).not.toBe('C-7K4M')
    expect(cadetCard(generated)).toBeInTheDocument()
  })

  it('edits the NS level and sends only the changed field', async () => {
    const { controller } = await setup()
    const projection = await controller.createCadet({ fullName: NAME, gender: 'Female', nsLevel: 'NS1', status: 'ACTIVE', sizes: { 'Legacy PT Shirt': 'L' } })
    const code = projection.cadets[0].cadetCode!
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)
    fireEvent.click(cadetCard(code))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: `Edit cadet ${code}` })
    expect(within(form).getByLabelText('NS level')).toHaveValue('NS1')
    expect(within(form).getByLabelText('Gender')).toHaveValue('Female')
    // An existing name stays hidden in the edit form until revealed.
    expect(within(form).queryByLabelText(NAME_LABEL)).toBeNull()
    expect(document.body.innerHTML).not.toContain(NAME)
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled()

    fireEvent.change(within(form).getByLabelText('NS level'), { target: { value: 'NS3' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: code })).toHaveTextContent('NS3 · Female · ACTIVE'))
    expect(toasts).toEqual([`Cadet ${code} updated.`])
    expect(cadetCard(code)).toHaveTextContent('NS3 · Female · ACTIVE')

    const state = await controller.technicalState()
    const updates = state.events.filter(record => record.event.eventType === 'CADET_UPDATED')
    expect(updates).toHaveLength(1)
    expect(updates[0].event.payload).toEqual({ nsLevel: 'NS3' })
    expect(state.cadets[0]).toMatchObject({ nsLevel: 'NS3', fullName: NAME, sizes: { 'Legacy PT Shirt': 'L' } })
  })

  it('changes a name only after it is revealed in the edit form', async () => {
    const { controller } = await setup()
    const projection = await controller.createCadet({ fullName: NAME, gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE' })
    const code = projection.cadets[0].cadetCode!
    render(<Harness controller={controller} initial={projection} toasts={[]} />)
    fireEvent.click(cadetCard(code))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: `Edit cadet ${code}` })
    fireEvent.click(within(form).getByRole('button', { name: 'Show name' }))
    expect(within(form).getByLabelText(NAME_LABEL)).toHaveValue(NAME)
    fireEvent.change(within(form).getByLabelText(NAME_LABEL), { target: { value: 'Jordan R. Rivera' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }))
    // Back on the record, the reveal carried over from the edit form within the same drawer session.
    expect(await screen.findByText('Jordan R. Rivera')).toBeInTheDocument()
    const update = (await controller.technicalState()).events.find(record => record.event.eventType === 'CADET_UPDATED')
    expect(update?.event.payload).toEqual({ fullName: 'Jordan R. Rivera' })
    fireEvent.click(screen.getByLabelText('Close panel'))
    expect(screen.queryByText(/Jordan/)).toBeNull()
  })

  it('issues the PT bundle in the saved PT Shorts size and confirms by cadet ID only', async () => {
    const { controller } = await setup()
    let projection = await controller.project()
    const shorts = projection.catalog.find(item => item.name === 'PT Shorts')!
    projection = await controller.addCatalogSizes(shorts.catalogId, ['S', 'M'])
    const small = projection.inventory.find(item => item.catalogId === shorts.catalogId && item.variant === 'S')!
    const medium = projection.inventory.find(item => item.catalogId === shorts.catalogId && item.variant === 'M')!
    // S is the first size in stock, so selecting M proves the saved size wins.
    await controller.receiveStock(small.entityId, 3)
    projection = await controller.receiveStock(medium.entityId, 5)
    const toasts: string[] = []
    render(<Harness controller={controller} initial={projection} toasts={toasts} />)

    await addCadetThroughUi({ gender: 'Male', name: NAME, sizes: { 'PT Shorts': 'M' } })
    const code = codeFromToast(toasts)
    expect((await controller.project()).cadets[0].sizes).toEqual({ 'PT Shorts': 'M' })

    fireEvent.click(cadetCard(code))
    fireEvent.click(screen.getByRole('button', { name: 'Issue Items' }))
    expect(screen.queryByRole('dialog', { name: code })).toBeNull()
    const workflow = screen.getByRole('dialog', { name: 'Issue property' })
    expect(within(workflow).getByText(code)).toBeInTheDocument()
    const ptBundle = within(workflow).getAllByRole('button').find(button => button.querySelector('b')?.textContent === 'PT')!
    fireEvent.click(ptBundle)
    expect(within(workflow).getByLabelText('PT Shorts variant')).toHaveValue(medium.entityId)
    fireEvent.click(within(workflow).getByRole('button', { name: 'Review Issue' }))
    fireEvent.click(within(workflow).getByRole('button', { name: /Confirm Issue/ }))
    await within(workflow).findByText(/Saved locally/)

    const after = await controller.project()
    expect(after.inventory.find(item => item.entityId === medium.entityId)?.onHand).toBe(4)
    expect(after.inventory.find(item => item.entityId === small.entityId)?.onHand).toBe(3)
    expect(after.cadets[0].currentProperty).toEqual([expect.objectContaining({ itemId: medium.entityId, variant: 'M', quantity: 1 })])
    expect(after.stillNeeded.map(need => need.displayLabel).sort()).toEqual(['Gold PT Shirt', 'Khaki Ball Cap'])
    expect(within(workflow).getByRole('status')).toHaveTextContent(code)
    expect(document.body.innerHTML).not.toContain(NAME)

    // The record now shows the property, the Still Needed items and the history entry.
    fireEvent.click(within(workflow).getByRole('button', { name: 'Done' }))
    fireEvent.click(cadetCard(code))
    const drawer = screen.getByRole('dialog', { name: code })
    expect(within(drawer).getByText('PT Shorts')).toBeInTheDocument()
    expect(within(drawer).getByText(/^M · Qty 1 · Issued /)).toBeInTheDocument()
    expect(within(drawer).getByText('Gold PT Shirt')).toBeInTheDocument()
    expect(within(drawer).getByText('ISSUE')).toBeInTheDocument()
    expect(within(drawer).getByText(/PT Shorts · M × 1 · 2 added to Still Needed/)).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Return Items' })).toBeEnabled()
    expect(cadetCard(code)).toHaveTextContent('INCOMPLETE · 10 needed')
  })

  it('hides Add and Edit without cadets.manage and disables issue/return without inventory permissions', async () => {
    const { controller } = await setup()
    const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS2', status: 'ACTIVE', cadetCode: 'C-9QRS' })
    const readOnly = (permission: ArgusPermission) => permission !== 'cadets.manage'
    const view = render(<Harness controller={controller} initial={projection} toasts={[]} can={readOnly} />)
    expect(screen.getByRole('heading', { name: 'Cadet property records.' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add cadet' })).toBeNull()
    fireEvent.click(cadetCard('C-9QRS'))
    let drawer = screen.getByRole('dialog', { name: 'C-9QRS' })
    expect(within(drawer).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(drawer).getByRole('button', { name: 'Show name' })).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Issue Items' })).toBeEnabled()
    expect(within(drawer).getByRole('button', { name: 'Return Items' })).toBeDisabled()
    view.unmount()

    render(<Harness controller={controller} initial={projection} toasts={[]} can={permission => permission === 'cadets.read'} />)
    fireEvent.click(cadetCard('C-9QRS'))
    drawer = screen.getByRole('dialog', { name: 'C-9QRS' })
    expect(within(drawer).getByRole('button', { name: 'Issue Items' })).toBeDisabled()
    expect(within(drawer).queryByRole('button', { name: 'Edit' })).toBeNull()
  })
})
