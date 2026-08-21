/**
 * Offline shell service worker.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * NOT bundled. `offlineShellPlugin()` in vite.config.mjs reads this file at
 * build time, substitutes the two __PLACEHOLDER__ tokens with the real asset
 * list and build id, and emits the result as `build/sw.js`.
 *
 * ── Scope: the shell, and only the shell ──
 *
 * This caches JS, CSS, fonts and the HTML entry point. It does NOT cache a
 * single API response, and it never will. On a platform where the numbers on
 * screen are somebody's account balance, an open position and a drawdown limit,
 * serving a stale one from a cache is worse than showing an error: the error is
 * obviously wrong, and the stale figure is invisibly wrong. Traders act on
 * invisibly wrong numbers.
 *
 * So `/api` and `/socket.io` are not merely "network first" here -- they are not
 * intercepted at all. A request this worker does not call `respondWith` on goes
 * to the network exactly as though no service worker existed, which is the only
 * behaviour that cannot degrade.
 *
 * ── Why skipWaiting + clientsClaim ──
 *
 * The default lifecycle leaves an updated worker waiting until every tab
 * closes. Traders keep the dashboard open for days, so a deploy could sit
 * unactivated indefinitely while the shell served the previous build's JS
 * against the current build's API. Taking over immediately means the worst case
 * is one reload, not an indefinitely stale client.
 */

const BUILD_ID = '__BUILD_ID__'
const CACHE_NAME = 'propfirm-shell-' + BUILD_ID

/** Hashed build output plus the entry document. Substituted at build time. */
const PRECACHE_URLS = __PRECACHE_MANIFEST__

/** Paths this worker must never answer for. */
const NEVER_HANDLE = ['/api', '/socket.io']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      // `cache.addAll` rejects the whole batch if any single request fails,
      // which would leave the worker uninstalled and the app with no shell at
      // all. Each URL is added independently so one missing font cannot take
      // the install down with it.
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined))
      ))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('propfirm-shell-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  // Lets the page trigger activation itself once it has told the user.
  if (event.data === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  // Anything other than a plain GET can carry state -- a trade, a payout
  // approval. Never touch it.
  if (request.method !== 'GET') return

  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }

  // Cross-origin (TradingView's widget, Google Fonts) is left to the browser.
  if (url.origin !== self.location.origin) return

  if (NEVER_HANDLE.some((prefix) => url.pathname.startsWith(prefix))) return

  // Navigations: network first, so a reload always gets the current build when
  // the network allows. The cached shell is the offline fallback only.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then(
        (cached) => cached || Response.error()
      ))
    )
    return
  }

  // Build assets carry a content hash in the filename, so a hit is by
  // definition the right bytes and cache-first costs nothing in staleness.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        // Only same-origin, fully successful responses are worth storing.
        // An opaque or partial response cached here would be served forever.
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response
        }
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
        return response
      })
    })
  )
})
