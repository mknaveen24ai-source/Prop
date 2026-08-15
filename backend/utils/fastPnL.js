'use strict'
/**
 * Fast-path PnL + trigger predicates (native float)
 * ─────────────────────────────────────────────────────────────────────────────
 * These are the hot-loop mirrors of the Decimal.js helpers used elsewhere. They
 * exist purely so a price tick can scan tens of thousands of trades without
 * blocking the event loop — Decimal.js costs ~5µs per PnL call, which at 100K
 * trades is ~500ms of CPU per pass.
 *
 * ── IMPORTANT: these numbers never reach the database. ──
 *
 * The engine uses a "float detects, Decimal confirms" contract:
 *   1. fastPnL() finds *candidates* — accounts/trades that appear to have
 *      crossed a threshold.
 *   2. calculatePnL() (utils/pnlCalculator.js) re-checks each candidate.
 *   3. Only the Decimal result is ever booked or used to fail/pass an account.
 *
 * So a float rounding error can at worst cause a redundant re-check, never a
 * wrong balance and never a wrongly-failed account.
 *
 * fastPnL is a deliberate 1:1 mirror of calculatePnL, including its assumption
 * that (priceDiff × lots × contractSize) is already denominated in USD. Any
 * instrument where that stops holding breaks both functions identically — the
 * confirm step would not catch it. That is a pre-existing property of
 * calculatePnL, not something introduced here.
 *
 * See test/fastPnL.test.js for the parity assertions that keep the two in step.
 */

const { CONTRACT_SIZES } = require('../constants')

const DEFAULT_CONTRACT_SIZE = 100000

// Direction is stored as a string ('buy' / 'sell') in the DB. Comparing strings
// once per trade per tick is measurable at 100K trades, so the index pre-resolves
// it to a sign and the hot loop only ever multiplies.
const DIRECTION_BUY = 1
const DIRECTION_SELL = -1

function directionSign(direction) {
  return direction === 'buy' ? DIRECTION_BUY : DIRECTION_SELL
}

function contractSizeFor(instrument) {
  return CONTRACT_SIZES[instrument] || DEFAULT_CONTRACT_SIZE
}

/**
 * Native-float mirror of calculatePnL().
 *
 * @param {1|-1}   sign          Pre-resolved direction (see directionSign)
 * @param {number} openPrice
 * @param {number} closePrice
 * @param {number} lots
 * @param {number} contractSize  Pre-resolved (see contractSizeFor)
 * @param {number} commission
 * @returns {number} PnL, unrounded — callers must not persist this
 */
function fastPnL(sign, openPrice, closePrice, lots, contractSize, commission) {
  const diff = sign === DIRECTION_BUY
    ? closePrice - openPrice
    : openPrice - closePrice
  return diff * lots * contractSize - commission
}

/**
 * The price a trade closes at: BUY closes on the bid, SELL closes on the ask.
 * Mirrors routes/trades.js checkSLTP.
 */
function closePriceFor(sign, price) {
  return sign === DIRECTION_BUY ? price.bid : price.ask
}

// ─── Trigger predicates ───────────────────────────────────────────────────────
// Mirror the comparisons in checkSLTP: a BUY stop triggers when price falls to
// or below the level, a SELL stop when it rises to or above it. TP is inverted.

function isSLTriggered(sign, stopLoss, currentPrice) {
  if (stopLoss == null) return false
  return sign === DIRECTION_BUY
    ? currentPrice <= stopLoss
    : currentPrice >= stopLoss
}

function isTPTriggered(sign, takeProfit, currentPrice) {
  if (takeProfit == null) return false
  return sign === DIRECTION_BUY
    ? currentPrice >= takeProfit
    : currentPrice <= takeProfit
}

/**
 * Pending-order trigger check.
 *
 * A buy-limit fills when the ask drops to the level; a buy-stop when the ask
 * rises to it. Sells mirror on the bid. This only decides *whether to look* —
 * validatePendingTrigger() still runs in full inside the transaction before
 * anything is filled.
 *
 * @param {string} orderType  buy_limit | sell_limit | buy_stop | sell_stop
 * @param {number} triggerPrice
 * @param {{bid:number, ask:number}} price
 */
function isPendingTriggered(orderType, triggerPrice, price) {
  if (triggerPrice == null) return false
  switch (orderType) {
    case 'buy_limit':  return price.ask <= triggerPrice
    case 'buy_stop':   return price.ask >= triggerPrice
    case 'sell_limit': return price.bid >= triggerPrice
    case 'sell_stop':  return price.bid <= triggerPrice
    default:           return false
  }
}

module.exports = {
  DIRECTION_BUY,
  DIRECTION_SELL,
  directionSign,
  contractSizeFor,
  fastPnL,
  closePriceFor,
  isSLTriggered,
  isTPTriggered,
  isPendingTriggered
}
