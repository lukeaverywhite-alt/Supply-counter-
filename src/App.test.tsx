import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

describe('A.R.G.U.S. count workflow', () => {
  it('increments and resets the draft physical count', () => {
    render(<App />)
    expect(document.querySelector('.count-display strong')).toHaveTextContent('18')
    fireEvent.click(screen.getByRole('button', { name: /add 1/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('19')
    fireEvent.click(screen.getByRole('button', { name: /reset to official count/i }))
    expect(document.querySelector('.count-display strong')).toHaveTextContent('24')
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
  })

  it('opens the cadet and audit views from primary navigation', () => {
    render(<App />)
    fireEvent.click(screen.getAllByRole('button', { name: /cadets/i })[0])
    expect(screen.getByRole('heading', { name: 'Cadet property records.' })).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: /activity/i })[0])
    expect(screen.getByRole('heading', { name: 'Nothing changes silently.' })).toBeInTheDocument()
  })
})
