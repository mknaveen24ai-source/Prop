// Jurisdiction / sanctions screening — one list, used everywhere.
//
// ── The problem this replaces ────────────────────────────────────────────────
//
// Screening was a dropdown. routes/auth.js held a BLOCKED_COUNTRIES array of
// six country NAMES, checked against a value the user picked themselves, and
// the ALLOWED_COUNTRIES list it validated against contained the entry 'Other' —
// so anyone in a restricted jurisdiction selected "Other" and was admitted. The
// published Terms bar eight jurisdictions (they add Russia and Belarus); the
// code barred six. Nothing was checked at payout, which is the point at which
// money actually leaves for a wallet.
//
// ── What this does ──────────────────────────────────────────────────────────
//
// Two lists that mean the same thing in two vocabularies — the ISO codes the
// edge gives us, and the display names the signup form gives us — and one
// predicate that checks both.
//
// ── On "unknown" ────────────────────────────────────────────────────────────
//
// Country comes from utils/requestGeo.js, which reads a CDN header and returns
// null when there is no CDN in front of the app. Unknown is therefore NOT
// treated as a refusal: doing so would lock out every deployment that is not
// behind Cloudflare/Vercel/Fastly, including local development. An unknown
// origin falls back to the declared country alone, and the caller records that
// the check was made without a geo signal — so the gap is visible in the audit
// trail rather than silently assumed away.
//
// This is screening, not compliance. It stops the casual case and creates a
// record. It does not defeat a VPN, and it is not a substitute for a real
// sanctions-screening provider if the business needs one.

const { getRequestCountry } = require('./requestGeo')

// ISO 3166-1 alpha-2. Must stay in step with RESTRICTED_COUNTRY_NAMES below and
// with the jurisdictions listed in frontend/src/pages/TermsOfService.jsx.
const RESTRICTED_ISO = new Set([
  'US', // United States
  'CA', // Canada
  'IR', // Iran
  'KP', // North Korea
  'CU', // Cuba
  'SY', // Syria
  'RU', // Russia
  'BY'  // Belarus
])

// The same jurisdictions as the signup form spells them.
const RESTRICTED_COUNTRY_NAMES = new Set([
  'united states',
  'canada',
  'iran',
  'north korea',
  'cuba',
  'syria',
  'russia',
  'belarus'
])

const ISO_TO_NAME = {
  US: 'the United States',
  CA: 'Canada',
  IR: 'Iran',
  KP: 'North Korea',
  CU: 'Cuba',
  SY: 'Syria',
  RU: 'Russia',
  BY: 'Belarus'
}

function isRestrictedCountryName(name) {
  return RESTRICTED_COUNTRY_NAMES.has(String(name || '').trim().toLowerCase())
}

function isRestrictedIso(code) {
  return RESTRICTED_ISO.has(String(code || '').trim().toUpperCase())
}

/**
 * Screen a request against the restricted-jurisdiction list.
 *
 * Checks the network origin (when the edge gives us one) and the declared
 * country (when the caller has one) independently — either being restricted is
 * a refusal, because a user in a barred jurisdiction who declares an allowed
 * one is exactly the case worth catching.
 *
 * @param {object}  req
 * @param {string} [declaredCountry] the country the user selected, if any
 * @returns {{allowed: boolean, reason: string|null, detectedCountry: string|null,
 *            declaredCountry: string|null, geoAvailable: boolean, matchedOn: string|null}}
 */
function screenJurisdiction(req, declaredCountry = null) {
  const detectedCountry = getRequestCountry(req)
  const geoAvailable = detectedCountry != null

  if (geoAvailable && isRestrictedIso(detectedCountry)) {
    return {
      allowed: false,
      reason: `Our services are not available in ${ISO_TO_NAME[detectedCountry] || detectedCountry}.`,
      detectedCountry,
      declaredCountry: declaredCountry || null,
      geoAvailable,
      matchedOn: 'network'
    }
  }

  if (declaredCountry && isRestrictedCountryName(declaredCountry)) {
    return {
      allowed: false,
      reason: `Our services are not available in ${String(declaredCountry).trim()}.`,
      detectedCountry,
      declaredCountry,
      geoAvailable,
      matchedOn: 'declared'
    }
  }

  return {
    allowed: true,
    reason: null,
    detectedCountry,
    declaredCountry: declaredCountry || null,
    geoAvailable,
    matchedOn: null
  }
}

module.exports = {
  RESTRICTED_ISO,
  RESTRICTED_COUNTRY_NAMES,
  isRestrictedCountryName,
  isRestrictedIso,
  screenJurisdiction
}
