const CACHE_PREFIX = 'argus-shell-'
const CACHE = `${CACHE_PREFIX}v2`
const SHELL = ['./', './manifest.webmanifest', './argus-mark.svg']

self.addEventListener('install', event => {
  // Do not skipWaiting: an active workflow must never be reloaded underneath a user.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)))
})

self.addEventListener('activate', event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))),
    self.clients.claim(),
  ]))
})

self.addEventListener('message', event => {
  if (event.data?.type === 'ARGUS_ACTIVATE_UPDATE') self.skipWaiting()
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put('./', response.clone()))
      return response
    }).catch(() => caches.match('./')))
    return
  }
  // Assets use cache-first with background refresh. Failed scripts/styles never
  // receive the HTML application shell, which would cause misleading MIME errors.
  if (['script', 'style', 'image', 'font', 'manifest'].includes(request.destination)) event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) caches.open(CACHE).then(cache => cache.put(request, response.clone()))
      return response
    })),
  )
})
