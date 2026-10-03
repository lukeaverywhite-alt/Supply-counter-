import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A guard against drift for docs/demo-argus-cadets.md (mw-kmgi38.9). In that file every phrase in **bold** is something written on
 * a screen (a button, a field, a heading, a banner); text that is not on a screen is never bold (except the **Expect:** marker). So each bold phrase must still
 * occur in a source file of the app, or the screen was renamed and the demo is out of date. The match ignores case, since some
 * labels are shown in capitals by the stylesheet. A label a screen builds from parts ("Confirm Issue", "Issue Complete") is quoted,
 * not bold, so it is not guarded.
 */
const demo = readFileSync('docs/demo-argus-cadets.md', 'utf8')

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
const source = sourceFiles('src').map(path => readFileSync(path, 'utf8')).join('\n').toLowerCase()

// "Expect:" is the demo's own marker for what right looks like, not a label.
const labels = [...new Set([...demo.matchAll(/\*\*([^*]+)\*\*/g)].map(match => match[1].replace(/\s+/g, ' ').trim()).filter(text => !/^Expect:?$/.test(text)))]

describe('docs/demo-argus-cadets.md', () => {
  it('quotes the labels of the cadet screens', () => {
    for (const label of ['Cadet ticket for', 'My gear', 'Have', 'Still needed', 'Notices', 'Notice to all cadets', 'Message this cadet', 'Make phone ticket', 'Refresh', 'Leave this unit', 'I have a ticket']) {
      expect(labels, `the demo must quote "${label}"`).toContain(label)
    }
  })

  it('quotes only labels that occur in src/', () => {
    expect(labels.length).toBeGreaterThan(20)
    const missing = labels.filter(label => !source.includes(label.toLowerCase()))
    expect(missing, `labels in the demo that no source file contains: ${missing.join(' | ')}`).toEqual([])
  })

  it('links only to files that exist', () => {
    const links = [...demo.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1]).filter(link => !/^https?:/.test(link))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(existsSync(join('docs', link)), link).toBe(true)
  })

  it('has numbered steps, each with something to expect', () => {
    const steps = [...demo.matchAll(/^## (\d+)\. /gm)]
    expect(steps.length).toBeGreaterThanOrEqual(8)
    const sections = demo.split(/^## \d+\. /m).slice(1)
    for (const section of sections) expect(section, section.slice(0, 40)).toMatch(/\*\*Expect:?\*\*/)
  })
})
