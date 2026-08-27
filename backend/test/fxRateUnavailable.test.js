const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// What the platform does when a currency rate goes dark.
//
// Under FX_CONVERSION_ENABLED, calculatePnL resolves the instrument's QUOTE/USD
// rate from the in-process price cache and THROWS FxRateUnavailableError when it
// is not there. Every cross-JPY pair — EURJPY, GBPJPY, AUDJPY, CADJPY, CHFJPY,
// NZDJPY — takes its rate from USDJPY, so a single dark symbol makes six other
// instruments unvaluable while their prices keep arriving normally.
//
// Three call sites reach that throw, and they must not behave the same way:
//
//   services/tradeEngine.js  SKIPS the trade. Understating floating loss there
//                            means declining to declare a breach, so it fails
//                            closed and the next tick retries.
//
//   routes/trades/open.js    must REFUSE. Its sum is the equity behind a margin
//                            check, so understating loss OVERSTATES equity and
//                            would admit a trade that should have been refused.
//                            Skipping here fails OPEN — the unsafe direction.
//
//   routes/trades/close.js   must return a retryable 503 with a specific
//                            message. The trader still holds the position and
//                            is still exposed; "try again shortly" is
//                            materially different advice from a generic 500.
//
// These are asserted against source because reproducing a dark rate source
// through the full HTTP stack needs a live server and a price feed, and the
// property worth protecting is the shape of the handling, not the plumbing.

const OPEN = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trades', 'open.js'), 'utf8')
const CLOSE = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trades', 'close.js'), 'utf8')
const ENGINE = fs.readFileSync(path.join(__dirname, '..', 'services', 'tradeEngine.js'), 'utf8')

test('a missing rate throws rather than silently valuing at 1', () => {
  const previous = process.env.FX_CONVERSION_ENABLED
  process.env.FX_CONVERSION_ENABLED = 'true'
  const cachePath = require.resolve('../utils/priceCache')
  const calcPath = require.resolve('../utils/pnlCalculator')
  const fxPath = require.resolve('../utils/fxRates')
  for (const p of [cachePath, calcPath, fxPath]) delete require.cache[p]

  try {
    const priceCache = require('../utils/priceCache')
    if (typeof priceCache.__reset === 'function') priceCache.__reset()
    const { calculatePnL } = require('../utils/pnlCalculator')

    assert.throws(
      () => calculatePnL('buy', 150.0, 150.1, 1, 'USDJPY', 0),
      (error) => error.name === 'FxRateUnavailableError',
      'a dark rate source must throw, never fall back to rate 1 and book quote currency as dollars'
    )

    // A USD-quoted instrument needs no rate and must be unaffected.
    assert.equal(typeof calculatePnL('buy', 1.1, 1.105, 1, 'EURUSD', 0), 'number')
  } finally {
    if (previous === undefined) delete process.env.FX_CONVERSION_ENABLED
    else process.env.FX_CONVERSION_ENABLED = previous
    for (const p of [cachePath, calcPath, fxPath]) delete require.cache[p]
  }
})

test('the open path refuses rather than skipping an unvaluable position', () => {
  assert.match(OPEN, /FxRateUnavailableError/,
    'routes/trades/open.js must handle FxRateUnavailableError around its floating-PnL sum')
  assert.match(OPEN, /res\.status\(503\)/,
    'it must refuse with 503 rather than proceeding on an overstated equity')
  assert.match(OPEN, /ROLLBACK/,
    'it must roll back before responding — the margin check runs inside a transaction')
})

test('the close path returns a retryable 503, not a generic 500', () => {
  const handler = CLOSE.slice(CLOSE.indexOf('Close trade error'), CLOSE.indexOf('Close trade error') + 200)
  assert.match(CLOSE, /isNamedError\(error, 'FxRateUnavailableError'\)/,
    'routes/trades/close.js must distinguish a dark rate from an unexpected failure')
  assert.match(CLOSE, /status\(503\)[\s\S]{0,200}try again shortly/,
    'the trader must be told the position is unchanged and to retry')
  assert.ok(handler.includes('500'),
    'genuinely unexpected close failures must still surface as 500')
})

test('the engine skips, because on its path skipping fails closed', () => {
  assert.match(ENGINE, /confirm skipped a trade with no USD rate/,
    'services/tradeEngine.js must skip and log rather than abort the whole tick')
})

test('no fallback to a stale or assumed rate exists on any money path', () => {
  // Booking a realised PnL at a rate nobody can vouch for writes a wrong number
  // into the ledger permanently. Choosing a fallback is an operator risk
  // decision, not a default. If one is ever added, this test should be the thing
  // that forces the conversation.
  for (const [name, src] of [['open.js', OPEN], ['close.js', CLOSE]]) {
    assert.doesNotMatch(src, /lastKnownRate|staleRate|fallbackRate|rate\s*\|\|\s*1/,
      `${name} must not substitute a fallback rate`)
  }
})
