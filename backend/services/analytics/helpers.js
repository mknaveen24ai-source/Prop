// Shared primitives for the admin intelligence metric modules.
//
// Every module in this folder returns plain JSON-serialisable objects built
// from real queries against the read replica. Two rules hold throughout:
//
//   1. Nothing is estimated. If the data to answer a question does not exist,
//      the metric returns `{ available: false, reason }` and the UI renders a
//      "needs data" state — it never renders a plausible-looking number that
//      no query produced.
//
//   2. Numerics come back from pg as strings (numeric/bigint are not coerced to
//      JS number by node-postgres, deliberately, because they can exceed
//      Number.MAX_SAFE_INTEGER). Every value crossing into the response goes
//      through num()/int() so the frontend never has to guess whether a field
//      is "12.50" or 12.5.

function num (value, fallback = 0) {
  const parsed = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function int (value, fallback = 0) {
  const parsed = typeof value === 'number' ? Math.trunc(value) : parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function round (value, decimals = 2) {
  const parsed = num(value, NaN)
  if (!Number.isFinite(parsed)) return null
  const factor = 10 ** decimals
  return Math.round(parsed * factor) / factor
}

// Percentage that refuses to divide by zero and refuses to pretend 0/0 is 0%.
function pct (numerator, denominator, decimals = 2) {
  const d = num(denominator, 0)
  if (d === 0) return null
  return round((num(numerator, 0) / d) * 100, decimals)
}

function ratio (numerator, denominator, decimals = 2) {
  const d = num(denominator, 0)
  if (d === 0) return null
  return round(num(numerator, 0) / d, decimals)
}

function safeDiv (numerator, denominator) {
  const d = num(denominator, 0)
  return d === 0 ? null : num(numerator, 0) / d
}

// ── Date range ───────────────────────────────────────────────────────────────
// The admin UI sends `from`/`to` as YYYY-MM-DD (or omits them for "all time").
// Anything unparseable falls back to the default window rather than reaching a
// query — a malformed date must not turn into a full-table scan.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_WINDOW_DAYS = 30
const MAX_WINDOW_DAYS = 1095 // three years; beyond this the rollups are the only sane source

function parseDateRange (query = {}, { defaultDays = DEFAULT_WINDOW_DAYS } = {}) {
  const rawFrom = typeof query.from === 'string' && ISO_DATE.test(query.from) ? query.from : null
  const rawTo = typeof query.to === 'string' && ISO_DATE.test(query.to) ? query.to : null

  const today = new Date().toISOString().slice(0, 10)
  // Clamp the end of the range to today. A future `to` is harmless on its own,
  // but combined with the MAX_WINDOW_DAYS clamp below it would silently slide
  // the whole window past every row in the database — an operator who typed the
  // wrong year would get a blank page rather than an obviously wrong one.
  const to = (rawTo && rawTo < today) ? rawTo : today
  let from = rawFrom
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - defaultDays)
    from = d.toISOString().slice(0, 10)
  }

  // Guard inverted ranges rather than returning an empty result the operator
  // would read as "no activity".
  if (from > to) [from] = [to]

  const spanDays = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000
  )
  if (spanDays > MAX_WINDOW_DAYS) {
    const d = new Date(`${to}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - MAX_WINDOW_DAYS)
    from = d.toISOString().slice(0, 10)
  }

  return {
    from,
    to,
    // Inclusive of the whole `to` day — callers compare against timestamptz.
    fromTs: `${from} 00:00:00+00`,
    toTs: `${to} 23:59:59.999+00`,
    days: Math.max(1, spanDays)
  }
}

// ── Statistics ───────────────────────────────────────────────────────────────

function percentile (sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor(p * (sortedValues.length - 1)))
  )
  return sortedValues[index]
}

function median (values) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function mean (values) {
  if (!Array.isArray(values) || values.length === 0) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

function stdDev (values) {
  if (!Array.isArray(values) || values.length < 2) return null
  const m = mean(values)
  const variance = values.reduce((sum, v) => sum + ((v - m) ** 2), 0) / (values.length - 1)
  return Math.sqrt(variance)
}

// Coefficient of variation — the consistency measure the trader discipline
// score already uses, lifted here so risk and benchmarking share one definition.
function coefficientOfVariation (values) {
  const m = mean(values)
  if (!m) return null
  const sd = stdDev(values)
  return sd === null ? null : Math.abs(sd / m)
}

function pearson (a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return null
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const x = a.slice(0, n)
  const y = b.slice(0, n)
  const mx = mean(x)
  const my = mean(y)
  let numerator = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i += 1) {
    const vx = x[i] - mx
    const vy = y[i] - my
    numerator += vx * vy
    dx += vx * vx
    dy += vy * vy
  }
  const denominator = Math.sqrt(dx * dy)
  return denominator === 0 ? null : numerator / denominator
}

// Two-proportion z-test — used for A/B readouts and for "is this cohort's pass
// rate actually different". Returns null rather than a bogus p-value when the
// normal approximation does not hold (any expected cell below 5).
function twoProportionZTest (successesA, totalA, successesB, totalB) {
  if (!totalA || !totalB) return null
  const pA = successesA / totalA
  const pB = successesB / totalB
  const expected = [successesA, totalA - successesA, successesB, totalB - successesB]
  if (expected.some((cell) => cell < 5)) return null

  const pooled = (successesA + successesB) / (totalA + totalB)
  const se = Math.sqrt(pooled * (1 - pooled) * ((1 / totalA) + (1 / totalB)))
  if (!se) return null

  const z = (pA - pB) / se
  return { z: round(z, 3), p_value: round(normalTwoTailedP(z), 4), significant: Math.abs(z) >= 1.96 }
}

// Abramowitz & Stegun 7.1.26 error-function approximation. Accurate to ~1e-7,
// which is far tighter than any decision made off these dashboards needs.
function normalTwoTailedP (z) {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + (0.3275911 * x))
  const y = 1 - ((((((1.061405429 * t) - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return 1 - y
}

// ── Shape helpers ────────────────────────────────────────────────────────────

// A metric the data cannot answer. Rendered as an explicit "needs data" card so
// an operator can tell "zero" apart from "we never collected this".
function unavailable (reason) {
  return { available: false, reason }
}

// Fills gaps in a daily series so charts do not draw a straight line across
// days that genuinely had no activity.
function fillDailySeries (rows, { from, to, dateKey = 'date', fields = [] }) {
  const byDate = new Map(rows.map((row) => [String(row[dateKey]).slice(0, 10), row]))
  const startMs = Date.parse(`${from}T00:00:00Z`)
  const endMs = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return []

  // Counting whole days and indexing off the start, rather than mutating a
  // cursor Date in place: UTC midnights are exactly 86_400_000ms apart (UTC has
  // no DST), so this is equivalent and has no hidden loop state.
  const days = Math.round((endMs - startMs) / DAY_MS) + 1
  const out = new Array(days)

  for (let offset = 0; offset < days; offset += 1) {
    const key = new Date(startMs + (offset * DAY_MS)).toISOString().slice(0, 10)
    const row = byDate.get(key)
    const point = { [dateKey]: key }
    for (const field of fields) point[field] = row ? num(row[field]) : 0
    out[offset] = point
  }

  return out
}

module.exports = {
  num,
  int,
  round,
  pct,
  ratio,
  safeDiv,
  parseDateRange,
  percentile,
  median,
  mean,
  stdDev,
  coefficientOfVariation,
  pearson,
  twoProportionZTest,
  unavailable,
  fillDailySeries,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS
}
