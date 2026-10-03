import { describe, expect, it } from 'vitest'
import { deriveTicketKeys } from '../identity/ticketKeys'
import { TICKET_CHAIN_RECORD_FIELDS } from './schema'
import { openTicketRecord, sealTicketRecord } from './ticketRecord'

const keys = (fill: number) => deriveTicketKeys(new Uint8Array(16).fill(fill))

describe('the encrypted record at a ticket address', () => {
  it('shows only a version, a nonce and ciphertext on chain, and opens with the same ticket secret', async () => {
    const { wrappingKey, address } = await keys(1)
    const payload = await sealTicketRecord(wrappingKey, address, { kind: 'TICKET', displayName: 'Chris Cadet' })
    const onChain = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
    expect(Object.keys(onChain).sort()).toEqual([...TICKET_CHAIN_RECORD_FIELDS].sort())
    expect(new TextDecoder().decode(payload)).not.toContain('Chris')
    expect(await openTicketRecord(wrappingKey, address, payload)).toEqual({ kind: 'TICKET', displayName: 'Chris Cadet' })
  })

  it('is refused under another ticket’s key, at another ticket’s address, or when damaged', async () => {
    const one = await keys(1), two = await keys(2)
    const payload = await sealTicketRecord(one.wrappingKey, one.address, { kind: 'TICKET' })
    await expect(openTicketRecord(two.wrappingKey, one.address, payload)).rejects.toThrow(/could not be opened/i)
    // the same bytes replayed at another ticket's address do not open, even with the right key
    await expect(openTicketRecord(one.wrappingKey, two.address, payload)).rejects.toThrow(/could not be opened/i)
    const damaged = JSON.parse(new TextDecoder().decode(payload)) as { ct: string }
    damaged.ct = damaged.ct.slice(0, -4) + (damaged.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    await expect(openTicketRecord(one.wrappingKey, one.address, new TextEncoder().encode(JSON.stringify(damaged)))).rejects.toThrow(/could not be opened/i)
    await expect(openTicketRecord(one.wrappingKey, one.address, new TextEncoder().encode('not json'))).rejects.toThrow(/could not be opened/i)
  })

  it('never seals twice to the same ciphertext (fresh nonce each time)', async () => {
    const { wrappingKey, address } = await keys(1)
    const a = await sealTicketRecord(wrappingKey, address, { kind: 'TICKET' }), b = await sealTicketRecord(wrappingKey, address, { kind: 'TICKET' })
    expect(new TextDecoder().decode(a)).not.toBe(new TextDecoder().decode(b))
  })
})
