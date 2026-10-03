import { describe, expect, it } from 'vitest'
import { TICKET_CODE_CHARACTERS, TICKET_SECRET_BYTES, TicketCodeError, decodeTicketCode, encodeTicketCode, makeTicketSecret } from './ticketCode'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const fixedSecret = () => Uint8Array.from({ length: TICKET_SECRET_BYTES }, (_, index) => (index * 37 + 11) & 0xff)
function fault(text: string) {
  try { decodeTicketCode(text) } catch (error) { if (error instanceof TicketCodeError) return { fault: error.fault, message: error.message }; throw error }
  throw new Error('decoded without a fault')
}
/** Replaces the character at a position in the ungrouped code with a different alphabet character. */
function changeCharacter(code: string, position: number, step = 1) {
  const plain = code.replaceAll('-', '')
  const changed = ALPHABET[(ALPHABET.indexOf(plain[position]) + step) % ALPHABET.length]
  return `${plain.slice(0, position)}${changed}${plain.slice(position + 1)}`
}

describe('ticket secrets', () => {
  it('are 128 random bits, different every time', () => {
    const one = makeTicketSecret(), two = makeTicketSecret()
    expect(one).toHaveLength(16)
    expect(one).not.toEqual(two)
  })
})

describe('ticket codes', () => {
  it('round-trip a secret through a grouped Crockford base32 code of at most 40 characters', () => {
    for (const secret of [fixedSecret(), makeTicketSecret(), new Uint8Array(16), new Uint8Array(16).fill(0xff)]) {
      const code = encodeTicketCode(secret)
      expect(code.length).toBeLessThanOrEqual(40)
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/)
      expect(code.replaceAll('-', '')).toHaveLength(TICKET_CODE_CHARACTERS)
      expect(decodeTicketCode(code)).toEqual(secret)
    }
  })

  it('reads a code typed with spaces, line breaks, hyphens, lower case and the Crockford look-alikes', () => {
    const secret = fixedSecret(), code = encodeTicketCode(secret)
    const groups = code.split('-')
    const messy = ` ${groups[0].toLowerCase()}  ${groups[1]}\n${groups[2].toLowerCase()}\r\n-${groups[3]}\t- ${groups[4]} -${groups[5].toLowerCase()} `
    expect(decodeTicketCode(messy)).toEqual(secret)
    const withLookAlikes = code.replaceAll('0', 'O').replaceAll('1', 'l')
    expect(withLookAlikes).not.toBe(code)
    expect(decodeTicketCode(withLookAlikes)).toEqual(secret)
    expect(decodeTicketCode(code.replaceAll('1', 'I').toLowerCase())).toEqual(secret)
  })

  it('refuses any single changed character, in the secret or in the check group, as a character that is wrong', () => {
    const code = encodeTicketCode(fixedSecret())
    for (let position = 0; position < TICKET_CODE_CHARACTERS; position++) {
      for (const step of [1, 7, 16, 31]) {
        const result = fault(changeCharacter(code, position, step))
        expect(result.fault).toBe('CHARACTER_WRONG')
        expect(result.message).toMatch(/a character is wrong/i)
      }
    }
  })

  it('refuses a character that is never used in ticket codes as a character that is wrong', () => {
    const plain = encodeTicketCode(fixedSecret()).replaceAll('-', '')
    expect(fault(`${plain.slice(0, 9)}U${plain.slice(10)}`).fault).toBe('CHARACTER_WRONG')
    expect(fault(`${plain.slice(0, 9)}*${plain.slice(10)}`).fault).toBe('CHARACTER_WRONG')
  })

  it('refuses a code with an extra character as a character that is wrong', () => {
    const plain = encodeTicketCode(fixedSecret()).replaceAll('-', '')
    expect(fault(`${plain}7`).fault).toBe('CHARACTER_WRONG')
  })

  it('refuses a code cut short as part missing', () => {
    const code = encodeTicketCode(fixedSecret())
    for (const cut of [code.slice(0, -1), code.slice(0, 29), code.split('-').slice(0, 5).join('-'), code.slice(5)]) {
      const result = fault(cut)
      expect(result.fault).toBe('PART_MISSING')
      expect(result.message).toMatch(/part of this ticket code is missing/i)
    }
  })

  it('refuses text that is not a ticket code', () => {
    for (const text of ['', '   \n ', 'ARGUS-JOIN-1:eyJpZGVudGl0eSI6InAyNTY6YWJjIn0:0a1b2c3d', 'https://example.org/argus/', `${'7'.repeat(TICKET_CODE_CHARACTERS * 2)}`]) {
      const result = fault(text)
      expect(result.fault).toBe('NOT_A_TICKET_CODE')
      expect(result.message).toMatch(/not a ticket code/i)
    }
  })

  it('refuses to encode a secret of the wrong size', () => {
    expect(() => encodeTicketCode(new Uint8Array(15))).toThrow(/16 bytes/)
  })
})
