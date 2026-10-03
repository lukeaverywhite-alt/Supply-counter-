import { Hash } from '@bsv/sdk'

/**
 * The short code of an admission ticket (ADR 012): the ticket's 128-bit secret written in Crockford base32 with a
 * check group, grouped in fives with hyphens, e.g. 4K7QD-Z2M9X-0B8RT-WC5HN-1EY6P-G3VJA. It is the whole ticket: a QR
 * carries the same text, and everything else (the ticket key, its chain address, the wrapping key) is derived from
 * the secret. Readers forgive what people do when they retype a code: spaces, line breaks, hyphens, lower case, and
 * the Crockford look-alikes O for 0 and I or L for 1.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const TICKET_SECRET_BYTES = 16
const DATA_CHARACTERS = Math.ceil((TICKET_SECRET_BYTES * 8) / 5)
const CHECK_CHARACTERS = 4
export const TICKET_CODE_CHARACTERS = DATA_CHARACTERS + CHECK_CHARACTERS
const GROUP_SIZE = 5
const CHECK_LABEL = 'ARGUS-TICKET-CHECK-1:'

export type TicketCodeFault = 'NOT_A_TICKET_CODE' | 'CHARACTER_WRONG' | 'PART_MISSING'
export class TicketCodeError extends Error {
  constructor(readonly fault: TicketCodeFault, message: string) { super(message); this.name = 'TicketCodeError' }
}
const notATicket = () => new TicketCodeError('NOT_A_TICKET_CODE', 'This is not a ticket code.')
const characterWrong = (detail = 'check each group against the ticket') => new TicketCodeError('CHARACTER_WRONG', `A character is wrong in this ticket code: ${detail}.`)
const partMissing = () => new TicketCodeError('PART_MISSING', 'Part of this ticket code is missing: check that every group was copied.')

export function makeTicketSecret(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(TICKET_SECRET_BYTES))
}

/**
 * Four check characters over the data characters. The first is a weighted sum mod 32 with odd weights, so any one
 * changed data character always changes it; the other three are 15 bits of SHA-256, so random damage slips through
 * about once in a million tries.
 */
function checkGroup(data: number[]) {
  const weighted = data.reduce((sum, value, index) => (sum + (2 * index + 1) * value) % 32, 0)
  const [a, b] = Hash.sha256(`${CHECK_LABEL}${data.map(value => ALPHABET[value]).join('')}`, 'utf8')
  const bits = (a << 8) | b
  return [weighted, (bits >> 11) & 31, (bits >> 6) & 31, (bits >> 1) & 31]
}

export function encodeTicketCode(secret: Uint8Array): string {
  if (secret.length !== TICKET_SECRET_BYTES) throw new Error(`A ticket secret is ${TICKET_SECRET_BYTES} bytes.`)
  const data: number[] = []
  let buffer = 0, bits = 0
  for (const byte of secret) {
    buffer = (buffer << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; data.push((buffer >> bits) & 31) }
    buffer &= (1 << bits) - 1
  }
  if (bits) data.push((buffer << (5 - bits)) & 31)
  const plain = [...data, ...checkGroup(data)].map(value => ALPHABET[value]).join('')
  return plain.match(new RegExp(`.{1,${GROUP_SIZE}}`, 'g'))!.join('-')
}

/** Strips whitespace and hyphens, folds case and the Crockford look-alikes. */
export const normalizeTicketCode = (text: string) => text.replace(/[\s-]+/g, '').toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1')

/** Returns the ticket secret, or throws a TicketCodeError naming what is wrong in words a person can act on. */
export function decodeTicketCode(text: string): Uint8Array<ArrayBuffer> {
  const plain = normalizeTicketCode(text)
  const foreign = [...plain].filter(character => !ALPHABET.includes(character))
  // Other codes, links and prose: more than one stray character, or far too long to be a mistyped ticket.
  if (!plain || foreign.length > 1 || plain.length > TICKET_CODE_CHARACTERS + GROUP_SIZE) throw notATicket()
  if (foreign.length === 1) throw characterWrong(`“${foreign[0]}” is never used in ticket codes`)
  if (plain.length < TICKET_CODE_CHARACTERS) throw partMissing()
  if (plain.length > TICKET_CODE_CHARACTERS) throw characterWrong('it has an extra character')
  const values = [...plain].map(character => ALPHABET.indexOf(character))
  const data = values.slice(0, DATA_CHARACTERS), check = values.slice(DATA_CHARACTERS)
  if (checkGroup(data).some((value, index) => value !== check[index])) throw characterWrong()
  const secret = new Uint8Array(TICKET_SECRET_BYTES)
  let buffer = 0, bits = 0, index = 0
  for (const value of data) {
    buffer = (buffer << 5) | value; bits += 5
    if (bits >= 8) { bits -= 8; if (index < TICKET_SECRET_BYTES) secret[index++] = (buffer >> bits) & 0xff }
    buffer &= (1 << bits) - 1
  }
  // The last character's spare bits are always zero in a code this app wrote.
  if (buffer !== 0) throw characterWrong()
  return secret
}
