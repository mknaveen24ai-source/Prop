/**
 * Request IP extraction and subnet normalization.
 *
 * The `x-forwarded-for` expression used to be copy-pasted in five handlers
 * (routes/auth.js login + 2FA + ToS, routes/trades/open.js, routes/admin/auth.js),
 * each with a slightly different fallback string. Centralizing it means the
 * account-linking detector sees one consistent representation.
 *
 * Deliberately dependency-free: services/accountLinkingService.js and its tests
 * need getIpSubnet(), and pulling utils/security.js in for it would drag helmet,
 * express-rate-limit and the Redis store along with it.
 *
 * Trust-proxy handling lives in server.js (resolveTrustProxySetting, ~line 109).
 * When that is configured correctly `req.ip` is already the real client, but the
 * header is still read first to match the pre-existing behaviour of every call
 * site this replaced.
 */

import type { Request as ExpressRequest } from 'express'

const UNKNOWN = 'unknown'

/**
 * Strip an IPv4-mapped IPv6 prefix and any trailing :port some proxies append.
 */
function cleanIp (raw: unknown): string | null {
  let value = String(raw || '').trim()
  if (!value) return null

  // ::ffff:203.0.113.7 → 203.0.113.7
  const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mapped?.[1]) value = mapped[1]

  // 203.0.113.7:51234 → 203.0.113.7 (IPv4 only; a bare IPv6 has many colons)
  const withPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (withPort?.[1]) value = withPort[1]

  // [2001:db8::1]:443 → 2001:db8::1
  const bracketed = value.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/i)
  if (bracketed?.[1]) value = bracketed[1]

  return value || null
}

function isIPv4 (value: string): boolean {
  const parts = String(value).split('.')
  if (parts.length !== 4) return false
  return parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function isIPv6 (value: string): boolean {
  // Loose but sufficient: hex groups and colons only, at least two colons.
  return /^[0-9a-f:]+$/i.test(value) && (value.match(/:/g) || []).length >= 2
}

/**
 * The client IP for this request, or 'unknown' when it cannot be determined.
 * Always returns a string so existing `ip_address TEXT NOT NULL`-ish inserts and
 * rate-limit keys keep working unchanged.
 */
function getRequestIp (
  req: Pick<ExpressRequest, 'headers' | 'ip'> | null | undefined,
  fallback = UNKNOWN
): string {
  if (!req) return fallback

  const header = req.headers && req.headers['x-forwarded-for']
  if (header) {
    // Left-most entry is the original client; the rest are proxy hops.
    const first = String(header).split(',')[0]
    const cleaned = cleanIp(first)
    if (cleaned) return cleaned
  }

  const direct = cleanIp(req.ip)
  return direct || fallback
}

/**
 * Expand an IPv6 address to its full eight groups so a prefix can be taken.
 * Returns null for anything that does not parse.
 */
function expandIPv6 (value: string): string[] | null {
  const halves = String(value).toLowerCase().split('::')
  if (halves.length > 2) return null

  const headValue = halves[0] ?? ''
  const tailValue = halves[1] ?? ''
  const head = headValue ? headValue.split(':').filter(Boolean) : []
  const tail = halves.length === 2 && tailValue ? tailValue.split(':').filter(Boolean) : []

  if (halves.length === 1) {
    if (head.length !== 8) return null
    return head.map(group => group.padStart(4, '0'))
  }

  const missing = 8 - (head.length + tail.length)
  if (missing < 0) return null

  return [
    ...head,
    ...Array.from({ length: missing }, () => '0'),
    ...tail
  ].map(group => group.padStart(4, '0'))
}

/**
 * Normalize an IP to the network it belongs to: IPv4 → /24, IPv6 → /48.
 *
 * /24 is deliberately coarse. It groups a household or a small office together,
 * which is exactly the point — but it also groups unrelated customers of the
 * same ISP block and mobile CGNAT users. That is why subnet matches carry a low
 * weight and are entropy-discounted in accountLinkingService rather than being
 * treated as proof on their own.
 *
 * Returns null for 'unknown', private/loopback ranges (a shared 127.0.0.1 or
 * 10.x is an artefact of misconfigured proxying, not a real link), and anything
 * unparseable.
 */
function getIpSubnet (rawIp: unknown): string | null {
  const value = cleanIp(rawIp)
  if (!value || value === UNKNOWN) return null

  if (isIPv4(value)) {
    const octets = value.split('.').map(Number)
    const [a, b] = octets
    const c = octets[2]
    if (a === undefined || b === undefined || c === undefined) return null

    // Loopback / link-local / private / CGNAT — carries no linking information.
    if (a === 127 || a === 0 || a === 10) return null
    if (a === 169 && b === 254) return null
    if (a === 192 && b === 168) return null
    if (a === 172 && b >= 16 && b <= 31) return null
    if (a === 100 && b >= 64 && b <= 127) return null

    return `${a}.${b}.${c}.0/24`
  }

  if (isIPv6(value)) {
    const groups = expandIPv6(value)
    if (!groups) return null
    const [first, second, third] = groups
    if (first === undefined || second === undefined || third === undefined) return null

    const joined = groups.join('')
    if (/^0{31}1$/.test(joined)) return null      // ::1 loopback
    if (/^0{32}$/.test(joined)) return null       // :: unspecified
    if (/^fe[89ab]/.test(first)) return null  // fe80::/10 link-local
    if (/^f[cd]/.test(first)) return null     // fc00::/7 unique-local

    return `${first}:${second}:${third}::/48`
  }

  return null
}

export { getRequestIp, getIpSubnet, UNKNOWN }
