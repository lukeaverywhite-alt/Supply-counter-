import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

const dist = join(process.cwd(), 'dist')
const mountPath = '/Supply-counter-/'
const requiredFiles = ['index.html', 'manifest.webmanifest', 'sw.js', 'argus-mark.svg']

for (const file of requiredFiles) {
  if (!existsSync(join(dist, file))) throw new Error(`Production build is missing ${file}`)
}

const contentTypes = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}

const server = createServer((request, response) => {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
  if (!requestPath.startsWith(mountPath)) {
    response.writeHead(404).end()
    return
  }

  const relativePath = requestPath.slice(mountPath.length) || 'index.html'
  const filePath = normalize(join(dist, relativePath))
  if (!filePath.startsWith(dist) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404).end()
    return
  }

  response.setHeader('content-type', contentTypes[extname(filePath)] ?? 'application/octet-stream')
  createReadStream(filePath).pipe(response)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

try {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Smoke-test server did not start')
  const baseUrl = `http://127.0.0.1:${address.port}${mountPath}`
  const page = await fetch(baseUrl)
  if (!page.ok) throw new Error(`Deployed page returned HTTP ${page.status}`)

  const html = await page.text()
  const references = [...html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)].map((match) => match[1])
  if (!references.some((path) => path.endsWith('.js'))) throw new Error('Built page has no JavaScript bundle')
  if (!references.some((path) => path.endsWith('.css'))) throw new Error('Built page has no stylesheet bundle')

  for (const reference of references) {
    const response = await fetch(new URL(reference, baseUrl))
    if (!response.ok) throw new Error(`${reference} returned HTTP ${response.status}`)
  }

  const manifestResponse = await fetch(new URL('./manifest.webmanifest', baseUrl))
  const manifest = await manifestResponse.json()
  if (manifest.start_url !== './' || manifest.scope !== './' || manifest.display !== 'standalone') {
    throw new Error('Manifest is not configured for a repository-path standalone deployment')
  }

  const worker = readFileSync(join(dist, 'sw.js'), 'utf8')
  if (!worker.includes("'./manifest.webmanifest'")) throw new Error('Service worker does not cache the relative manifest')

  console.log(`Deployment smoke test passed at ${baseUrl}`)
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}
