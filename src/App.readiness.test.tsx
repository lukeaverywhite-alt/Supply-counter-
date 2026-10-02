import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'
import { DistributedAppController } from './distributed/appIntegration'
import { LocalSettingsStorage, SETTINGS_KEY } from './settings'
import { MemoryRepository } from './storage/repository'
import { DAY, stockSizes } from './test/supplyFixtures'

const memoryStorage = () => {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), values }
}
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString()

async function seededApp(seed: (controller: DistributedAppController) => Promise<unknown>, preferences = memoryStorage()) {
  const controller = new DistributedAppController(new MemoryRepository())
  await controller.initialize()
  await seed(controller)
  render(<App controller={controller} settingsStorage={new LocalSettingsStorage(preferences)} />)
  await screen.findByRole('heading', { name: 'Home', level: 1 })
  return { controller, preferences }
}
const alertsRegion = () => screen.getByRole('region', { name: 'Alerts' })
const primaryNav = (label: string) => fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: label }))

describe('dashboard alerts and readiness open the exact record', { timeout: 60_000 }, () => {
  it('opens an event’s drawer from its alert; plain navigation does not reopen it', async () => {
    await seededApp(controller => controller.createCalendarEvent({ kind: 'AMI', startsAt: daysFromNow(3) }))
    // Three days out the AMI card sits at the top of the dashboard.
    expect(screen.getByRole('region', { name: 'AMI readiness' })).toBeInTheDocument()
    fireEvent.click(within(alertsRegion()).getByRole('button', { name: /Overdue: Complete a physical count of Supply/ }))
    expect(await screen.findByRole('heading', { name: 'Supply Calendar', level: 1 })).toBeInTheDocument()
    const drawer = screen.getByRole('dialog', { name: 'Area Manager Inspection' })
    expect(within(drawer).getByRole('region', { name: 'AMI readiness' })).toBeInTheDocument()

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close panel' }))
    primaryNav('Inventory')
    primaryNav('Calendar')
    expect(await screen.findByRole('heading', { name: 'Supply Calendar', level: 1 })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('opens Inventory filtered to what needs attention from the STOCK node, and the exact item from a stock alert', async () => {
    await seededApp(async controller => {
      const { ids } = await stockSizes(controller, 'PT Shorts', { M: 0 })
      await controller.updateInventoryItem(ids.M, { reorderAt: 2 })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stock: 1 needs attention' }))
    expect(await screen.findByRole('heading', { name: 'Inventory', level: 1 })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs attention' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Mobile navigation' })).getByRole('button', { name: 'Home' }))
    fireEvent.click(within(await screen.findByRole('region', { name: 'Alerts' })).getByRole('button', { name: /1 size out of stock/ }))
    expect(await screen.findByRole('dialog', { name: 'PT Shorts' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Needs attention' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('opens the cadet record from the cadet alert and from Still Needed', async () => {
    await seededApp(controller => controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-M001' }))
    fireEvent.click(within(alertsRegion()).getByRole('button', { name: /1 cadet still needs items/ }))
    expect(await screen.findByRole('dialog', { name: 'C-M001' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))

    primaryNav('More')
    fireEvent.click(await screen.findByRole('button', { name: /Still needed/ }))
    const needed = await screen.findByRole('dialog', { name: 'Still Needed' })
    expect(within(needed).getByRole('heading', { name: 'Missing standard issue (1)' })).toBeInTheDocument()
    fireEvent.click(within(needed).getByRole('button', { name: 'Open cadet C-M001' }))
    expect(await screen.findByRole('dialog', { name: 'C-M001' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Cadets', level: 1 })).toBeInTheDocument()
  })

  it('shows available catalog sizes for a need created before sizes were configured', async () => {
    await seededApp(async controller => {
      const projection = await controller.createCadet({ gender: 'Male', nsLevel: 'NS1', status: 'ACTIVE', cadetCode: 'C-S2ZE' })
      const cadet = projection.cadets[0]
      const shorts = projection.catalog.find(item => item.name === 'PT Shorts')!
      await controller.addStillNeeded({ cadetId: cadet.cadetId, catalogId: shorts.catalogId, displayLabel: shorts.name, quantityNeeded: 1, quantityFulfilled: 0, status: 'OPEN', firstNeededAt: '2026-01-01T00:00:00.000Z', source: 'MANUAL' })
      await controller.addCatalogSizes(shorts.catalogId, ['S', 'M', 'L'])
    })

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Dashboard navigation' })).getByRole('button', { name: /Command Center/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Still needed/ }))
    const needed = await screen.findByRole('dialog', { name: 'Still Needed' })
    expect(within(needed).getByText('Sizes: S, M, L')).toBeInTheDocument()
    expect(within(needed).queryByText('Not configured')).not.toBeInTheDocument()
  })

  it('starts the annual rollover from the End-of-Year event, where the same checklist is shown', async () => {
    await seededApp(controller => controller.createCalendarEvent({ kind: 'END_OF_YEAR', startsAt: daysFromNow(20) }))
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Dashboard navigation' })).getByRole('button', { name: /^Calendar/ }))
    fireEvent.click(await screen.findByRole('button', { name: /End-of-Year Count/ }))
    const drawer = screen.getByRole('dialog', { name: 'End-of-Year Count' })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Start annual rollover' }))
    const rollover = await screen.findByRole('dialog', { name: 'Annual rollover' })
    expect(within(rollover).getByRole('list', { name: 'Rollover readiness checklist' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Command Center', level: 1 })).toBeInTheDocument()
  })
})

describe('readiness weights in Settings', { timeout: 60_000 }, () => {
  it('saves valid weights for this device and refuses all-zero weights', async () => {
    const { preferences } = await seededApp(async () => undefined)
    fireEvent.click(screen.getByLabelText('Settings'))
    fireEvent.change(screen.getByLabelText('Cadets weight'), { target: { value: '3' } })
    await waitFor(() => expect(JSON.parse(preferences.values.get(SETTINGS_KEY)!).readinessWeights).toEqual({ cadets: 3, inventory: 1, events: 1, audit: 1 }))

    for (const label of ['Cadets weight', 'Inventory weight', 'Events weight', 'Audit weight']) fireEvent.change(screen.getByLabelText(label), { target: { value: '0' } })
    expect(screen.getByRole('alert')).toHaveTextContent('At least one weight must be above zero.')
    expect(JSON.parse(preferences.values.get(SETTINGS_KEY)!).readinessWeights).toEqual({ cadets: 0, inventory: 0, events: 0, audit: 1 })

    fireEvent.click(screen.getByRole('button', { name: 'Reset to equal weights' }))
    await waitFor(() => expect(JSON.parse(preferences.values.get(SETTINGS_KEY)!).readinessWeights).toEqual({ cadets: 1, inventory: 1, events: 1, audit: 1 }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
