import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** jsdom does no layout, so the phone fit is checked in the stylesheets' text; it was also measured in Chromium at 320, 360 and 414 px wide (see the story's close-out). */
const gateCss = readFileSync('src/unit/screens/unit-gate.css', 'utf8')
const appCss = readFileSync('src/styles.css', 'utf8')
const rule = (css: string, selector: string) => css.match(new RegExp(`(?:^|\\})\\s*${selector.replaceAll('.', '\\.').replaceAll(' ', '\\s+')}\\s*\\{([^}]*)\\}`, 'm'))?.[1] ?? ''

describe('the issued-ticket box fits a phone', () => {
  it('is one column whichever stylesheet loads last: its grid rule is two classes, which out-ranks .validation\'s flex row', () => {
    expect(rule(gateCss, '.validation.ticket-result')).toMatch(/display:\s*grid/)
  })
  it('keeps the QR at most 260 px wide, border included', () => {
    expect(rule(gateCss, '.ticket-qr')).toMatch(/width:\s*min\(100%,\s*260px\)/)
    expect(rule(gateCss, '.ticket-qr')).toMatch(/box-sizing:\s*border-box/)
  })
  it('shows the code as a block of its own that may wrap to a second line, and lets the buttons wrap', () => {
    expect(rule(gateCss, '.ticket-code')).toMatch(/display:\s*block/)
    expect(rule(gateCss, '.ticket-code')).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule(gateCss, '.ticket-result .modal-actions')).toMatch(/flex-wrap:\s*wrap/)
    expect(appCss).toMatch(/\.modal-actions\{display:flex;flex-wrap:wrap/)
  })
})
