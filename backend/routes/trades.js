// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const { v4: uuidv4 } = require('uuid')
const rateLimit = require('express-rate-limit')
const { fetchProgressionSettings, promotePassedAccount } = require('../services/progressionService')
const { tradingLimiter } = require('../utils/security')
const { isValidLotSize, sanitizeString } = require('../utils/validation')
const logger = require('../utils/logger')
const { CONTRACT_SIZES } = require('../constants')
const Decimal = require('decimal.js')
const newsService = require('../services/newsService')

// ─────────────────────────────────────────────────────────────────────────────
// Leverage: 1:30 on forex (EURUSD, GBPUSD), 1:10 on commodities (XAUUSD, XAGUSD)
// These values must NOT be changed without also reviewing margin checks.
// ─────────────────────────────────────────────────────────────────────────────
const LEVERAGE = {
  EURUSD: 30,
  GBPUSD: 30,
  XAUUSD: 10,
  XAGUSD: 10
}

// ─────────────────────────────────────────────────────────────────────────────
// Instrument groups for combined exposure checks
// ─────────────────────────────────────────────────────────────────────────────
const COMMODITY_INSTRUMENTS = ['XAUUSD', 'XAGUSD']
const FOREX_INSTRUMENTS     = ['EURUSD', 'GBPUSD']

// ─────────────────────────────────────────────────────────────────────────────
// Combined exposure limits per $1,000 of account size
//   Forex (EURUSD + GBPUSD combined):        0.20 lots per $1k
//   Commodities (XAUUSD + XAGUSD combined):  0.02 lots per $1k
// ─────────────────────────────────────────────────────────────────────────────
const FOREX_LOTS_PER_1K     = 0.20
const COMMODITY_LOTS_PER_1K = 0.02

// ── Load admin-configurable trading rules from platform_settings ──────────────
// Falls back to hardcoded defaults if a setting hasn't been configured yet.
// Cached for 30s to avoid a DB hit on every single trade open.
let _tradingRulesCache   = null
let _tradingRulesCachedAt = 0
const TRADING_RULES_TTL  = 30 * 1000 // 30 seconds

