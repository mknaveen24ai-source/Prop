// POST /api/trades/open — market and pending order entry.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.
//
// Kept whole at ~580 lines: it is a single transaction from validation
// through insert, and splitting it across files would obscure that.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const Decimal = require('decimal.js')
const newsService = require('../../services/newsService')
const { authenticateToken } = require('../middleware')
const { v4: uuidv4 } = require('uuid')
const { tradingLimiter } = require('../../utils/security')
const { getRequestIp } = require('../../utils/requestIp')
const { recordRequestSignals } = require('../../services/identitySignals')
const { isValidLotSize, sanitizeString } = require('../../utils/validation')
const {
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  getPipSize,
  roundPrice
} = require('../../constants')
const { getCurrentPricesForTenant } = require('../../priceFeed')
const { validatePendingOrderPrice } = require('../../utils/pendingOrderValidation')
const { resolveTieredInstrumentSetting } = require('../../utils/tenantSettings')
const { calculatePnL } = require('../../utils/pnlCalculator')
const {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} = require('../../utils/idempotency')
const { fetchStepModelBySlug } = require('../../utils/stepModels')
const {
  VALID_INSTRUMENTS,
  isTradableInstrument,
  ensureTradeExperienceInfrastructure,
  getTradingRules,
  getLivePrice,
  calculateMargin,
  calculateUsedMargin,
  getMarketStatus
} = require('../../services/tradeShared')
const { engine, isValidImageDataUrl, persistTradeScreenshot } = require('./shared')

const router = express.Router()

