import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** jsdom does no layout, so the phone fit is checked in the stylesheet's text (the pattern of src/unit/screens/ticketLayout.test.ts). */
const css = readFileSync('src/cadet/cadet.css', 'utf8')
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replaceAll('.', '\\.').replaceAll(' ', '\\s+')}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''

describe('the cadet screen fits a phone', () => {
  it('has no fixed width over 360 px', () => {
    const widths = [...css.matchAll(/(?<![\w-])((?:min-|max-)?width)\s*:\s*([^;}]*)/g)].flatMap(([, , value]) => [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1])))
    expect(widths.length).toBeGreaterThan(0)
    for (const width of widths) expect(width).toBeLessThanOrEqual(360)
  })
  it('lays the lines out in one column that wraps long item names', () => {
    expect(rule('.cadet-app .cadet-lines li')).toMatch(/flex-wrap:\s*wrap/)
    expect(rule('.cadet-app .cadet-lines li')).toMatch(/overflow-wrap:\s*anywhere/)
  })
  it('is scoped under .cadet-app, so a single-class rule of styles.css (which loads after) cannot undo it', () => {
    const selectors = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|\})\s*([^{}@]+)\{/g)].map(match => match[1].trim())
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) expect(selector).toMatch(/^\.cadet-app\b/)
  })
})