async function getTradingRules() {
  if (_tradingRulesCache && (Date.now() - _tradingRulesCachedAt) < TRADING_RULES_TTL) {
    return _tradingRulesCache
  }
  try {
    const result = await pool.query(
      `SELECT key, value FROM platform_settings
       WHERE key IN ('min_hold_seconds','forex_lots_per_1k','commodity_lots_per_1k','min_lot_size','max_trades_per_1k','dynamic_commission_per_lot', 'slippage_simulator_enabled', 'slippage_max_pips_adverse')`
    )
    const s = {}
    result.rows.forEach(r => { s[r.key] = parseFloat(r.value) })
    _tradingRulesCache = {
      minHoldSeconds:    s.min_hold_seconds     ?? 60,
      forexLotsPer1k:    s.forex_lots_per_1k    ?? FOREX_LOTS_PER_1K,
      commodityLotsPer1k: s.commodity_lots_per_1k ?? COMMODITY_LOTS_PER_1K,
      minLotSize:        s.min_lot_size          ?? 0.01,
      maxTradesPer1k:    s.max_trades_per_1k     ?? 1,
      dynamicCommissionPerLot: s.dynamic_commission_per_lot ?? 3.0,
      slippageSimulatorEnabled: s.slippage_simulator_enabled === 'true',
      slippageMaxPipsAdverse: parseFloat(s.slippage_max_pips_adverse || '0'),
    }
    _tradingRulesCachedAt = Date.now()
    return _tradingRulesCache
  } catch {
    // If DB read fails, return safe defaults
    return {
      minHoldSeconds:    60,
      forexLotsPer1k:    FOREX_LOTS_PER_1K,
      commodityLotsPer1k: COMMODITY_LOTS_PER_1K,
      minLotSize:        0.01,
      maxTradesPer1k:    1,
      dynamicCommissionPerLot: 3.0,
      slippageSimulatorEnabled: false,
      slippageMaxPipsAdverse: 0,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate limit on trade open endpoint
// Max 30 trade open requests per minute per authenticated user.
// Key is userId only — avoids IPv6 bypass warning from express-rate-limit.
// ─────────────────────────────────────────────────────────────────────────────
const tradeOpenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many trade requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user ? String(req.user.userId) : 'anon'
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
async function getLivePrice(instrument) {
  const result = await pool.query(
    'SELECT bid, ask, updated_at FROM price_feed WHERE instrument = $1',
    [instrument]
  )
  if (result.rows.length === 0) throw new Error('Price not available')
  return result.rows[0]
}

async function getPlatformSettingsForProgression(client) {
  const result = await client.query(
    `SELECT key, value FROM platform_settings
     WHERE key IN ('phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit', 'funded_max_drawdown_pct')`
  )
  const settings = {}
  result.rows.forEach(row => { settings[row.key] = row.value })
  return {
    phase2_profit_target_pct: parseFloat(settings.phase2_profit_target_pct || '5'),
    phase2_max_drawdown_pct:  parseFloat(settings.phase2_max_drawdown_pct  || '10'),
    phase2_day_limit:         parseInt(settings.phase2_day_limit || '30', 10),
    funded_max_drawdown_pct:  parseFloat(settings.funded_max_drawdown_pct || '5')
  }
}

function calculatePnL(direction, open_price, current_price, lots, instrument, commission = 0) {
  const lotDec       = new Decimal(lots)
  const contractSize = new Decimal(CONTRACT_SIZES[instrument])
  const priceDiff = direction === 'buy' ? new Decimal(current_price).minus(open_price) : new Decimal(open_price).minus(current_price)
  return priceDiff.times(lotDec).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

function calculateMargin(instrument, lots) {
  const lotDec       = new Decimal(lots)
  const contractSize = new Decimal(CONTRACT_SIZES[instrument])
  const leverage     = new Decimal(LEVERAGE[instrument])
  return lotDec.times(contractSize).div(leverage).toDecimalPlaces(2).toNumber()
}

function getMarketStatus(instrument) {
  const now      = new Date()
  const day      = now.getUTCDay()
  const hour     = now.getUTCHours()
  const min      = now.getUTCMinutes()
  const totalMins = hour * 60 + min

  // Saturday — fully closed
  if (day === 6) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // Friday after 22:00 UTC — weekend
  if (day === 5 && totalMins >= 22 * 60) {
    return { open: false, reason: 'Market is closed for the weekend. Opens Sunday 22:00 UTC.' }
  }
  // Sunday before 22:00 UTC — not yet open
  if (day === 0 && totalMins < 22 * 60) {
    const minsUntil = 22 * 60 - totalMins
    const h = Math.floor(minsUntil / 60)
    const m = minsUntil % 60
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${h}h ${m}m).` }
  }
  // FIX (Bug 11): Daily rollover only applies Mon–Fri (not Sunday evening)
  if (day >= 1 && day <= 5 && totalMins >= 21 * 60 + 55 && totalMins < 22 * 60 + 5) {
    return { open: false, reason: 'Market is in daily rollover (21:55–22:05 UTC). Try again in a few minutes.' }
  }
  return { open: true, reason: '' }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkSLTP — SL/TP background checker
//
// FIX: Previously ran trade close + balance update as two independent queries
// with no transaction. If the balance update failed after the trade was already
// marked closed, the account balance would be permanently wrong.
//
// Fix: each triggered SL/TP now runs inside its own BEGIN/COMMIT block with a
// FOR UPDATE SKIP LOCKED lock on the trade row, preventing the floating
// drawdown checker from racing on the same trade simultaneously.
// ─────────────────────────────────────────────────────────────────────────────
async function checkSLTP(io) {
  try {
    const openTrades = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              t.commission, t.trailing_step_pips, t.trailing_activation_price,
              a.user_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
       AND (t.stop_loss IS NOT NULL OR t.take_profit IS NOT NULL OR t.trailing_step_pips IS NOT NULL)`
    )

    // FIX (BUG-L6): getTradingRules() was called INSIDE the loop for every
    // triggered trade. With 100 open trades it was called 100x per tick (all
    // hitting cache, but still 100 await resolutions). Move it above the loop.
    const rules = await getTradingRules()

    for (const trade of openTrades.rows) {
      let price
      try {
        price = await getLivePrice(trade.instrument)
      } catch {
        continue
      }

      // BUY trades close at BID. SELL trades close at ASK.
      const currentPrice = trade.direction === 'buy'
        ? parseFloat(price.bid)
        : parseFloat(price.ask)

      // ── Trailing Stop Loss Logic ──
      if (trade.trailing_step_pips) {
        let pipMult = 0.0001
        if (trade.instrument.includes('JPY')) pipMult = 0.01
        if (['XAUUSD','US30','NAS100'].includes(trade.instrument)) pipMult = 0.1

        const stepDist = trade.trailing_step_pips * pipMult
        let idealSL = null

        const isActivated = !trade.trailing_activation_price ||
          (trade.direction === 'buy' && currentPrice >= parseFloat(trade.trailing_activation_price)) ||
          (trade.direction === 'sell' && currentPrice <= parseFloat(trade.trailing_activation_price))

        if (isActivated) {
          if (trade.direction === 'buy') idealSL = currentPrice - stepDist
          else idealSL = currentPrice + stepDist

          let shouldUpdate = false
          if (trade.stop_loss == null) shouldUpdate = true
          else if (trade.direction === 'buy' && idealSL > parseFloat(trade.stop_loss)) shouldUpdate = true
          else if (trade.direction === 'sell' && idealSL < parseFloat(trade.stop_loss)) shouldUpdate = true

          if (shouldUpdate) {
            trade.stop_loss = idealSL.toFixed(5)
            pool.query('UPDATE trades SET stop_loss = $1 WHERE id = $2', [trade.stop_loss, trade.id]).catch(()=>{})
          }
        }
      }

      let triggered   = false
      let closeReason = ''

      if (trade.stop_loss) {
        const sl = parseFloat(trade.stop_loss)
        if (trade.direction === 'buy'  && currentPrice <= sl) { triggered = true; closeReason = 'Stop Loss' }
        if (trade.direction === 'sell' && currentPrice >= sl) { triggered = true; closeReason = 'Stop Loss' }
      }

      if (!triggered && trade.take_profit) {
        const tp = parseFloat(trade.take_profit)
        if (trade.direction === 'buy'  && currentPrice >= tp) { triggered = true; closeReason = 'Take Profit' }
        if (trade.direction === 'sell' && currentPrice <= tp) { triggered = true; closeReason = 'Take Profit' }
      }

      if (!triggered) continue

      // FIX (Bug 5): Use admin-configurable min hold time instead of hardcoded 60s
      if (trade.open_time) {
        const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
        if (secondsOpen < rules.minHoldSeconds) continue
      }

      // FIX: wrap close + balance update in a transaction with row-level lock
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Lock the trade row — skip if already being processed elsewhere
        const lockResult = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (lockResult.rows.length === 0) {
          await client.query('ROLLBACK')
          continue
        }

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
          [currentPrice, demo_pnl, closeReason, trade.id]
        )

        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1)
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )

        await client.query('COMMIT')

        if (io) {
          io.to(String(trade.user_id)).emit('account_update', {
            message: `${closeReason} triggered on ${trade.instrument}`,
            pnl: demo_pnl
          })
        }
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error(`checkSLTP: transaction failed for trade ${trade.id}:`, { error: err.message })
      } finally {
        client.release()
      }
    }
  } catch (error) {
    logger.error('SL/TP check error:', { error: error.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending orders background checker
// ─────────────────────────────────────────────────────────────────────────────
async function cancelPendingOrder(orderId, reason) {
  await pool.query(
    `UPDATE trades SET
       status = 'cancelled',
       close_time = NOW(),
       close_reason = $1
     WHERE id = $2`,
    [reason, orderId]
  )
}

async function validatePendingTrigger(client, order, rules) {
  const lotsNum = parseFloat(order.lot_size)
  if (isNaN(lotsNum) || lotsNum <= 0) {
    return 'Invalid lot size on pending order'
  }

  const accountSizeK = parseFloat(order.account_size) / 1000

  // Fetch the fresh account balance inside the transaction
  const accountResult = await client.query(
    `SELECT current_balance FROM accounts WHERE id = $1`,
    [order.account_id]
  )
  if (accountResult.rows.length === 0) {
    return 'Account not found during pending order trigger'
  }
  const current_balance = parseFloat(accountResult.rows[0].current_balance)

  if (COMMODITY_INSTRUMENTS.includes(order.instrument)) {
    const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, COMMODITY_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
      return `Pending order exceeds combined commodity exposure limit (${maxCommodityLots} lots)`
    }
  } else if (FOREX_INSTRUMENTS.includes(order.instrument)) {
    const maxForexLots = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
    const existingResult = await client.query(
      `SELECT COALESCE(SUM(lot_size), 0) as total_lots
       FROM trades
       WHERE account_id = $1
         AND instrument = ANY($2::text[])
         AND status IN ('open', 'pending')
         AND id <> $3`,
      [order.account_id, FOREX_INSTRUMENTS, order.id]
    )
    const currentLots = parseFloat(existingResult.rows[0].total_lots)
    if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
      return `Pending order exceeds combined forex exposure limit (${maxForexLots} lots)`
    }
  }

  const maxOpenTrades = Math.min(50, Math.max(5, Math.floor(parseFloat(order.account_size) / 1000) * rules.maxTradesPer1k))
  const openTradeCountResult = await client.query(
    `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending') AND id <> $2`,
    [order.account_id, order.id]
  )
  const currentOpenCount = parseInt(openTradeCountResult.rows[0].count)
  if ((currentOpenCount + 1) > maxOpenTrades) {
    return `Pending order exceeds max open trades (${maxOpenTrades})`
  }

  const margin = calculateMargin(order.instrument, lotsNum)
  if (margin > current_balance) {
    return `Insufficient balance at trigger. Required margin: $${margin}`
  }

  return null
}

async function checkPendingOrders(io) {
  try {
    const pendingOrders = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.order_type,
              t.pending_price, t.status, a.user_id, a.current_balance, a.peak_balance,
              a.status as account_status, a.account_size
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'pending'`
    )

    const rules = await getTradingRules()

    for (const order of pendingOrders.rows) {
      if (order.account_status !== 'active') {
        await cancelPendingOrder(order.id, 'Account inactive')
        continue
      }

      let price
      try {
        price = await getLivePrice(order.instrument)
      } catch {
        continue
      }

      const bid           = parseFloat(price.bid)
      const ask           = parseFloat(price.ask)
      const pending_price = parseFloat(order.pending_price)

      let triggered = false

      if (order.order_type === 'buy_limit'  && ask <= pending_price) triggered = true
      if (order.order_type === 'sell_limit' && bid >= pending_price) triggered = true
      if (order.order_type === 'buy_stop'   && ask >= pending_price) triggered = true
      if (order.order_type === 'sell_stop'  && bid <= pending_price) triggered = true

      if (triggered) {
        // FIX (Bug 4): Wrap activation in a transaction with row lock to prevent
        // double-triggering and concurrent limit violations
        const client = await pool.connect()
        try {
          await client.query('BEGIN')

          // Lock the order row — skip if already being processed elsewhere
          const lockResult = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'pending' FOR UPDATE SKIP LOCKED`,
            [order.id]
          )
          if (lockResult.rows.length === 0) {
            await client.query('ROLLBACK')
            continue
          }

          const limitError = await validatePendingTrigger(client, order, rules)
          if (limitError) {
            await client.query(
              `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = $1 WHERE id = $2`,
              [limitError, order.id]
            )
            await client.query('COMMIT')
            continue
          }

          const open_price = order.direction === 'buy' ? ask : bid

          await client.query(
            `UPDATE trades SET
               status = 'open',
               open_price = $1,
               open_time = NOW(),
               close_reason = NULL
             WHERE id = $2`,
            [open_price, order.id]
          )

          await client.query('COMMIT')

          if (io) {
            io.to(String(order.user_id)).emit('account_update', {
              message: `${order.order_type.replace(/_/g, ' ').toUpperCase()} triggered on ${order.instrument} at ${open_price}`,
              pnl: null
            })
          }

          logger.info(`Pending order ${order.id} triggered: ${order.order_type} ${order.instrument} at ${open_price}`)
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {})
          logger.error(`checkPendingOrders: transaction error for order ${order.id}:`, { error: txErr.message })
        } finally {
          client.release()
        }
      }
    }
  } catch (error) {
    logger.error('Pending orders check error:', { error: error.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndFail — balance update race condition resolved.
// Collects all trade PnLs first, then applies a single summed balance UPDATE
// after all trades are closed inside the same transaction.
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndFail(acc, reason, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status
       FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    const pricesResult = await client.query('SELECT instrument, bid, ask FROM price_feed')
    const priceMap     = {}
    pricesResult.rows.forEach(p => { priceMap[p.instrument] = p })

    let totalPnl = 0

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price, parseFloat(trade.commission || 0)),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument
        )

        totalPnl += demo_pnl

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Account Failed'
           WHERE id = $3`,
          [close_price, demo_pnl, trade.id]
        )
      } catch (err) {
        logger.error(`Error closing trade ${trade.id} on drawdown breach:`, { error: err.message })
      }
    }

    // Single balance update after all trades are closed — no race condition
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = 'Account Failed'
       WHERE account_id = $1 AND status = 'pending'`,
      [acc.id]
    )

    await client.query(`UPDATE accounts SET status = 'failed' WHERE id = $1`, [acc.id])

    await client.query(
      `INSERT INTO bbook_pnl (date, accounts_failed)
       VALUES (CURRENT_DATE, 1)
       ON CONFLICT (date) DO UPDATE
       SET accounts_failed = bbook_pnl.accounts_failed + 1`
    )

    await client.query('COMMIT')

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: `❌ Account FAILED — ${reason}. All trades closed automatically.`,
        pnl: parseFloat(totalPnl.toFixed(2)),
        account_id: acc.id,
        event: 'account_failed'
      })
    }

    logger.info(`Account ${acc.id} FAILED via floating drawdown — ${reason}`)

  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`autoCloseAndFail error for account ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// autoCloseAndPass — same single-update pattern as autoCloseAndFail
// ─────────────────────────────────────────────────────────────────────────────
async function autoCloseAndPass(acc, io) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades   = await client.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, status
       FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    const pricesResult = await client.query('SELECT instrument, bid, ask FROM price_feed')
    const priceMap     = {}
    pricesResult.rows.forEach(p => { priceMap[p.instrument] = p })

    const closeReason = acc.account_type === 'phase1' ? 'Phase 1 Passed' : 'Phase 2 Passed'
    let totalPnl = 0

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price, parseFloat(trade.commission || 0)),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument
        )

        totalPnl += demo_pnl

        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = $3
           WHERE id = $4`,
          [close_price, demo_pnl, closeReason, trade.id]
        )
      } catch (err) {
        logger.error(`Error closing trade ${trade.id} on profit target hit:`, { error: err.message })
      }
    }

    // Single balance update AND status update after all trades are closed
    await client.query(
      `UPDATE accounts SET
         current_balance = current_balance + $1,
         peak_balance    = GREATEST(peak_balance, current_balance + $1),
         status          = 'passed'
       WHERE id = $2`,
      [totalPnl, acc.id]
    )

    await client.query(
      `UPDATE trades SET
         status = 'cancelled',
         close_time = NOW(),
         close_reason = $1
       WHERE account_id = $2 AND status = 'pending'`,
      [closeReason, acc.id]
    )

    const settings    = await fetchProgressionSettings(client)
    const promoted    = await promotePassedAccount(client, acc, settings)
    const newAccountId = promoted ? promoted.new_account_id : null

    await client.query('COMMIT')

    const passMsg = acc.account_type === 'phase1'
      ? `🏆 Phase 1 PASSED! Floating profit target hit. All trades closed. Phase 2 activating shortly.`
      : `🎉 Phase 2 PASSED! Floating profit target hit. All trades closed. Funded account activating shortly.`

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        message: passMsg,
        pnl: parseFloat(totalPnl.toFixed(2)),
        account_id: acc.id,
        new_account_id: newAccountId,
        event: promoted?.event || (acc.account_type === 'phase1' ? 'phase1_passed' : 'phase2_passed')
      })
    }

    logger.info(`Account ${acc.id} PASSED via floating equity (${acc.account_type})`)

  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`autoCloseAndPass error for account ${acc.id}:`, { error: err.message })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// checkFloatingDrawdown
