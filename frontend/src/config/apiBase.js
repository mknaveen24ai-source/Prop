/**
 * Single source of truth for the API origin.
 *
 * Previously this line was copy-pasted into 17 files as:
 *
 *     const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
 *
 * That `||` is a trap: an intentionally-empty VITE_API_URL (the correct value
 * behind a same-origin reverse proxy) is falsy, so every production build
 * silently fell back to the developer's own machine.
 *
 * Default is now the empty string, meaning "same origin":
 *   - dev:  vite.config.mjs proxies /api and /socket.io to localhost:5000
 *   - prod: deploy/nginx/propfirm.conf proxies the same two paths to backend:5000
 *
 * Because both environments resolve identically, index.html's CSP needs no
 * localhost exception and dev/prod cannot drift apart.
 *
 * Only set VITE_API_URL when the API genuinely lives on another origin, in
 * which case it must be a full origin with no trailing slash and no /api
 * suffix — request paths already include /api/...
 */

const configured = import.meta.env.VITE_API_URL

/** Axios baseURL. Empty string = same origin. */
export const API_BASE_URL =
  typeof configured === 'string' ? configured.replace(/\/+$/, '') : ''

/**
 * Socket.IO target. socket.io-client treats `undefined` as same-origin, but an
 * empty string as a URL to parse — so normalize to undefined.
 */
export const SOCKET_URL = API_BASE_URL || undefined

/**
 * Absolute URL builder for plain <a href> / <img src> targets that cannot go
 * through axios (statement downloads, KYC document previews, screenshots).
 */
export function apiUrl(path) {
  const suffix = String(path || '')
  return `${API_BASE_URL}${suffix.startsWith('/') ? suffix : `/${suffix}`}`
}

export default API_BASE_URL
