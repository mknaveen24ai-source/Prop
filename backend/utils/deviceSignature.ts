/**
 * Device signature parsing.
 *
 * The frontend collects a device component vector (canvas render hash, WebGL
 * renderer, audio context hash, font metrics, screen geometry, …) and sends it
 * as a base64 JSON blob on the X-Device-Signature header — see
 * frontend/src/utils/deviceSignature.js.
 *
 * Two things this module is strict about:
 *
 *  1. The client's own hash is IGNORED. The composite fingerprint is recomputed
 *     here from the component vector. A client that can set a header can set any
 *     hash it likes, so a client-supplied one would let a passing service pick a
 *     different fingerprint per account and defeat the whole signal.
 *
 *  2. The header is attacker-controlled input on an unauthenticated route, so it
 *     is size-capped and shape-validated before anything touches JSON.parse.
 *
 * Even so, a device signature is a SIGNAL, not proof — it is spoofable by anyone
 * willing to patch their browser. accountLinkingService weights it accordingly
 * and never enforces on it alone.
 */

import nodeCrypto from 'node:crypto'
import type { DeviceSignatureV1 } from '@propfirm/contracts'
import type { RequestHandler } from 'express'

const HEADER_NAME = 'x-device-signature'

// A well-formed signature is ~600 bytes. 4KB leaves generous headroom while
// keeping a hostile client from making us base64-decode something large.
const MAX_HEADER_BYTES = 4096
const MAX_COMPONENTS = 32
const MAX_COMPONENT_LENGTH = 512

/**
 * Components that go into the composite fingerprint.
 *
 * Deliberately excludes anything that legitimately changes for the same physical
 * device — window/viewport size (resizing), devicePixelRatio (plugging in an
 * external monitor), and language (travel). Including those would make the
 * fingerprint churn and silently stop matching, which reads as "no link found"
 * rather than as a failure.
 */
const STABLE_COMPONENTS = Object.freeze([
  'canvas',
  'webgl',
  'webglVendor',
  'audio',
  'fonts',
  'platform',
  'hardwareConcurrency',
  'deviceMemory',
  'colorDepth',
  'screen',
  'timezone',
  'touchSupport'
])

function isPlainValue (value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Validate and normalize a decoded payload into a flat component map of strings.
 * Returns null when the payload is not shaped like a signature.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeComponents (raw: unknown): Record<string, string> | null {
  if (!isRecord(raw)) return null

  const components: Record<string, string> = {}
  let count = 0

  for (const key of Object.keys(raw)) {
    if (count >= MAX_COMPONENTS) break
    if (!/^[a-zA-Z0-9_]{1,32}$/.test(key)) continue

    const value = raw[key]
    if (!isPlainValue(value)) continue

    const normalized = String(value).slice(0, MAX_COMPONENT_LENGTH)
    if (!normalized) continue

    components[key] = normalized
    count += 1
  }

  return count > 0 ? components : null
}

/**
 * Recompute the composite fingerprint from the stable components.
 *
 * Returns null when too few stable components are present. A fingerprint built
 * from one or two weak values (say platform + colorDepth alone) would collide
 * across thousands of unrelated users, and a mass false link is worse than no
 * signal at all.
 */
function computeFingerprint (components: Readonly<Record<string, string>>): string | null {
  const parts = []
  for (const key of STABLE_COMPONENTS) {
    if (components[key]) parts.push(`${key}=${components[key]}`)
  }
  if (parts.length < 4) return null
  return nodeCrypto.createHash('sha256').update(parts.join('|')).digest('hex')
}

/**
 * Parse a raw header value into { hash, components } or null.
 * Never throws.
 */
function parseDeviceSignature (headerValue: unknown): DeviceSignatureV1 | null {
  try {
    if (!headerValue || typeof headerValue !== 'string') return null
    if (Buffer.byteLength(headerValue, 'utf8') > MAX_HEADER_BYTES) return null

    const decoded = Buffer.from(headerValue, 'base64').toString('utf8')
    if (!decoded || decoded.length > MAX_HEADER_BYTES) return null

    const payload: unknown = JSON.parse(decoded)
    if (!isRecord(payload)) return null
    // `payload.hash`, if the client sent one, is discarded on purpose.
    const components = sanitizeComponents(payload.components)
    if (!components) return null

    const hash = computeFingerprint(components)
    if (!hash) return null

    const rawVersion = payload.v
    const parsedVersion = typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string'
        ? Number(rawVersion)
        : 1
    const version = Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1
    return { hash, components, version }
  } catch {
    return null
  }
}

/**
 * Express middleware. Attaches req.deviceSignature (or leaves it undefined) and
 * always calls next() — a bad signature must never block a request.
 */
const deviceSignatureMiddleware: RequestHandler = (req, _res, next): void => {
  const header = req.headers && req.headers[HEADER_NAME]
  const parsed = parseDeviceSignature(header)
  if (parsed) req.deviceSignature = parsed
  next()
}

export {
  HEADER_NAME,
  STABLE_COMPONENTS,
  parseDeviceSignature,
  computeFingerprint,
  sanitizeComponents,
  deviceSignatureMiddleware
}
