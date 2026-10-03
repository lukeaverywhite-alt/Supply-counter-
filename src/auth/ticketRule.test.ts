import { describe, expect, it } from 'vitest'
import type { ArgusRole } from '../distributed/types'
import { ticketRuleViolation } from './authorization'

const ROLES: ArgusRole[] = ['MASTER', 'INSTRUCTOR', 'SUPPLY_OFFICER', 'SUPPLY_ASSISTANT']

describe('who may make a ticket for which role (D4)', () => {
  it('lets a Master make a ticket for every role', () => {
    for (const role of ROLES) expect(ticketRuleViolation('MASTER', role)).toBeUndefined()
  })
  it('lets an Instructor make tickets for the cadet roles only, and says which rule refuses the rest', () => {
    expect(ticketRuleViolation('INSTRUCTOR', 'SUPPLY_OFFICER')).toBeUndefined()
    expect(ticketRuleViolation('INSTRUCTOR', 'SUPPLY_ASSISTANT')).toBeUndefined()
    for (const role of ['MASTER', 'INSTRUCTOR'] as const) expect(ticketRuleViolation('INSTRUCTOR', role)).toMatch(/Instructor can make tickets only for Supply Officers and Supply Assistants.*Only a Master/)
  })
  it('gives cadet roles no ticket-making at all', () => {
    for (const issuer of ['SUPPLY_OFFICER', 'SUPPLY_ASSISTANT'] as const) for (const role of ROLES) expect(ticketRuleViolation(issuer, role)).toMatch(/Only a Master or an Instructor/)
  })
})
