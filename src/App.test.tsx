import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
})