function normalizePositiveNumber(value) {
  if (value === '' || value === null || value === undefined) return null
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// validatePendingOrderPrice
//   buy_limit  â†’ price must be BELOW current ask
//   sell_limit â†’ price must be ABOVE current bid
//   buy_stop   â†’ price must be ABOVE current ask
//   sell_stop  â†’ price must be BELOW current bid
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// POST /api/trades/open
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/open', authenticateToken, tradingLimiter, async function(req, res) {
  let idempotencyClaim = null
  try {
    await ensureTradeExperienceInfrastructure()

    const {
      account_id,
      instrument,
      direction,
      lots,
      stop_loss,
      take_profit,
      order_type,
      pending_price,
      screenshot_data_url,
      oco_sibling
    } = req.body

    // Enhanced input validation
    if (!account_id || !instrument || !direction || !lots) {
      return res.status(400).json({ error: 'account_id, instrument, direction, and lots are required' })
    }

    if (screenshot_data_url != null && !isValidImageDataUrl(screenshot_data_url)) {
      return res.status(400).json({ error: 'Invalid screenshot data' })
    }

    // FIX (BUG-C002): tradeIp was never declared in this handler — caused
    // ReferenceError when inserting into trade_logs on every trade open.
    const tradeIp = getRequestIp(req)

    // Sanitize inputs
    const sanitizedInstrument = sanitizeString(String(instrument).toUpperCase(), 10)
    const sanitizedDirection = sanitizeString(String(direction).toLowerCase(), 10)
    const instrumentFinal = sanitizedInstrument
    const directionFinal = sanitizedDirection
    
    if (!VALID_INSTRUMENTS.includes(sanitizedInstrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    // C-01 containment: PnL is computed as priceDiff * lots * contractSize and
    // booked as USD, which is only correct for USD-quoted instruments. Until
    // FX conversion lands, block *opening* anything else. Existing positions on
    // restricted instruments are unaffected — they still price, chart and close.
    if (!isTradableInstrument(sanitizedInstrument)) {
      return res.status(400).json({
        error: `${sanitizedInstrument} is temporarily unavailable for new positions. Existing positions can still be managed and closed as normal.`
      })
    }

    if (!['buy', 'sell'].includes(sanitizedDirection)) {
      return res.status(400).json({ error: 'Direction must be buy or sell' })
    }

    // â”€â”€ Strict News Protection (3 min USD High Impact) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const activeNews = newsService.getActiveNewsEvent(3)
    if (activeNews) {
      return res.status(400).json({ error: `Cannot open trade. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Use validation utility for lot size
    if (!isValidLotSize(lots)) {
      return res.status(400).json({ error: 'Invalid lot size. Must be between 0.01 and 1000 in 0.01 increments.' })
    }

    const lotsNum = parseFloat(lots)
    // â”€â”€ Minimum lot size (admin-configurable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let rules = await getTradingRules()
    const MIN_LOT_SIZE = rules.minLotSize
    if (lotsNum < MIN_LOT_SIZE) {
      return res.status(400).json({ error: `Minimum lot size is ${MIN_LOT_SIZE}. You entered ${lotsNum}.` })
    }

    // â”€â”€ Lot size must be in 0.01 increments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const lotsRounded = Math.round(lotsNum * 100) / 100
    if (Math.abs(lotsRounded - lotsNum) > 0.00001) {
      return res.status(400).json({ error: `Lot size must be in 0.01 increments (e.g. 0.01, 0.05, 1.00). You entered ${lotsNum}.` })
    }

    const accountIdStr = String(account_id).trim()
    if (!accountIdStr) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const marketStatus      = getMarketStatus(instrumentFinal, { purpose: 'open' })
    const PENDING_ORDER_TYPES = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']
    const orderTypeFinal    = order_type || 'market'
    const isPending         = PENDING_ORDER_TYPES.includes(orderTypeFinal)
    const hasOcoSibling = !!oco_sibling

    if (!isPending && !marketStatus.open) {
      return res.status(400).json({ error: marketStatus.reason })
    }

    if (hasOcoSibling && !isPending) {
      return res.status(400).json({ error: 'OCO is only available for pending orders' })
    }

    let ocoSiblingConfig = null
    if (hasOcoSibling) {
      if (typeof oco_sibling !== 'object') {
        return res.status(400).json({ error: 'Invalid OCO sibling payload' })
      }
      const siblingOrderType = sanitizeString(String(oco_sibling.order_type || '').toLowerCase(), 20)
      const siblingPendingPrice = normalizePositiveNumber(oco_sibling.pending_price)
      if (!PENDING_ORDER_TYPES.includes(siblingOrderType) || !siblingPendingPrice) {
        return res.status(400).json({ error: 'OCO sibling requires a valid pending order type and price' })
      }
      ocoSiblingConfig = {
        order_type: siblingOrderType,
        pending_price: siblingPendingPrice,
        direction: siblingOrderType.startsWith('buy') ? 'buy' : 'sell'
      }
    }

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // RACE CONDITION FIX: All read-check-write operations run inside a single
    // transaction with SELECT ... FOR UPDATE on the account row. This serialises
    // concurrent trade opens for the same account â€” two simultaneous requests
    // will queue at the lock, and the second will see the first's INSERT already
    // in the DB when it runs its checks.
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const client = await pool.connect()
    let newTrade
    try {
      await client.query('BEGIN')

      // Lock the account row for this transaction
      const lockedAccount = await client.query(
        `SELECT id, user_id, account_size, current_balance, starting_balance, peak_balance,
                status, account_type, phase_end_date, scaling_multiplier, challenge_model_slug
         FROM accounts WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`,
        [accountIdStr, req.user.userId]
      )
      if (lockedAccount.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Account not found or not active' })
      }

      // FIX (LOOPHOLE 2): Reject trades on accounts past their phase_end_date
      // The challenge engine checks every 30s, so there's a window where traders
      // could still open trades on an expired account.
      const account = lockedAccount.rows[0]
      rules = await getTradingRules()
      if (lotsNum < rules.minLotSize) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Minimum lot size is ${rules.minLotSize}. You entered ${lotsNum}.` })
      }
      if (account.phase_end_date && new Date(account.phase_end_date) <= new Date()) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Challenge phase has expired. No new trades allowed.' })
      }

      // ─────────────────────────────────────────────────────────────────────────
      // Pre-trade snapshot — every read-only check in ONE round trip.
      //
      // These were seven sequential queries, each a full client→Postgres→client
      // round trip taken WHILE HOLDING the account row lock above. That serialises
      // per account, so the lock hold time is the ceiling on how fast one trader
      // can place orders, and every trip is pool time nobody else can use. At the
      // open rates this platform is being scaled for, it is the write path's
      // dominant cost.
      //
      // They stay INSIDE the transaction, after the FOR UPDATE. That is not
      // incidental — it is the whole reason these limits hold. Moving them before
      // BEGIN would let two concurrent opens both read "4 of 5 positions used" and
      // both insert, putting the account over its cap. Fewer round trips is worth
      // having; a race on an exposure limit is not.
      //
      // Every sub-select runs unconditionally, even when the corresponding rule is
      // switched off. They are all single-account, index-backed lookups, so paying
      // for one that will be ignored is far cheaper than the round trip that
      // conditionality would cost.
      // ─────────────────────────────────────────────────────────────────────────
      const oppositeDirection = directionFinal === 'buy' ? 'sell' : 'buy'
      const exposureGroup = COMMODITY_INSTRUMENTS.includes(instrumentFinal)
        ? COMMODITY_INSTRUMENTS
        : FOREX_INSTRUMENTS.includes(instrumentFinal)
          ? FOREX_INSTRUMENTS
          : []

      const snapshot = (await client.query(
        `SELECT
           (SELECT 1 FROM trades
             WHERE account_id = $1 AND instrument = $2 AND direction = $3
               AND status IN ('open', 'pending') LIMIT 1)                       AS opposite_open,

           (SELECT 1 FROM trades
             WHERE account_id = $1 AND instrument = $2 AND direction = $4
               AND status IN ('open', 'pending') LIMIT 1)                       AS same_direction_open,

           (SELECT json_build_object('lot_size', lot_size, 'demo_pnl', demo_pnl)
              FROM trades
             WHERE account_id = $1 AND instrument = $2 AND direction = $4
               AND status = 'closed'
             ORDER BY close_time DESC LIMIT 1)                                  AS last_closed_setup,

           -- $1::text, not a bare $1. trades.account_id is uuid while
           -- trade_logs.account_id is text, and both are compared to the same
           -- parameter in this one statement. Postgres resolves a parameter's
           -- type ONCE, from its first determining context -- the uuid column
           -- above -- so a bare $1 here resolved to text = uuid and EVERY trade
           -- open failed with 500 "Could not open trade".
           -- The cast is on the parameter, not the column, so the index on
           -- trade_logs(account_id) is still used.
           -- Guarded by scripts/check-param-type-collisions.js.
           (SELECT COUNT(*)::int FROM trade_logs
             WHERE account_id = $1::text
               AND logged_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
               AND logged_at <  date_trunc('day', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 day')
                                                                                AS trades_today,

           (SELECT COALESCE(SUM(lot_size), 0) FROM trades
             WHERE account_id = $1 AND instrument = ANY($5::text[])
               AND status IN ('open', 'pending'))                               AS exposure_lots,

           (SELECT COUNT(*)::int FROM trades
             WHERE account_id = $1 AND status IN ('open', 'pending'))           AS open_or_pending_count,

           (SELECT COALESCE(json_agg(json_build_object(
                     'direction',  direction,
                     'open_price', open_price,
                     'lot_size',   lot_size,
                     'instrument', instrument,
                     'commission', commission)), '[]'::json)
              FROM trades
             WHERE account_id = $1 AND status = 'open')                         AS open_trades`,
        [accountIdStr, instrumentFinal, oppositeDirection, directionFinal, exposureGroup]
      )).rows[0]

      // ── Trading-restriction flags from the account's challenge model ──────────
      // no_ea_bots is intentionally not enforced here — there is no reliable
      // server-side signal (e.g. client fingerprinting) to distinguish bot-driven
      // orders from manual ones, so a check would just be security theater.
      if (account.challenge_model_slug) {
        const model = await fetchStepModelBySlug(account.challenge_model_slug)
        if (model) {
          if (model.no_hedging && snapshot.opposite_open) {
            await client.query('ROLLBACK')
            return res.status(400).json({
              error: `Hedging is not allowed on this account. Close your existing ${instrumentFinal} position before opening the opposite direction.`
            })
          }

          // Simplified enforcement: one open/pending position per instrument+direction.
          if (model.no_grid_trading && snapshot.same_direction_open) {
            await client.query('ROLLBACK')
            return res.status(400).json({
              error: `Grid trading is not allowed on this account. You already have an open or pending ${directionFinal} order on ${instrumentFinal}.`
            })
          }

          // Simplified enforcement: can't size up on the same instrument+direction
          // right after that setup closed at a loss (classic doubling-down pattern).
          if (model.no_martingale) {
            const lastRow = snapshot.last_closed_setup
            if (lastRow && parseFloat(lastRow.demo_pnl) < 0 && lotsNum > parseFloat(lastRow.lot_size)) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Martingale trading is not allowed on this account. You cannot increase lot size after a loss on the same ${instrumentFinal} ${directionFinal} setup.`
              })
            }
          }
        }
      }

      if (rules.maxDailyTrades > 0) {
        const tradesToday = parseInt(snapshot.trades_today || 0, 10)
        if (tradesToday >= rules.maxDailyTrades) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Daily trade limit reached. You have already placed ${tradesToday} trade${tradesToday === 1 ? '' : 's'} today. Maximum allowed per account is ${rules.maxDailyTrades} per UTC day.`
          })
        }
      }

      // â”€â”€ Combined exposure check (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Funded accounts' scaling-plan multiplier raises risk capacity (lot caps)
      // proportionally — it does not change the account's literal balance.
      const scalingMultiplier = account.account_type === 'funded' && account.scaling_multiplier != null
        ? parseFloat(account.scaling_multiplier)
        : 1
      const accountSizeK = (parseFloat(account.account_size) / 1000) * (Number.isFinite(scalingMultiplier) ? scalingMultiplier : 1)

      if (COMMODITY_INSTRUMENTS.includes(instrumentFinal)) {
        const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
        const currentLots = parseFloat(snapshot.exposure_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined gold+silver exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxCommodityLots} lots (${rules.commodityLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxCommodityLots - currentLots).toFixed(4)} lots.`
          })
        }
      } else if (FOREX_INSTRUMENTS.includes(instrumentFinal)) {
        const maxForexLots   = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
        const currentLots = parseFloat(snapshot.exposure_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined forex exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxForexLots} lots (${rules.forexLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxForexLots - currentLots).toFixed(4)} lots.`
          })
        }
      }

      // â”€â”€ Max simultaneous open trades cap (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // FIX (M-01): max_trades_per_1k was stored in platform_settings, exposed
      // in the admin settings UI, returned to traders via /api/accounts, and
      // loaded into rules.maxTradesPer1k -- and read by no enforcement code
      // anywhere. An admin tightening it believed they had capped position
      // count per $1k of account size; nothing happened. A control that does
      // nothing is worse than an absent one, so it is enforced now.
      //
      // Scales with the account like the lot caps above, reusing the same
      // scaling multiplier so a funded account's raised capacity applies here
      // too. Zero or negative disables it, matching maxDailyTrades.
      const maxOpenTrades = rules.maxOpenPositions
      const currentOpenCount = parseInt(snapshot.open_or_pending_count, 10)

      // FIX (M-01): max_trades_per_1k was stored in platform_settings, shown in
      // the admin settings UI, returned to traders via /api/accounts, and loaded
      // into rules.maxTradesPer1k -- and read by no enforcement code anywhere.
      // An admin tightening it believed they had capped position count per $1k
      // of account size; nothing happened. A control that silently does nothing
      // is worse than an absent one.
      //
      // Reuses the count above rather than issuing its own query, and reuses
      // accountSizeK so a funded account's scaling multiplier applies here too.
      // Zero or negative disables it, matching maxDailyTrades.
      if (rules.maxTradesPer1k > 0) {
        const maxScaledTrades = Math.max(1, Math.floor(accountSizeK * rules.maxTradesPer1k))
        if (currentOpenCount >= maxScaledTrades) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Maximum of ${maxScaledTrades} simultaneous positions for a $${Number(account.account_size).toLocaleString()} account (${rules.maxTradesPer1k} per $1k). You currently have ${currentOpenCount}.`
          })
        }
      }

      if (currentOpenCount >= maxOpenTrades) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Maximum of ${maxOpenTrades} simultaneous open/pending trades allowed for a $${Number(account.account_size).toLocaleString()} account. You currently have ${currentOpenCount}. Close some trades before opening new ones.`
        })
      }

      // â”€â”€ Margin check (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const margin = calculateMargin(instrumentFinal, lotsNum)
      
      let floatingPnl = new Decimal(0)
      const livePrices = await getCurrentPricesForTenant()
      // Read in the same snapshot query above, under the same lock. json_agg
      // renders numerics as JSON numbers rather than the strings a normal row
      // gives, which the parseFloat calls below already tolerate.
      const openTradesResult = { rows: snapshot.open_trades || [] }
      for (const t of openTradesResult.rows) {
        const livePrice = livePrices[t.instrument]
        if (!livePrice) continue
        const currentPrice = t.direction === 'buy' ? parseFloat(livePrice.bid) : parseFloat(livePrice.ask)
        floatingPnl = floatingPnl.plus(calculatePnL(t.direction, parseFloat(t.open_price), currentPrice, parseFloat(t.lot_size), t.instrument, parseFloat(t.commission || 0)))
      }
      
      const equity = new Decimal(account.current_balance).plus(floatingPnl)
      const requiredMargin = new Decimal(calculateUsedMargin(openTradesResult.rows)).plus(margin)
      
      if (requiredMargin.gt(equity)) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Insufficient equity. Required margin: $${requiredMargin.toFixed(2)}, Available Equity: $${equity.toFixed(2)}` })
      }

      const demo_trade_id = uuidv4()
      const commissionPerLot = resolveTieredInstrumentSetting(rules.commissionPerLotJson, account.account_type, instrumentFinal, rules.dynamicCommissionPerLot)
      const tradeCommission = parseFloat((lotsNum * commissionPerLot).toFixed(2))

      async function ensureTradeOpenIdempotencyClaim() {
        if (idempotencyClaim) return null

        const idempotencyResult = await beginIdempotentRequest(pool, {
          scope: 'trades:open',
          actorId: req.user.userId,
          idempotencyKey: getIdempotencyKey(req)
        })

        // FIX (H-03): a missing header used to mean "no replay protection",
        // so a retried request opened a second position.
        if (idempotencyResult.required) {
          return { status: 400, body: { error: idempotencyResult.error } }
        }
        if (idempotencyResult.replay) {
          return {
            status: idempotencyResult.responseStatus,
            body: idempotencyResult.responseBody
          }
        }
        if (idempotencyResult.inProgress) {
          return {
            status: 409,
            body: { error: 'This trade-open request is already being processed.' }
          }
        }

        idempotencyClaim = idempotencyResult.claimId || null
        return null
      }

      // â”€â”€ Pending order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (isPending) {
        const p = parseFloat(pending_price)
        const price = await getLivePrice(instrumentFinal).catch(() => null)
        const bid = price ? parseFloat(price.bid) : NaN
        const ask = price ? parseFloat(price.ask) : NaN

        const validationError = validatePendingOrderPrice(orderTypeFinal, p, bid, ask)
        if (validationError) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: validationError })
        }
        if (ocoSiblingConfig) {
          const siblingValidationError = validatePendingOrderPrice(
            ocoSiblingConfig.order_type,
            ocoSiblingConfig.pending_price,
            bid,
            ask
          )
          if (siblingValidationError) {
            await client.query('ROLLBACK')
            return res.status(400).json({ error: `OCO sibling invalid: ${siblingValidationError}` })
          }
        }
        const pendingClaimResult = await ensureTradeOpenIdempotencyClaim()
        if (pendingClaimResult) {
          await client.query('ROLLBACK')
          return res.status(pendingClaimResult.status).json(pendingClaimResult.body)
        }
        const ocoGroupId = ocoSiblingConfig ? uuidv4() : null
        newTrade = await client.query(
          `INSERT INTO trades
           (account_id, demo_trade_id, instrument, direction, lot_size,
            status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
            oco_group_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
           RETURNING *`,
          [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum,
           stop_loss   ? parseFloat(stop_loss)   : null,
           take_profit ? parseFloat(take_profit) : null,
           orderTypeFinal,
           parseFloat(pending_price),
           tradeCommission,
           ocoGroupId]
        )
        if (screenshot_data_url) {
          const openScreenshotPath = await persistTradeScreenshot({
            tradeId: newTrade.rows[0].id,
            userId: req.user.userId,
            kind: 'open',
            dataUrl: screenshot_data_url
          })
          if (openScreenshotPath) {
            await client.query(`UPDATE trades SET open_screenshot_path = $1 WHERE id = $2`, [openScreenshotPath, newTrade.rows[0].id])
            newTrade.rows[0].open_screenshot_path = openScreenshotPath
          }
        }
        let siblingTradeId = null
        if (ocoSiblingConfig && ocoGroupId) {
          const siblingTrade = await client.query(
            `INSERT INTO trades
             (account_id, demo_trade_id, instrument, direction, lot_size,
              status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
              oco_group_id)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
             RETURNING *`,
            [accountIdStr, uuidv4(), instrumentFinal, ocoSiblingConfig.direction, lotsNum,
             stop_loss   ? parseFloat(stop_loss)   : null,
             take_profit ? parseFloat(take_profit) : null,
             ocoSiblingConfig.order_type,
             ocoSiblingConfig.pending_price,
             tradeCommission,
             ocoGroupId]
          )
          siblingTradeId = siblingTrade.rows[0]?.id || null
        }
        await client.query(
          `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [newTrade.rows[0].id, req.user.userId, accountIdStr, tradeIp]
        )
        // FIX (M-10): the daily-trade limit counts trade_logs rows, but only the
        // primary leg was ever logged — so an OCO pair counted as one trade
        // while creating two orders, letting a trader place twice the cap.
        if (siblingTradeId) {
          await client.query(
            `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [siblingTradeId, req.user.userId, accountIdStr, tradeIp]
          )
        }
        await client.query('COMMIT')

        // Fire-and-forget, and only after COMMIT — a fraud signal must never
        // hold a trade transaction open or fail an order.
        recordRequestSignals(req.user.userId, {
          ip: tradeIp,
          deviceSignature: req.deviceSignature,
          context: 'trade'
        })

        const tradeRow = newTrade.rows[0]

        // Keep the engine's in-memory index in step with what was just written,
        // so the order can be triggered on the very next price tick rather than
        // waiting for the next reconciliation.
        await engine().syncPendingOrder(tradeRow)
        if (siblingTradeId) {
          await engine().syncPendingOrder({ ...tradeRow, id: siblingTradeId, direction: ocoSiblingConfig.direction, order_type: ocoSiblingConfig.order_type, pending_price: ocoSiblingConfig.pending_price })
        }

        const responseBody = {
          message: `${orderTypeFinal.replace(/_/g, ' ')} order placed`,
          trade_id: tradeRow.id,
          account_id: tradeRow.account_id,
          trade: tradeRow,
          oco_sibling_trade_id: siblingTradeId
        }
        if (idempotencyClaim) {
          await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
          idempotencyClaim = null
        }
        return res.status(201).json(responseBody)
      }

      // â”€â”€ Market order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const price = await getLivePrice(instrumentFinal)
      const priceAgeMs = Date.now() - new Date(price.updated_at).getTime()
      // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
      if (priceAgeMs > 10000) {
        logger.warn('Price feed too old:', { instrument: instrumentFinal, ageMs: priceAgeMs })
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Price feed is currently delayed. Order rejected due to volatility protection/latency.' })
      }
      let open_price = directionFinal === 'buy' ? parseFloat(price.ask) : parseFloat(price.bid)

      let slippageIncurred = 0
      const openSlippageMaxPipsAdverse = resolveTieredInstrumentSetting(rules.slippageMaxPipsAdverseJson, account.account_type, instrumentFinal, rules.slippageMaxPipsAdverse)
      if (rules.slippageSimulatorEnabled && openSlippageMaxPipsAdverse > 0) {
        const randPips = Math.random() * openSlippageMaxPipsAdverse
        slippageIncurred = parseFloat(randPips.toFixed(2))
        const slippageAmt = randPips * getPipSize(instrumentFinal)

        open_price = directionFinal === 'buy' ? open_price + slippageAmt : open_price - slippageAmt
        open_price = roundPrice(open_price, instrumentFinal)
      }

      if (stop_loss) {
        if (directionFinal === 'buy'  && parseFloat(stop_loss) >= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && parseFloat(stop_loss) <= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
        }
      }

      if (take_profit) {
        if (directionFinal === 'buy'  && parseFloat(take_profit) <= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && parseFloat(take_profit) >= open_price) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
        }
      }

      const marketClaimResult = await ensureTradeOpenIdempotencyClaim()
      if (marketClaimResult) {
        await client.query('ROLLBACK')
        return res.status(marketClaimResult.status).json(marketClaimResult.body)
      }

      newTrade = await client.query(
        `INSERT INTO trades
         (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
          status, stop_loss, take_profit, order_type, commission, original_commission, slippage_pips)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'open', $7, $8, 'market', $9, $9, $10)
         RETURNING *`,
        [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum, open_price,
         stop_loss   ? parseFloat(stop_loss)   : null,
         take_profit ? parseFloat(take_profit) : null,
         tradeCommission,
         slippageIncurred]
      )

      if (screenshot_data_url) {
        const openScreenshotPath = await persistTradeScreenshot({
          tradeId: newTrade.rows[0].id,
          userId: req.user.userId,
          kind: 'open',
          dataUrl: screenshot_data_url
        })
        if (openScreenshotPath) {
          await client.query(`UPDATE trades SET open_screenshot_path = $1 WHERE id = $2`, [openScreenshotPath, newTrade.rows[0].id])
          newTrade.rows[0].open_screenshot_path = openScreenshotPath
        }
      }

      await client.query(
        `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [newTrade.rows[0].id, req.user.userId, accountIdStr, tradeIp]
      )

      await client.query('COMMIT')

    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    // Fire-and-forget, post-COMMIT — see the pending-order path above.
    recordRequestSignals(req.user.userId, {
      ip: tradeIp,
      deviceSignature: req.deviceSignature,
      context: 'trade'
    })

    const tradeRow = newTrade.rows[0]

    // Index the new position (and seed its floating PnL from the current price)
    // so it is eligible for SL/TP and drawdown checks on the next tick.
    await engine().syncOpenedTrade(tradeRow)

    const responseBody = {
      message: 'Trade opened successfully',
      trade_id: tradeRow.id,
      account_id: tradeRow.account_id,
      trade: tradeRow
    }
    if (idempotencyClaim) {
      await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
      idempotencyClaim = null
    }
    res.status(201).json(responseBody)

    // â”€â”€ IP logging on trade open (non-fatal, runs after response) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  } catch (error) {
    if (idempotencyClaim) {
      await abandonIdempotentRequest(pool, idempotencyClaim).catch(() => {})
    }
    logger.error('Open trade error:', { error: error.message })
    if (error?.code === 'PRICE_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'This instrument is currently unavailable for your tenant feed.' })
    }
    res.status(500).json({ error: 'Could not open trade' })
  }
})

module.exports = router
