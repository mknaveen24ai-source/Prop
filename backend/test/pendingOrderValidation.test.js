const test   = require('node:test')
const assert = require('node:assert/strict')
const { validatePendingOrderPrice } = require('../utils/pendingOrderValidation')

// ── Test: correct side-of-market enforcement ───────────────────────────────
test('validatePendingOrderPrice enforces proper side of market', () => {
  const bid = 1.1000
  const ask = 1.1002

  // Invalid placements — should return an error string
  assert.match(
    validatePendingOrderPrice('buy_limit', 1.1003, bid, ask),
    /Buy Limit price must be below current ask/i
  )
  assert.match(
    validatePendingOrderPrice('sell_limit', 1.0999, bid, ask),
    /Sell Limit price must be above current bid/i
  )
  assert.match(
    validatePendingOrderPrice('buy_stop', 1.1001, bid, ask),
    /Buy Stop price must be above current ask/i
  )
  assert.match(
    validatePendingOrderPrice('sell_stop', 1.1001, bid, ask),
    /Sell Stop price must be below current bid/i
  )

  // Valid placements — should return null (no error)
  assert.equal(validatePendingOrderPrice('buy_limit',  1.0999, bid, ask), null)
  assert.equal(validatePendingOrderPrice('sell_limit', 1.1003, bid, ask), null)
  assert.equal(validatePendingOrderPrice('buy_stop',   1.1003, bid, ask), null)
  assert.equal(validatePendingOrderPrice('sell_stop',  1.0999, bid, ask), null)
})

// ── Test: invalid inputs ───────────────────────────────────────────────────
test('validatePendingOrderPrice rejects invalid pending price', () => {
  assert.equal(
    validatePendingOrderPrice('buy_limit', NaN, 1.1, 1.2),
    'Invalid pending order price'
  )
  assert.equal(
    validatePendingOrderPrice('buy_limit', -1, 1.1, 1.2),
    'Invalid pending order price'
  )
})

test('validatePendingOrderPrice rejects when live price is unavailable', () => {
  assert.match(
    validatePendingOrderPrice('buy_limit', 1.0, NaN, 1.2),
    /Live price not available/i
  )
})
