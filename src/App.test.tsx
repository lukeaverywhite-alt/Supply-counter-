import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

describe('A.R.G.U.S. count workflow', () => {
  it('increments and clearly undoes the most recent counting action', () => {
    render(<App />)
    expect(document.querySelector('.count-display strong')).toHaveTextContent('18')
    fireEvent.click(screen.getByRole('button', { name: /add 1/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('19')
    fireEvent.click(screen.getByRole('button', { name: /undo navy pt shirt.*19.*18/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('18')
    expect(screen.getByRole('status')).toHaveTextContent('Undid Navy PT Shirt · Medium: 19 → 18.')
  })

  it('searches by a normalized CDMIS number', () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: '8415 EX 2041' } })
    expect(screen.getByRole('button', { name: /khaki nsu shirt/i })).toBeInTheDocument()
  })

  it('changes the increment and prevents a negative count', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '10' }))
    fireEvent.click(screen.getByRole('button', { name: /subtract 10/i }))
    fireEvent.click(screen.getByRole('button', { name: /subtract 10/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('0')
  })

  it('accepts a valid custom count increment', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('7')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    fireEvent.click(screen.getByRole('button', { name: /add 7/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('25')
    vi.restoreAllMocks()
  })

  it('ignores invalid custom increments', () => {
    vi.spyOn(window, 'prompt').mockReturnValue('-4')
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }))
    expect(screen.getByRole('button', { name: /add 1/i })).toBeInTheDocument()
    vi.restoreAllMocks()
  })

  it('shows a clear empty search result', () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'not-a-real-item' } })
    expect(screen.getByText('No inventory matches that search.')).toBeInTheDocument()
  })

  it('adds a locally created inventory item', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /inventory/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add item/i }))

    const form = screen.getByRole('heading', { name: 'Add a new item' }).closest('form')
    expect(form).not.toBeNull()
    const modal = within(form!)
    fireEvent.change(modal.getByLabelText('Item name'), { target: { value: 'Test Belt' } })
    fireEvent.change(modal.getByLabelText('Category'), { target: { value: 'Accessories' } })
    fireEvent.change(modal.getByLabelText('Size or variant'), { target: { value: 'One size' } })
    fireEvent.change(modal.getByLabelText('Initial on hand'), { target: { value: '12' } })
    fireEvent.click(modal.getByRole('button', { name: /add item/i }))

    expect(screen.getByText('Test Belt')).toBeInTheDocument()
    expect(screen.getByText(/Accessories · Not assigned/)).toBeInTheDocument()
    expect(screen.getByText('98')).toBeInTheDocument()
    expect(screen.getByText('6 tracked variants')).toBeInTheDocument()
  })

  it('warns about duplicate names and supports optional low-stock thresholds', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /inventory/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /add item/i }))
    fireEvent.change(screen.getByLabelText('Item name'), { target: { value: 'Navy PT Shirt' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Possible duplicate')
    fireEvent.click(screen.getByLabelText('Enable low-stock warning'))
    expect(screen.getByLabelText('Low-stock threshold')).toBeInTheDocument()
  })

  it('keeps inventory and cadet totals consistent', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /inventory/i })[0])
    expect(screen.getByText('86')).toBeInTheDocument()
    expect(screen.getByText('75')).toBeInTheDocument()
    expect(screen.getByText('5 tracked variants')).toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: /cadets/i })[0])
    const issuedCounts = Array.from(document.querySelectorAll('.cadet-card div > b')).map((node) => Number(node.textContent))
    expect(issuedCounts.reduce((total, value) => total + value, 0)).toBe(75)
  })

  it('opens the cadet and audit views from primary navigation', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /cadets/i })[0])
    expect(screen.getByRole('heading', { name: 'Cadet property records.' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /activity/i })[0])
    expect(screen.getByRole('heading', { name: 'Nothing changes silently.' })).toBeInTheDocument()
  })

  it('demonstrates sign-in and count-review panels', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /riley west/i }))
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
    expect(screen.getByDisplayValue('riley.west@demo.invalid')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))

    fireEvent.click(screen.getByRole('button', { name: /review & submit/i }))
    expect(screen.getByRole('heading', { name: 'Review physical count' })).toBeInTheDocument()
    expect(screen.getAllByText('-6 units')).toHaveLength(2)
    fireEvent.mouseDown(document.querySelector('.drawer-backdrop')!)
    expect(screen.queryByRole('heading', { name: 'Review physical count' })).not.toBeInTheDocument()
  })

  it('submits a changed count and exposes the audit record', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /add 1/i }))
    fireEvent.click(screen.getByRole('button', { name: /review & submit/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit count' }))

    expect(screen.getByRole('status')).toHaveTextContent('Physical count submitted.')
    fireEvent.click(screen.getAllByRole('button', { name: /activity/i })[0])
    expect(screen.getByText(/Submitted Fall inventory/)).toBeInTheDocument()
    expect(screen.getByText('count.submitted')).toBeInTheDocument()
  })

  it('records an issue in inventory, cadet totals, and the audit trail', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /cadets/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /alex morgan/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Issue items' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm issue' }))

    expect(screen.getByRole('status')).toHaveTextContent('Issued 1 Navy PT Shirt.')
    expect(screen.getByRole('button', { name: /alex morgan.*7.*issued items/i })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /activity/i })[0])
    expect(screen.getByText('Issued 1 × Navy PT Shirt')).toBeInTheDocument()
  })

  it('searches cadets and walks through issue and return previews', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /cadets/i })[0])
    fireEvent.change(screen.getByLabelText('Search cadets'), { target: { value: 'alex' } })
    expect(screen.getByRole('button', { name: /alex morgan/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /jordan carter/i })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /alex morgan/i }))
    expect(screen.getByRole('heading', { name: 'Alex Morgan' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Issue items' }))
    expect(screen.getByRole('heading', { name: 'Issue selected items' })).toBeInTheDocument()
    expect(screen.getAllByRole('checkbox')).toHaveLength(3)

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.click(screen.getByRole('button', { name: /alex morgan/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Return item' }))
    expect(screen.getByRole('heading', { name: 'Record a return' })).toBeInTheDocument()
  })

  it.each([
    ['Issue bundles', 'Bundle selection'],
    ['Still needed', 'Still Needed'],
    ['Roles & access', 'Roles & access'],
    ['Import preview', 'Import 24 cadets'],
    ['Annual rollover', 'Annual rollover preview'],
  ])('opens the %s command-center preview', (action, heading) => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /more/i })[0])
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${action}(?:$|\\s)`, 'i') }))
    expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument()
  })

  it('navigates from roster administration to import and rollover previews', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /more/i })[0])
    fireEvent.click(screen.getByRole('button', { name: /roster administration/i }))
    expect(screen.getByRole('heading', { name: 'Cadet roster' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Import roster' }))
    expect(screen.getByRole('heading', { name: 'Import 24 cadets' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }))
    fireEvent.click(screen.getByRole('button', { name: /roster administration/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Preview rollover' }))
    expect(screen.getByRole('heading', { name: 'Annual rollover preview' })).toBeInTheDocument()
  })
})
