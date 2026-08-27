// Edge-provided request country.
//
// The platform has no IP-geolocation dependency and this deliberately does not
// add one — no network call, no database, no bundled GeoIP file. It reads the
// country header the CDN/edge in front of the app already attaches, if there is
// one, and otherwise returns null.
//
// Returning null matters as much as returning a country: every consumer of
// `login_logs.country` (the signup-vs-login geo-mismatch signal on the admin
// risk page) treats null as "unknown" and never as "mismatch", so a deployment
// with no CDN in front of it simply has no geo signal rather than a wrong one.
//
// Header order is most-specific-first: a deployment behind two of these should
// trust the innermost proxy, which is the one whose header arrives last in the
// list below only if it also overwrites — in practice only one is ever present.
import type { Request as ExpressRequest } from 'express'

const COUNTRY_HEADERS: readonly string[] = [
  'cf-ipcountry',            // Cloudflare
  'x-vercel-ip-country',     // Vercel
  'x-appengine-country',     // Google App Engine
  'fastly-client-country',   // Fastly
  'x-geo-country'            // generic / self-configured nginx
]

// ISO 3166-1 alpha-2, plus Cloudflare's 'XX' (unknown) and 'T1' (Tor) sentinels
// which are explicitly NOT countries and must not be stored as if they were.
const ISO_ALPHA2 = /^[A-Z]{2}$/
const NON_COUNTRY_SENTINELS = new Set(['XX', 'T1'])

function getRequestCountry (
  req: Pick<ExpressRequest, 'get'> | null | undefined
): string | null {
  if (!req) return null

  for (const header of COUNTRY_HEADERS) {
    const raw = req.get(header)
    if (!raw) continue
    const value = String(raw).trim().toUpperCase()
    if (!ISO_ALPHA2.test(value)) continue
    if (NON_COUNTRY_SENTINELS.has(value)) continue
    return value
  }

  return null
}

export { getRequestCountry, COUNTRY_HEADERS }