//
// FIX 1 (BUG 3): Funded accounts now use funded_max_drawdown_pct from
// platform_settings instead of the stored max_drawdown_pct column, which
// could be stale or accidentally 0 (which would instantly fail any account).
//
// FIX 2 (N+1 query): Previously fetched open trades per-account in a loop
// (N accounts × 1 query each). Now fetches ALL open trades and ALL prices
// in two queries up front and groups in JS — O(2) queries regardless of
// how many active accounts exist.
// ─────────────────────────────────────────────────────────────────────────────
async function checkFloatingDrawdown(io) {
  try {
    // Fetch funded drawdown limit once from live platform settings
    const settingsResult = await pool.query(
      `SELECT key, value FROM platform_settings WHERE key = 'funded_max_drawdown_pct'`
    )
    const fundedMaxDrawdownPct = settingsResult.rows.length > 0
      ? parseFloat(settingsResult.rows[0].value)
      : 5 // safe default

    // FIX: single query for all open trades across all active accounts
    const tradesResult = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.direction, t.lot_size, t.open_price,
              t.stop_loss, t.take_profit, t.status, t.open_time, t.demo_trade_id,
              a.user_id, a.current_balance, a.starting_balance, a.peak_balance,
              a.max_drawdown_pct, a.account_type, a.profit_target, a.account_size,
              a.starting_balance as acc_starting
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'
         AND a.status = 'active'`
    )

    if (tradesResult.rows.length === 0) return

    // Single price feed fetch
    const pricesResult = await pool.query('SELECT instrument, bid, ask, updated_at FROM price_feed')
    const priceMap     = {}
    pricesResult.rows.forEach(p => { priceMap[p.instrument] = p })

    // Group trades by account_id in JS — no extra queries
    const accountTrades = {}
    const accountMeta   = {}

    for (const row of tradesResult.rows) {
      const aid = row.account_id
      if (!accountTrades[aid]) {
        accountTrades[aid] = []
        accountMeta[aid] = {
          id:               aid,
          user_id:          row.user_id,
          current_balance:  parseFloat(row.current_balance),
          starting_balance: parseFloat(row.acc_starting),
          peak_balance:     parseFloat(row.peak_balance),
          max_drawdown_pct: parseFloat(row.max_drawdown_pct),
          account_type:     row.account_type,
          account_size:     parseFloat(row.account_size),
          profit_target:    parseFloat(row.profit_target || 0),
        }
      }
      accountTrades[aid].push(row)
    }

    for (const [aid, trades] of Object.entries(accountTrades)) {
      const acc = accountMeta[aid]

      let floatingPnl = 0
      for (const trade of trades) {
        const priceData = priceMap[trade.instrument]
        if (!priceData) continue

        const currentPrice = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        floatingPnl += calculatePnL(
          trade.direction,
          parseFloat(trade.open_price, parseFloat(trade.commission || 0)),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )
      }

      const equity = acc.current_balance + floatingPnl

      // FIX: funded accounts use live platform setting, not the stored column
      const max_drawdown_pct = acc.account_type === 'funded'
        ? fundedMaxDrawdownPct
        : acc.max_drawdown_pct

      const floating_drawdown_pct = ((acc.peak_balance - equity) / acc.peak_balance) * 100
      if (floating_drawdown_pct >= max_drawdown_pct) {
        const reason = `Floating drawdown ${floating_drawdown_pct.toFixed(2)}% reached ${max_drawdown_pct}% limit`
        logger.info(`Account ${aid} DRAWDOWN BREACH: ${reason}`)
        await autoCloseAndFail(acc, reason, io)
        continue
      }

      if (acc.account_type === 'funded') continue

      let profit_target = acc.profit_target
      if (profit_target <= 0) {
        profit_target = acc.starting_balance * 0.10
        logger.warn(`Account ${aid} had no profit_target set — defaulting to 10% = $${profit_target.toFixed(2)}`)
      }

      const equity_profit = equity - acc.starting_balance
      if (equity_profit >= profit_target) {
        const equity_profit_pct = ((equity_profit / acc.starting_balance) * 100).toFixed(2)
        logger.info(`Account ${aid} profit target HIT: $${equity_profit.toFixed(2)} (${equity_profit_pct}%) >= $${profit_target.toFixed(2)}`)
        await autoCloseAndPass(acc, io)
      }
    }

  } catch (error) {
    logger.error('Floating drawdown check error:', { error: error.message })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/candles
// Uses bid price for candle series — matches what traders see when a BUY trade
// closes (at bid), giving chart levels consistent with execution prices.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/candles', authenticateToken, async function(req, res) {
  try {
    const { instrument, timeframe } = req.query

    if (!instrument || !timeframe) {
      return res.status(400).json({ error: 'instrument and timeframe are required' })
    }

    const VALID_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']
    const VALID_TIMEFRAMES  = { '1M': 1, '5M': 5, '15M': 15, '1H': 60, '4H': 240, '1D': 1440 }

    if (!VALID_INSTRUMENTS.includes(instrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    const tfMinutes = VALID_TIMEFRAMES[timeframe]
    if (!tfMinutes) {
      return res.status(400).json({ error: 'Invalid timeframe. Use: 1M, 5M, 15M, 1H, 4H, 1D' })
    }

    const retainDays = parseInt(process.env.PRICE_HISTORY_RETAIN_DAYS || '7', 10)
    const since = new Date()
    since.setDate(since.getDate() - retainDays)

    const rows = await pool.query(
      `SELECT recorded_at, bid, ask
       FROM price_feed_history
       WHERE instrument = $1 AND recorded_at >= $2
       ORDER BY recorded_at ASC`,
      [instrument, since]
    )

    if (rows.rows.length === 0) {
      return res.json([])
    }

    const tfMs   = tfMinutes * 60 * 1000
    const candles = []
    let current   = null

    for (const row of rows.rows) {
      // Use bid price — bid is what BUY trades close at, so chart levels match
      // actual execution prices traders experience.
      const price = parseFloat(row.bid)
      const ts    = new Date(row.recorded_at).getTime()
      const bucketTime = Math.floor(ts / tfMs) * tfMs / 1000

      if (!current || current.time !== bucketTime) {
        if (current) candles.push(current)
        current = { time: bucketTime, open: price, high: price, low: price, close: price }
      } else {
        current.high  = Math.max(current.high, price)
        current.low   = Math.min(current.low, price)
        current.close = price
      }
    }
    if (current) candles.push(current)

    res.json(candles)

  } catch (error) {
    logger.error('Candles error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch candles' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// validatePendingOrderPrice
//   buy_limit  → price must be BELOW current ask
//   sell_limit → price must be ABOVE current bid
//   buy_stop   → price must be ABOVE current ask
//   sell_stop  → price must be BELOW current bid
// ─────────────────────────────────────────────────────────────────────────────
function validatePendingOrderPrice(orderType, pendingPrice, bid, ask) {
  if (isNaN(pendingPrice) || pendingPrice <= 0) {
    return 'Invalid pending order price'
  }
  if (isNaN(bid) || isNaN(ask)) {
    return 'Live price not available — cannot validate pending order price'
  }
  if (orderType === 'buy_limit' && pendingPrice >= ask) {
    return `Buy Limit price must be below current ask (${ask}). Use a Market order to buy at market price.`
  }
  if (orderType === 'sell_limit' && pendingPrice <= bid) {
    return `Sell Limit price must be above current bid (${bid}). Use a Market order to sell at market price.`
  }
  if (orderType === 'buy_stop' && pendingPrice <= ask) {
    return `Buy Stop price must be above current ask (${ask}).`
  }
  if (orderType === 'sell_stop' && pendingPrice >= bid) {
    return `Sell Stop price must be below current bid (${bid}).`
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trades/open
// ─────────────────────────────────────────────────────────────────────────────
router.post('/open', authenticateToken, tradingLimiter, async function(req, res) {
  try {
    const { account_id, instrument, direction, lots, stop_loss, take_profit, order_type, pending_price } = req.body

    // Enhanced input validation
    if (!account_id || !instrument || !direction || !lots) {
      return res.status(400).json({ error: 'account_id, instrument, direction, and lots are required' })
    }

    // Sanitize inputs
    const sanitizedInstrument = sanitizeString(String(instrument).toUpperCase(), 10)
    const sanitizedDirection = sanitizeString(String(direction).toLowerCase(), 10)
    const instrumentFinal = sanitizedInstrument
    const directionFinal = sanitizedDirection
    
    const VALID_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']
    if (!VALID_INSTRUMENTS.includes(sanitizedInstrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    if (!['buy', 'sell'].includes(sanitizedDirection)) {
      return res.status(400).json({ error: 'Direction must be buy or sell' })
    }

    // ── Strict News Protection (3 min USD High Impact) ────────────────────────
    const activeNews = newsService.getActiveNewsEvent(3)
    if (activeNews) {
      return res.status(400).json({ error: `Cannot open trade. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Use validation utility for lot size
    if (!isValidLotSize(lots)) {
      return res.status(400).json({ error: 'Invalid lot size. Must be between 0.01 and 1000 in 0.01 increments.' })
    }

    const lotsNum = parseFloat(lots)

    // ── Minimum lot size (admin-configurable) ──────────────────────────────
    const rules = await getTradingRules()
    const MIN_LOT_SIZE = rules.minLotSize
    if (lotsNum < MIN_LOT_SIZE) {
      return res.status(400).json({ error: `Minimum lot size is ${MIN_LOT_SIZE}. You entered ${lotsNum}.` })
    }

    // ── Lot size must be in 0.01 increments ───────────────────────────────
    const lotsRounded = Math.round(lotsNum * 100) / 100
    if (Math.abs(lotsRounded - lotsNum) > 0.00001) {
      return res.status(400).json({ error: `Lot size must be in 0.01 increments (e.g. 0.01, 0.05, 1.00). You entered ${lotsNum}.` })
    }

    const accountIdStr = String(account_id).trim()
    if (!accountIdStr) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }

    const marketStatus      = getMarketStatus(instrumentFinal)
    const PENDING_ORDER_TYPES = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']
    const orderTypeFinal    = order_type || 'market'
    const isPending         = PENDING_ORDER_TYPES.includes(orderTypeFinal)

    if (!isPending && !marketStatus.open) {
      return res.status(400).json({ error: marketStatus.reason })
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RACE CONDITION FIX: All read-check-write operations run inside a single
    // transaction with SELECT ... FOR UPDATE on the account row. This serialises
    // concurrent trade opens for the same account — two simultaneous requests
    // will queue at the lock, and the second will see the first's INSERT already
    // in the DB when it runs its checks.
    // ─────────────────────────────────────────────────────────────────────────
    const client = await pool.connect()
    let newTrade
    try {
      await client.query('BEGIN')

      // Lock the account row for this transaction
      const lockedAccount = await client.query(
        `SELECT id, user_id, account_size, current_balance, starting_balance, peak_balance,
                status, account_type, phase_end_date
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
      if (account.phase_end_date && new Date(account.phase_end_date) <= new Date()) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Challenge phase has expired. No new trades allowed.' })
      }

      // ── Combined exposure check (inside transaction) ────────────────────
      const accountSizeK = parseFloat(account.account_size) / 1000

      if (COMMODITY_INSTRUMENTS.includes(instrumentFinal)) {
        const maxCommodityLots = parseFloat((accountSizeK * rules.commodityLotsPer1k).toFixed(4))
        const existingResult   = await client.query(
          `SELECT COALESCE(SUM(lot_size), 0) as total_lots
           FROM trades
           WHERE account_id = $1
             AND instrument = ANY($2::text[])
             AND status IN ('open', 'pending')`,
          [accountIdStr, COMMODITY_INSTRUMENTS]
        )
        const currentLots = parseFloat(existingResult.rows[0].total_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxCommodityLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined gold+silver exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxCommodityLots} lots (${rules.commodityLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxCommodityLots - currentLots).toFixed(4)} lots.`
          })
        }
      } else if (FOREX_INSTRUMENTS.includes(instrumentFinal)) {
        const maxForexLots   = parseFloat((accountSizeK * rules.forexLotsPer1k).toFixed(4))
        const existingResult = await client.query(
          `SELECT COALESCE(SUM(lot_size), 0) as total_lots
           FROM trades
           WHERE account_id = $1
             AND instrument = ANY($2::text[])
             AND status IN ('open', 'pending')`,
          [accountIdStr, FOREX_INSTRUMENTS]
        )
        const currentLots = parseFloat(existingResult.rows[0].total_lots)
        if (parseFloat((currentLots + lotsNum).toFixed(4)) > maxForexLots) {
          await client.query('ROLLBACK')
          return res.status(400).json({
            error: `Max combined forex exposure for a $${Number(account.account_size).toLocaleString()} account is ${maxForexLots} lots (${rules.forexLotsPer1k}/1k). Currently used: ${currentLots.toFixed(4)} lots. Available: ${Math.max(0, maxForexLots - currentLots).toFixed(4)} lots.`
          })
        }
      }

      // ── Max simultaneous open trades cap (inside transaction) ─────────
      const maxOpenTrades = Math.min(50, Math.max(5, Math.floor(parseFloat(account.account_size) / 1000) * rules.maxTradesPer1k))
      const openTradeCountResult = await client.query(
        `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status IN ('open', 'pending')`,
        [accountIdStr]
      )
      const currentOpenCount = parseInt(openTradeCountResult.rows[0].count)
      if (currentOpenCount >= maxOpenTrades) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Maximum of ${maxOpenTrades} simultaneous open/pending trades allowed for a $${Number(account.account_size).toLocaleString()} account. You currently have ${currentOpenCount}. Close some trades before opening new ones.`
        })
      }

      // ── Margin check (inside transaction) ──────────────────────────────
      const margin = calculateMargin(instrumentFinal, lotsNum)
      
      let floatingPnl = 0
      const openTradesResult = await client.query(
        `SELECT t.direction, t.open_price, t.lot_size, t.instrument, p.bid, p.ask
         FROM trades t
         JOIN price_feed p ON p.instrument = t.instrument
         WHERE t.account_id = $1 AND t.status = 'open'`,
        [accountIdStr]
      )
      for (const t of openTradesResult.rows) {
        const currentPrice = t.direction === 'buy' ? parseFloat(t.bid) : parseFloat(t.ask)
        floatingPnl += calculatePnL(t.direction, parseFloat(t.open_price, parseFloat(t.commission || 0)), currentPrice, parseFloat(t.lot_size), t.instrument, parseFloat(t.commission || 0))
      }
      
      const equity = parseFloat(account.current_balance) + floatingPnl
      
      if (margin > equity) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: `Insufficient equity. Required margin: $${margin}, Available Equity: $${equity.toFixed(2)}` })
      }

      const demo_trade_id = uuidv4()
      const tradeCommission = parseFloat((lotsNum * rules.dynamicCommissionPerLot).toFixed(2))

      // ── Pending order ───────────────────────────────────────────────────
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
        newTrade = await client.query(
          `INSERT INTO trades
           (account_id, demo_trade_id, instrument, direction, lot_size,
            status, stop_loss, take_profit, order_type, pending_price, commission)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
           RETURNING *`,
          [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum,
           stop_loss   ? parseFloat(stop_loss)   : null,
           take_profit ? parseFloat(take_profit) : null,
           orderTypeFinal,
           parseFloat(pending_price),
           tradeCommission]
        )
        await client.query('COMMIT')

        const tradeRow = newTrade.rows[0]
        return res.status(201).json({
          message: `${orderTypeFinal.replace(/_/g, ' ')} order placed`,
          trade_id: tradeRow.id,
          account_id: tradeRow.account_id,
          trade: tradeRow
        })
      }

      // ── Market order ────────────────────────────────────────────────────
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
      if (rules.slippageSimulatorEnabled && rules.slippageMaxPipsAdverse > 0) {
        const randPips = Math.random() * rules.slippageMaxPipsAdverse
        let pipMult = 0.0001
        if (instrumentFinal.includes('JPY')) pipMult = 0.01
        else if (['XAUUSD','US30','NAS100'].includes(instrumentFinal)) pipMult = 0.1
        
        slippageIncurred = parseFloat(randPips.toFixed(2))
        const slippageAmt = randPips * pipMult
        
        open_price = directionFinal === 'buy' ? open_price + slippageAmt : open_price - slippageAmt
        open_price = parseFloat(open_price.toFixed(5))
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

      newTrade = await client.query(
        `INSERT INTO trades
         (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
          status, stop_loss, take_profit, order_type, commission, slippage_pips)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'open', $7, $8, 'market', $9, $10)
         RETURNING *`,
        [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, lotsNum, open_price,
         stop_loss   ? parseFloat(stop_loss)   : null,
         take_profit ? parseFloat(take_profit) : null,
         tradeCommission,
         slippageIncurred]
      )

      await client.query('COMMIT')

    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    const tradeRow = newTrade.rows[0]
    res.status(201).json({
      message: 'Trade opened successfully',
      trade_id: tradeRow.id,
      account_id: tradeRow.account_id,
      trade: tradeRow
    })

    // ── IP logging on trade open (non-fatal, runs after response) ──────────
    try {
      const tradeIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'
      await pool.query(
        `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [newTrade.rows[0].id, req.user.userId, accountIdStr, tradeIp]
      )
    } catch (logErr) {
      logger.error('[trade_log] Failed to log trade IP:', { error: logErr.message })
    }

  } catch (error) {
    logger.error('Open trade error:', { error: error.message })
    res.status(500).json({ error: error.message || 'Could not open trade' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trades/close
//
// FIX (Bug 1): Wrapped trade close + balance update in a single transaction
// with FOR UPDATE SKIP LOCKED on the trade row. This prevents:
// (a) balance corruption if one query succeeds but the other fails
// (b) double-close race with the background checkSLTP checker
// ─────────────────────────────────────────────────────────────────────────────
// FIX (LOOPHOLE 1): Rate limit trade close to prevent DoS flooding
const tradeCloseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many close requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/close', authenticateToken, tradeCloseLimiter, async function(req, res) {
  try {
    const { trade_id, close_lots } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }

    // Pre-flight check (outside transaction) for quick rejection
    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade = tradeResult.rows[0]

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    const secondsOpen = (new Date() - new Date(trade.open_time)) / 1000
    const rules = await getTradingRules()
    const { minHoldSeconds } = rules
    if (secondsOpen < minHoldSeconds) {
      return res.status(400).json({
        error: `Minimum trade duration is ${minHoldSeconds} seconds. Please wait ${Math.ceil(minHoldSeconds - secondsOpen)} more seconds.`
      })
    }

    const price = await getLivePrice(trade.instrument)
    const priceAgeMs = Date.now() - new Date(price.updated_at).getTime()
    // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
    if (priceAgeMs > 10000) {
      logger.warn('Price feed too old on close:', { instrument: trade.instrument, ageMs: priceAgeMs })
      return res.status(400).json({ error: 'Price feed is currently delayed. Close rejected due to volatility protection/latency.' })
    }
    
    // BUY closes at BID, SELL closes at ASK
    let close_price = trade.direction === 'buy'
      ? parseFloat(price.bid)
      : parseFloat(price.ask)

    if (rules.slippageSimulatorEnabled && rules.slippageMaxPipsAdverse > 0) {
      const randPips = Math.random() * rules.slippageMaxPipsAdverse
      let pipMult = 0.0001
      if (trade.instrument.includes('JPY')) pipMult = 0.01
      else if (['XAUUSD','US30','NAS100'].includes(trade.instrument)) pipMult = 0.1
      
      const slippageAmt = randPips * pipMult
      
      close_price = trade.direction === 'buy' ? close_price - slippageAmt : close_price + slippageAmt
      close_price = parseFloat(close_price.toFixed(5))
    }

    let demo_pnl = 0
    let isPartial = false
    let currentLotSize = parseFloat(trade.lot_size)
    let closeLotsAmt = close_lots ? parseFloat(close_lots) : currentLotSize

    if (closeLotsAmt <= 0 || closeLotsAmt > currentLotSize) {
      return res.status(400).json({ error: 'Invalid close fraction' })
    }

    isPartial = closeLotsAmt < currentLotSize
    const ratio = closeLotsAmt / currentLotSize
    const partialCommission = parseFloat((parseFloat(trade.commission || 0) * ratio).toFixed(2))
    const remainingCommission = parseFloat(trade.commission || 0) - partialCommission

    const pnlPortion = calculatePnL(
      trade.direction,
      parseFloat(trade.open_price),
      close_price,
      closeLotsAmt,
      trade.instrument,
      partialCommission
    )
    demo_pnl = pnlPortion

    // FIX (Bug 1): Transaction with row-level lock
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Lock the trade row — skip if already being processed by checkSLTP
      const lockResult = await client.query(
        `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
        [trade_id]
      )
      if (lockResult.rows.length === 0) {
        await client.query('ROLLBACK')
        return res.status(404).json({ error: 'Trade not found or already closed' })
      }

      if (isPartial) {
        // Log child closed trade
        await client.query(
          `INSERT INTO trades (account_id, instrument, direction, lot_size, open_price, open_time,
           status, close_price, close_time, demo_pnl, close_reason, commission, parent_trade_id, is_partial)
           VALUES ($1, $2, $3, $4, $5, $6, 'closed', $7, NOW(), $8, 'Manual Partial Close', $9, $10, true)`,
          [trade.account_id, trade.instrument, trade.direction, closeLotsAmt, trade.open_price, trade.open_time, close_price, pnlPortion, partialCommission, trade_id]
        )
        // Shrink the current open trade
        await client.query(
          `UPDATE trades SET lot_size = lot_size - $1, commission = $2 WHERE id = $3`,
          [closeLotsAmt, remainingCommission, trade_id]
        )
      } else {
        await client.query(
          `UPDATE trades SET
             status = 'closed',
             close_price = $1,
             close_time = NOW(),
             demo_pnl = $2,
             close_reason = 'Manual Close'
           WHERE id = $3`,
          [close_price, demo_pnl, trade_id]
        )
      }

      await client.query(
        `UPDATE accounts SET
           current_balance = current_balance + $1,
           peak_balance    = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [demo_pnl, trade.account_id]
      )

      await client.query('COMMIT')
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {})
      throw txErr
    } finally {
      client.release()
    }

    if (req.app.get('io')) {
      req.app.get('io').to(String(trade.user_id)).emit('account_update', {
        message: `Trade closed on ${trade.instrument}: ${demo_pnl >= 0 ? '+' : ''}$${demo_pnl.toFixed(2)}`,
        pnl: demo_pnl
      })
    }

    res.json({ message: 'Trade closed successfully', pnl: demo_pnl, close_price })

  } catch (error) {
    logger.error('Close trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not close trade' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trades/cancel   (cancel a pending order)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/cancel', authenticateToken, async function(req, res) {
  try {
    const { trade_id } = req.body

    if (!trade_id) return res.status(400).json({ error: 'Trade ID required' })

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'pending'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pending order not found' })
    }

    if (tradeResult.rows[0].user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    await pool.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = 'Cancelled by trader'
       WHERE id = $1`,
      [trade_id]
    )

    res.json({ message: 'Order cancelled' })

  } catch (error) {
    logger.error('Cancel order error:', { error: error.message })
    res.status(500).json({ error: 'Could not cancel order' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trades/modify  (update SL/TP on open trade)
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/modify', authenticateToken, async function(req, res) {
  try {
    const { trade_id, stop_loss, take_profit } = req.body

    if (!trade_id) {
      return res.status(400).json({ error: 'Trade ID required' })
    }

    if (stop_loss === undefined && take_profit === undefined) {
      return res.status(400).json({ error: 'Provide at least one of stop_loss or take_profit' })
    }

    const tradeResult = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND t.status = 'open'`,
      [trade_id]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    const trade      = tradeResult.rows[0]
    const open_price = parseFloat(trade.open_price)

    if (trade.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Unauthorized' })
    }

    // FIX (BUG-M7): Added minimum distance enforcement for SL/TP modification.
    // Prevents setting SL/TP so close to entry that they trigger immediately or
    // are used to game the system. Minimum distances:
    //   Metals (XAUUSD, XAGUSD): 0.5 price units
    //   Forex pairs:             0.0001 (1 pip on 4/5-decimal instruments)
    const MIN_DISTANCE = ['XAUUSD', 'XAGUSD'].includes(trade.instrument) ? 0.5 : 0.0001

    if (stop_loss !== undefined && stop_loss !== '' && stop_loss !== null) {
      const sl = parseFloat(stop_loss)
      if (isNaN(sl)) return res.status(400).json({ error: 'Invalid stop loss value' })
      if (trade.direction === 'buy'  && sl >= open_price) return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
      if (trade.direction === 'sell' && sl <= open_price) return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
      if (Math.abs(open_price - sl) < MIN_DISTANCE) return res.status(400).json({ error: `Stop loss must be at least ${MIN_DISTANCE} away from entry price` })
    }

    if (take_profit !== undefined && take_profit !== '' && take_profit !== null) {
      const tp = parseFloat(take_profit)
      if (isNaN(tp)) return res.status(400).json({ error: 'Invalid take profit value' })
      if (trade.direction === 'buy'  && tp <= open_price) return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
      if (trade.direction === 'sell' && tp >= open_price) return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
      if (Math.abs(open_price - tp) < MIN_DISTANCE) return res.status(400).json({ error: `Take profit must be at least ${MIN_DISTANCE} away from entry price` })
    }

    const updates = []
    const values  = []
    let idx = 1

    if (stop_loss !== undefined) {
      updates.push(`stop_loss = $${idx++}`)
      values.push(stop_loss === '' || stop_loss === null ? null : parseFloat(stop_loss))
    }

    if (take_profit !== undefined) {
      updates.push(`take_profit = $${idx++}`)
      values.push(take_profit === '' || take_profit === null ? null : parseFloat(take_profit))
    }

    values.push(trade_id)
    await pool.query(
      `UPDATE trades SET ${updates.join(', ')} WHERE id = $${idx}`,
      values
    )

    res.json({ message: 'Trade modified successfully' })

  } catch (error) {
    logger.error('Modify trade error:', { error: error.message })
    res.status(500).json({ error: 'Could not modify trade' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/trades/note  — Save a personal note on a trade
// Notes are private — only the trade owner can read/write them.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/note', authenticateToken, async function(req, res) {
  try {
    const { trade_id, note, tags } = req.body

    if (!trade_id) return res.status(400).json({ error: 'trade_id required' })
    if (typeof note !== 'string') return res.status(400).json({ error: 'note must be a string' })
    if (note.length > 1000) return res.status(400).json({ error: 'Note must be 1000 characters or less' })
    if (tags && typeof tags !== 'string') return res.status(400).json({ error: 'tags must be a comma separated string' })

    // Ensure notes column exists (safe — idempotent)
    try {
      await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS trader_note TEXT`)
    } catch (_) {}

    // Verify trade belongs to this user
    const tradeCheck = await pool.query(
      `SELECT t.id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.id = $1 AND a.user_id = $2`,
      [trade_id, req.user.userId]
    )
    if (tradeCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' })
    }

    const tagsJson = tags ? JSON.stringify(tags.split(',').map(t => t.trim()).filter(Boolean)) : null

    await pool.query(
      `UPDATE trades SET trader_note = $1, tags = $2 WHERE id = $3`,
      [note.trim() || null, tagsJson, trade_id]
    )

    res.json({ message: 'Note and tags saved', trade_id, note: note.trim() || null, tags: tagsJson })
  } catch (error) {
    logger.error('Save note error:', { error: error.message })
    res.status(500).json({ error: 'Could not save note' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/open
// ─────────────────────────────────────────────────────────────────────────────
router.get('/open', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, stop_loss,
              take_profit, status, demo_pnl, open_time, close_time, close_reason, order_type
       FROM trades WHERE account_id = $1 AND status = 'open' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows)
  } catch (error) {
    logger.error('Open trades error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch open trades' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/pending
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, pending_price, order_type,
              status, open_time, demo_trade_id
       FROM trades WHERE account_id = $1 AND status = 'pending' ORDER BY open_time DESC`,
      [account_id]
    )

    res.json(trades.rows)
  } catch (error) {
    logger.error('Pending orders error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch pending orders' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/history
// ─────────────────────────────────────────────────────────────────────────────
router.get('/history', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.query

    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const trades = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type, trader_note
       FROM trades WHERE account_id = $1 AND status NOT IN ('open', 'pending') ORDER BY close_time DESC`,
      [account_id]
    )

    res.json(trades.rows)
  } catch (error) {
    logger.error('Trade history error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trade history' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/export — download full trade history as CSV
// ─────────────────────────────────────────────────────────────────────────────
router.get('/export', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountCheck = await pool.query(
      `SELECT id, account_type, account_size FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const acc = accountCheck.rows[0]

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades
       WHERE account_id = $1
       AND status NOT IN ('open', 'pending')
       ORDER BY close_time DESC`,
      [account_id]
    )

    const trades = tradesResult.rows

    const headers = [
      'ID', 'Instrument', 'Direction', 'Lots',
      'Open Price', 'Close Price', 'Open Time', 'Close Time',
      'P&L', 'Close Reason', 'Order Type'
    ]

    const rows = trades.map(t => [
      t.id,
      t.instrument,
      t.direction,
      parseFloat(t.lot_size).toFixed(2),
      t.open_price  ? parseFloat(t.open_price).toFixed(5)  : '',
      t.close_price ? parseFloat(t.close_price).toFixed(5) : '',
      t.open_time   ? new Date(t.open_time).toISOString()  : '',
      t.close_time  ? new Date(t.close_time).toISOString() : '',
      t.demo_pnl    ? parseFloat(t.demo_pnl).toFixed(2)    : '0.00',
      t.close_reason || 'Manual',
      t.order_type  || 'market'
    ])

    // FIX (Bug 12): Sanitize CSV values to prevent formula injection
    function csvSafeValue(val) {
      let str = String(val).replace(/"/g, '""')
      // Prefix formula-triggering characters with a single quote
      if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
      return `"${str}"`
    }

    const csvContent = [headers, ...rows]
      .map(row => row.map(v => csvSafeValue(v)).join(','))
      .join('\r\n')

    const filename = `trades_${acc.account_type}_${acc.account_size}_${new Date().toISOString().slice(0,10)}.csv`

    res.setHeader('Content-Type', 'text/csv')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.send(csvContent)

  } catch (error) {
    logger.error('Trade export error:', { error: error.message })
    res.status(500).json({ error: 'Could not export trades' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/trades/analytics
// ─────────────────────────────────────────────────────────────────────────────
router.get('/analytics', authenticateToken, async function(req, res) {
  try {
    const { account_id } = req.query
    if (!account_id) return res.status(400).json({ error: 'account_id required' })

    const accountResult = await pool.query(
      `SELECT id, user_id, account_type, account_size, current_balance, starting_balance,
              peak_balance, status, profit_target, max_drawdown_pct
       FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, req.user.userId]
    )
    if (accountResult.rows.length === 0) return res.status(404).json({ error: 'Account not found' })

    const account = accountResult.rows[0]

    const tradesResult = await pool.query(
      `SELECT id, account_id, instrument, direction, lot_size, open_price, close_price,
              stop_loss, take_profit, status, demo_pnl, open_time, close_time, close_reason,
              order_type
       FROM trades WHERE account_id = $1 AND status = 'closed' ORDER BY close_time ASC`,
      [account_id]
    )
    const trades = tradesResult.rows

    if (trades.length === 0) {
      return res.json({ account, analytics: null })
    }

    const winners   = trades.filter(t => parseFloat(t.demo_pnl) > 0)
    const losers    = trades.filter(t => parseFloat(t.demo_pnl) < 0)
    const breakeven = trades.filter(t => parseFloat(t.demo_pnl) === 0)

    const win_rate     = parseFloat(((winners.length / trades.length) * 100).toFixed(1))
    const total_pnl    = trades.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_profit = winners.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0)
    const gross_loss   = Math.abs(losers.reduce((sum, t) => sum + parseFloat(t.demo_pnl), 0))

    const avg_win       = winners.length ? parseFloat((gross_profit / winners.length).toFixed(2)) : 0
    const avg_loss      = losers.length  ? parseFloat((gross_loss   / losers.length).toFixed(2))  : 0
    const profit_factor = gross_loss > 0 ? parseFloat((gross_profit / gross_loss).toFixed(2)) : gross_profit > 0 ? 999 : 0
    const avg_rr        = avg_loss > 0   ? parseFloat((avg_win / avg_loss).toFixed(2)) : 0

    const pnlValues   = trades.map(t => parseFloat(t.demo_pnl))
    const best_trade  = parseFloat(pnlValues.reduce((a, b) => Math.max(a, b), -Infinity).toFixed(2))
    const worst_trade = parseFloat(pnlValues.reduce((a, b) => Math.min(a, b),  Infinity).toFixed(2))

    const durations = trades
      .filter(t => t.open_time && t.close_time)
      .map(t => (new Date(t.close_time) - new Date(t.open_time)) / 1000 / 60)
    const avg_trade_duration_mins = durations.length
      ? parseFloat((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
      : 0

    let runningBalance = parseFloat(account.starting_balance)
    let peakBalance    = runningBalance
    const drawdown_curve = trades.map(t => {
      runningBalance += parseFloat(t.demo_pnl)
      peakBalance     = Math.max(peakBalance, runningBalance)
      const drawdown  = parseFloat(((peakBalance - runningBalance) / peakBalance * 100).toFixed(2))
      return {
        date:     t.close_time,
        balance:  parseFloat(runningBalance.toFixed(2)),
        drawdown: Math.max(0, drawdown)
      }
    })

    const heatmap = {
      '00:00':0, '02:00':0, '04:00':0, '06:00':0, '08:00':0, '10:00':0,
      '12:00':0, '14:00':0, '16:00':0, '18:00':0, '20:00':0, '22:00':0
    }
    trades.forEach(t => {
      if (!t.open_time) return
      const h = new Date(t.open_time).getHours()
      const bucket = `${String(Math.floor(h/2)*2).padStart(2, '0')}:00`
      heatmap[bucket] += parseFloat(t.demo_pnl)
    })
    for (const k in heatmap) heatmap[k] = parseFloat(heatmap[k].toFixed(2))

    res.json({
      account,
      analytics: {
        total_trades: trades.length,
        winning_trades: winners.length,
        losing_trades: losers.length,
        breakeven_trades: breakeven.length,
        win_rate,
        total_pnl: parseFloat(total_pnl.toFixed(2)),
        avg_win, avg_loss, profit_factor, avg_rr,
        best_trade, worst_trade, avg_trade_duration_mins,
        drawdown_curve,
        heatmap
      }
    })

  } catch (error) {
    logger.error('Analytics error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch analytics' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/trades/batch-action
// ─────────────────────────────────────────────────────────────────────────────
router.post('/batch-action', authenticateToken, tradingLimiter, async function(req, res) {
  try {
    const { action, account_id } = req.body
    if (!['close_winning', 'close_losing', 'breakeven_winning'].includes(action) || !account_id) {
      return res.status(400).json({ error: 'Invalid batch action or account ID' })
    }

    const openTradesResult = await pool.query(
      `SELECT t.* FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1 AND t.account_id = $2 AND t.status = 'open'`,
      [req.user.userId, account_id]
    )

    if (openTradesResult.rows.length === 0) {
      return res.json({ message: 'No open trades to process', affected: 0 })
    }

    let affectedCount = 0

    const client = await pool.connect()
    try {
      for (const trade of openTradesResult.rows) {
        let currentPrice
        try {
          const priceObj = await getLivePrice(trade.instrument)
          currentPrice = trade.direction === 'buy' ? parseFloat(priceObj.bid) : parseFloat(priceObj.ask)
        } catch { continue } // Skip if price feed down for this instrument

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        let shouldProcess = false
        if (action === 'close_winning' && demo_pnl > 0) shouldProcess = true
        if (action === 'close_losing' && demo_pnl < 0) shouldProcess = true
        if (action === 'breakeven_winning' && demo_pnl > 0) shouldProcess = true

        if (!shouldProcess) continue

        await client.query('BEGIN')
        // Lock trade row
        const lock = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (lock.rows.length === 0) { await client.query('ROLLBACK'); continue }

        if (action === 'breakeven_winning') {
          await client.query(
            `UPDATE trades SET stop_loss = $1 WHERE id = $2`,
            [trade.open_price, trade.id]
          )
          affectedCount++
        } else {
          // Close trade logic
          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(), demo_pnl = $2, close_reason = 'Batch Close' WHERE id = $3`,
            [currentPrice, demo_pnl, trade.id]
          )
          await client.query(
            `UPDATE accounts SET current_balance = current_balance + $1, peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
            [demo_pnl, trade.account_id]
          )
          affectedCount++
        }
        await client.query('COMMIT')
      }
    } catch (txErr) {
       await client.query('ROLLBACK').catch(() => {})
       throw txErr
    } finally {
       client.release()
    }

    res.json({ message: `Batch ${action.replace('_', ' ')} completed successfully`, affected: affectedCount })
  } catch (error) {
    logger.error('Batch action error:', { error: error.message })
    res.status(500).json({ error: 'Could not process batch action' })
  }
})

module.exports = { router, checkSLTP, checkPendingOrders, checkFloatingDrawdown, validatePendingOrderPrice }
