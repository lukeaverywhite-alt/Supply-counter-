import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const malformed = [...css.matchAll(/var\(--[\w-]+\)[\da-fA-F]{2,}/g)].map(match => match[0])
if (malformed.length) throw new Error(`Malformed CSS variable substitutions: ${malformed.join(', ')}`)
let depth = 0
for (const character of css.replaceAll(/\/\*[\s\S]*?\*\//g, '')) { if (character === '{') depth++; if (character === '}') depth--; if (depth < 0) break }
if (depth !== 0) throw new Error('Unbalanced CSS block braces.')
process.stdout.write('CSS structural checks passed.\n')
