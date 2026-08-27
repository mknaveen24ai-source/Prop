// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
import Decimal from 'decimal.js'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import type { Server } from 'socket.io'
import pool = require('./db')
import logger = require('./utils/logger')
import { calculatePnL } from './utils/pnlCalculator'
import './loadEnv'
import { getCurrentPricesForTenant } from './priceFeed'
import { getTenantSettings } from './services/tenantPolicyService'
import {
  applyAccountEnforcement,
  recordEnforcementEvent,
  recordViolation
} from './services/violationEngine'
import drawdownService = require('./services/drawdownService')
import { checkFeedHealthWithAlerting } from './services/feedHealth'
import tradingDaysService = require('./services/tradingDaysService')

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type NumericInput = string | number | null | undefined
type BbookMetricColumn = 'accounts_expired' | 'accounts_failed' | 'accounts_passed' | 'new_funded'

interface EngineAccount extends QueryResultRow {
  id: string
  user_id: string
  account_type: string
  account_size: NumericInput
  current_balance: NumericInput
  starting_balance: NumericInput
  max_drawdown_pct: NumericInput
  profit_target: NumericInput
  phase_start_date: Date | string | null
  phase_end_date: Date | string | null
  created_at: Date | string | null
  challenge_model_slug: string | null
  daily_drawdown_pct: NumericInput
  min_trading_days: NumericInput
  min_daily_profit_pct: NumericInput
  consistency_max_day_pct: NumericInput
  eod_peak_equity: NumericInput
  eod_trailing_floor: NumericInput
}

interface TradeRow extends QueryResultRow {
  id: string
  instrument: string
  direction: string
  open_price: string
  lot_size: string
  commission: string | null
  open_time: Date | string | null
}

interface IdRow extends QueryResultRow {
  id: string
}

interface CountRow extends QueryResultRow {
  count: string
}

interface UserEmailRow extends QueryResultRow {
  email: string
  full_name: string
}

interface LastActivityRow extends QueryResultRow {
  last_activity_at: Date | string | null
}

interface ScalingAccountRow extends QueryResultRow {
  id: string
  user_id: string
  starting_balance: string
  current_balance: string
  scaling_milestones_claimed: string
}

interface TotalRow extends QueryResultRow {
  total: string
}

interface ScalingMultiplierRow extends QueryResultRow {
  scaling_multiplier: string
}

interface RapidTradeRow extends QueryResultRow {
  direction: string
  open_time: Date | string
}

interface RapidGroupRow extends QueryResultRow {
  user_id: string
  instrument: string
  account_ids: string[]
}

interface OpposingGroupRow extends RapidGroupRow {
  total_buy_lots: string | null
  total_sell_lots: string | null
}

interface PlatformSettings {
  funded_max_drawdown_pct: number
  inactivity_auto_fail_enabled: boolean
  inactivity_fail_days: number
  [key: string]: unknown
}

interface FailAccountOptions {
  closeReason?: string
  skipDrawdownCheck?: boolean
  violationType?: string
  enforcementAction?: string
  socketEvent?: string
  payload?: Record<string, unknown>
}

interface PromotionReview {
  id: string
  target_account_type: string
}

interface ProgressionApi {
  fetchProgressionSettings: (database: Pool) => Promise<Record<string, unknown> & { funded_max_drawdown_pct: number }>
  createPendingPromotionReview: (
    client: PoolClient,
    account: EngineAccount,
    options: {
      triggeredBy: string
      reason: string
      payload: Record<string, unknown>
    }
  ) => Promise<PromotionReview | null>
}

interface EmailQueueApi {
  enqueuePhasePassedEmail: (
    email: string,
    fullName: string,
    accountType: string,
    accountSize: NumericInput,
    options: { userId: string }
  ) => Promise<unknown>
  enqueueAccountFailedEmail: (
    email: string,
    fullName: string,
    accountType: string,
    reason: string,
    accountSize: NumericInput,
    options: { userId: string }
  ) => Promise<unknown>
  enqueueAccountExpiredEmail: (
    email: string,
    fullName: string,
    accountType: string,
    accountSize: NumericInput,
    options: { userId: string }
  ) => Promise<unknown>
}

interface StepModelRow {
  scaling_enabled: boolean
  scaling_target_pct: string
  scaling_multiplier: string | null
  scaling_max_account_size: string | null
  scaling_increase_per_milestone_pct: string | null
  funded_max_drawdown_pct: string
  funded_daily_drawdown_pct: string
  funded_drawdown_locks_at_pct: string | null
}

interface StepModelsApi {
  fetchStepModelBySlug: (slug: string) => Promise<StepModelRow | null>
}

interface BalanceAdjustmentsApi {
  applyBalanceAdjustment: (
    client: PoolClient,
    payload: {
      accountId: string
      amount: number
      source: string
      reason: string
      createdBy: string
      metadata: Record<string, unknown>
    }
  ) => Promise<{ balanceAfter: number }>
}

interface UserNotificationsApi {
  createUserNotification: (
    io: TypedServer | null,
    userId: string,
    payload: { type: string; title: string; message: string }
  ) => Promise<unknown>
}

const {
  fetchProgressionSettings,
  createPendingPromotionReview
} = require('./services/progressionService') as ProgressionApi
const {
  enqueuePhasePassedEmail,
  enqueueAccountFailedEmail,
  enqueueAccountExpiredEmail
} = require('./utils/emailQueue') as EmailQueueApi
const { fetchStepModelBySlug } = require('./utils/stepModels') as StepModelsApi
const { applyBalanceAdjustment } = require('./utils/balanceAdjustments') as BalanceAdjustmentsApi
const { createUserNotification } = require('./utils/userNotifications') as UserNotificationsApi

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

let reviewFlagColumnsReady = false

// FIX (AUDIT): Per-account warning level cache to prevent flooding the client
// socket with duplicate drawdown_warning events on every engine cycle.
// Key: accountId (string), Value: last emitted warningLevel (number)
const _lastDrawdownWarningLevel = new Map<string, number>()
const _lastConsistencyWarningLevel = new Map<string, boolean>()
// Same treatment for the qualifying-trading-days hold. Without it a trader who
// hits their target early sits on a passed target watching nothing happen — the
// consistency hold explained itself and this one returned in silence.
const _lastTradingDaysHoldLevel = new Map<string, number>()

// How many accounts the sweep evaluates at once. Well under the write pool's 60
// connections, because the trading hot path shares that pool and a sweep must
// never be the reason an order waits for a connection. Override per deployment
// once the account count justifies it.
const ENGINE_SWEEP_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ENGINE_SWEEP_CONCURRENCY || '8', 10) || 8
)

async function safeRecordViolation(payload: Record<string, unknown>): Promise<void> {
  try {
    await recordViolation(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record violation:', { error: errorMessage(err), type: payload.violationType })
  }
}

async function safeRecordEnforcement(payload: Record<string, unknown>): Promise<void> {
  try {
    await recordEnforcementEvent(payload)
  } catch (err) {
    logger.error('[violation-engine] Failed to record enforcement event:', { error: errorMessage(err), action: payload.action })
  }
}

async function fetchChallengeAutomationSettings(): Promise<Pick<PlatformSettings, 'inactivity_auto_fail_enabled' | 'inactivity_fail_days'>> {
  const settings = await getTenantSettings(['inactivity_auto_fail_enabled', 'inactivity_fail_days'])
  return {
    inactivity_auto_fail_enabled: settings.inactivity_auto_fail_enabled !== 'false',
    inactivity_fail_days: parseInt(settings.inactivity_fail_days || '30', 10)
  }
}

async function getLastTradeActivityAt(
  accountId: string,
  fallbackDate: Date | string | null
): Promise<Date | string | null> {
  const result = await pool.query<LastActivityRow>(
    `SELECT NULLIF(MAX(GREATEST(COALESCE(open_time, '-infinity'::timestamptz), COALESCE(close_time, '-infinity'::timestamptz))), '-infinity'::timestamptz) AS last_activity_at
     FROM trades
     WHERE account_id = $1`,
    [accountId]
  )
  return result.rows[0]?.last_activity_at || fallbackDate || null
}

async function incrementBbookMetric(client: PoolClient, column: BbookMetricColumn): Promise<void> {
  const safeColumn = ['accounts_expired', 'accounts_failed', 'accounts_passed', 'new_funded'].includes(column)
    ? column
    : null
  if (!safeColumn) {
    throw new Error(`Unsupported bbook metric: ${column}`)
  }

  await client.query(
    `INSERT INTO bbook_pnl (date, ${safeColumn})
     VALUES (CURRENT_DATE, 1)
     ON CONFLICT (date) DO UPDATE
     SET ${safeColumn} = bbook_pnl.${safeColumn} + 1`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// expireAccount — marks account expired, force-closes all open trades.
// FIX: Now wrapped in a transaction with FOR UPDATE SKIP LOCKED to prevent
// data inconsistency if the server crashes mid-operation.
// ─────────────────────────────────────────────────────────────────────────────
async function expireAccount(acc: EngineAccount, io: TypedServer | null): Promise<void> {
  // Read before BEGIN — see failAccount for why: this is a query on a separate
  // pool connection, and issuing it mid-transaction held the account row lock
  // across an unrelated round-trip.
  const priceMap = await getCurrentPricesForTenant()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query<IdRow>(
      `SELECT id FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(`UPDATE accounts SET status = 'expired' WHERE id = $1`, [acc.id])

    const openTrades = await client.query<TradeRow>(
      `SELECT * FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (priceData) {
          const close_price = trade.direction === 'buy'
            ? parseFloat(String(priceData.bid))
            : parseFloat(String(priceData.ask))

          const demo_pnl = calculatePnL(
            trade.direction, parseFloat(trade.open_price),
            close_price, parseFloat(trade.lot_size), trade.instrument,
            parseFloat(String(trade.commission || 0))
          )
          totalPnlDec = totalPnlDec.plus(demo_pnl)

          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
               demo_pnl = $2, close_reason = 'Account Expired' WHERE id = $3`,
            [close_price, demo_pnl, trade.id]
          )
        } else {
          await client.query(
            `UPDATE trades SET status = 'closed', close_time = NOW(),
               demo_pnl = 0, close_reason = 'Account Expired' WHERE id = $1`,
            [trade.id]
          )
        }
      } catch (tradeError: unknown) {
        logger.error(`Error closing trade ${trade.id} on expiry:`, { error: errorMessage(tradeError) })
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET current_balance = current_balance + $1,
           peak_balance = GREATEST(peak_balance, current_balance + $1) WHERE id = $2`,
        [totalPnl, acc.id]
      )
    }

    await client.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(),
         close_reason = 'Account Expired' WHERE account_id = $1 AND status = 'pending'`,
      [acc.id]
    )

    await incrementBbookMetric(client, 'accounts_expired')

    await client.query('COMMIT')

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event: 'account_expired',
        account_id: acc.id,
        message: `⏰ Challenge EXPIRED — the time limit was reached before the profit target. All trades have been closed.`,
      })
    }

    try {
      const userResult = await pool.query<UserEmailRow>('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]!
        enqueueAccountExpiredEmail(email, full_name, acc.account_type, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
      }
    } catch (emailErr: unknown) {
      logger.error('[mail] expireAccount email lookup failed:', { error: errorMessage(emailErr) })
    }

    logger.info(`Account ${acc.id} EXPIRED — phase_end_date reached`)
  } catch (err: unknown) {
    await client.query('ROLLBACK')
    logger.error(`expireAccount error for account ${acc.id}:`, { error: errorMessage(err) })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// failAccount — marks account failed, force-closes all open trades at live
// prices, and cancels all pending orders.
// Uses FOR UPDATE SKIP LOCKED to prevent double-processing with the floating
// drawdown checker in trades.js.
// ─────────────────────────────────────────────────────────────────────────────
async function failAccount(
  acc: EngineAccount,
  reason: string,
  io: TypedServer | null,
  _platformSettings: PlatformSettings | null = null,
  options: FailAccountOptions = {}
): Promise<void> {
  // Read before BEGIN. getCurrentPricesForTenant() queries price_feed on a
  // separate pool connection, and running it inside the transaction held this
  // account's row lock across an unrelated round-trip. It is a read-only
  // snapshot, so hoisting does not affect the close arithmetic below.
  const priceMap = await getCurrentPricesForTenant()

  const client = await pool.connect()
  try {
    const closeReason = options.closeReason || 'Account Failed'
    const skipDrawdownCheck = !!options.skipDrawdownCheck
    const violationType = options.violationType || 'drawdown_breach'
    const enforcementAction = options.enforcementAction || 'auto_fail_account'
    const socketEvent = options.socketEvent || 'account_failed'
    const extraPayload = options.payload || {}

    await client.query('BEGIN')

    const lockResult = await client.query<EngineAccount>(
      `SELECT * FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }


    acc = lockResult.rows[0]!
    const currentBalance = new Decimal(acc.current_balance!)
    let maxDrawdownPct = new Decimal(acc.max_drawdown_pct || 0)
    let drawdownLocksAtPct = null
    if (acc.account_type === 'funded' && acc.challenge_model_slug) {
      const model = await fetchStepModelBySlug(acc.challenge_model_slug)
      if (model) {
        maxDrawdownPct = new Decimal(model.funded_max_drawdown_pct)
        drawdownLocksAtPct = model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
      }
    }
    let realisedDrawdownPct = new Decimal(0)
    if (!skipDrawdownCheck) {
      if (maxDrawdownPct.lte(0)) {
        await client.query('ROLLBACK')
        return
      }
      const floor = await drawdownService.getEffectiveDrawdownFloor(client, acc, {
        equity: currentBalance.toNumber(),
        maxDrawdownPct: maxDrawdownPct.toNumber(),
        drawdownLocksAtPct
      })
      if (currentBalance.gte(floor)) {
        await client.query('ROLLBACK')
        return
      }
      realisedDrawdownPct = new Decimal(acc.starting_balance!).minus(currentBalance).div(acc.starting_balance!).times(100)
    }

    const openTrades = await client.query<TradeRow>(
      `SELECT * FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )

    // FIX (AUDIT): Use Decimal accumulator — native float += on many trades
    // causes sub-penny rounding drift in the final balance update.
    let totalPnlDec = new Decimal(0)

    for (const trade of openTrades.rows) {
      try {
        const priceData = priceMap[trade.instrument]
        if (!priceData) {
          await client.query(
            `UPDATE trades SET
               status = 'closed',
               close_price = open_price,
               close_time = NOW(),
               demo_pnl = 0,
               close_reason = $2
             WHERE id = $1`,
            [trade.id, closeReason]
          )
          continue
        }

        const close_price = trade.direction === 'buy'
          ? parseFloat(String(priceData.bid))
          : parseFloat(String(priceData.ask))

        const demo_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(String(trade.commission || 0))
        )

        totalPnlDec = totalPnlDec.plus(demo_pnl)

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
      } catch (tradeErr: unknown) {
        logger.error(`failAccount: failed to close trade ${trade.id}:`, { error: errorMessage(tradeErr) })
        throw new Error(`Failed to close trade ${trade.id} while failing account`)
      }
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()
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
         close_reason = $2
       WHERE account_id = $1 AND status = 'pending'`,
      [acc.id, closeReason]
    )

    await client.query(`UPDATE accounts SET status = 'failed' WHERE id = $1`, [acc.id])

    await incrementBbookMetric(client, 'accounts_failed')

    await client.query('COMMIT')

    await safeRecordViolation({
      violationType,
      severity: 'critical',
      accountId: acc.id,
      userId: acc.user_id,
      source: 'challenge_engine',
      message: reason,
      payload: {
        account_type: acc.account_type,
        realised_drawdown_pct: parseFloat(realisedDrawdownPct.toFixed(2)),
        max_drawdown_pct: parseFloat(maxDrawdownPct.toFixed(2)),
        auto_status: 'failed',
        ...extraPayload
      }
    })

    await safeRecordEnforcement({
      accountId: acc.id,
      userId: acc.user_id,
      action: enforcementAction,
      status: 'applied',
      message: `Account failed automatically: ${reason}`,
      payload: {
        account_type: acc.account_type,
        realised_drawdown_pct: parseFloat(realisedDrawdownPct.toFixed(2)),
        max_drawdown_pct: parseFloat(maxDrawdownPct.toFixed(2)),
        ...extraPayload
      }
    })

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event:      socketEvent,
        account_id: acc.id,
        message:    `❌ Account FAILED — ${reason}. All trades have been closed.`
      })
    }

    try {
      const userResult = await pool.query<UserEmailRow>('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]!
        enqueueAccountFailedEmail(email, full_name, acc.account_type, reason, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
      }
    } catch (emailErr: unknown) {
      logger.error('[mail] failAccount email lookup failed:', { error: errorMessage(emailErr) })
    }

    logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}. ${openTrades.rows.length} trade(s) force-closed.`)
  } catch (err: unknown) {
    await client.query('ROLLBACK')
    logger.error(`failAccount error for ${acc.id}:`, { error: errorMessage(err) })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// passAccount — marks account passed and creates next phase account.
// Uses FOR UPDATE SKIP LOCKED to prevent double-processing.
// ─────────────────────────────────────────────────────────────────────────────
async function passAccount(
  acc: EngineAccount,
  _platformSettings: PlatformSettings,
  io: TypedServer | null
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query<EngineAccount>(
      `SELECT * FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [acc.id]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    acc = lockResult.rows[0]!

    const startingBalance = new Decimal(acc.starting_balance!)
    let profitTarget = new Decimal(acc.profit_target || 0)
    if (profitTarget.lte(0)) {
      profitTarget = startingBalance.times(0.10)
    }
    const realisedProfit = new Decimal(acc.current_balance!).minus(startingBalance)
    if (realisedProfit.lt(profitTarget)) {
      await client.query('ROLLBACK')
      return
    }

    const openTradesResult = await client.query<CountRow>(
      `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    if (parseInt(openTradesResult.rows[0]!.count) > 0) {
      await client.query('ROLLBACK')
      return
    }

    await client.query(
      `UPDATE accounts SET status = 'passed' WHERE id = $1`,
      [acc.id]
    )

    // The next account is NOT created here any more. Passing a challenge now
    // raises a pending promotion review, and an admin approving it in
    // /admin/promotion-reviews is what creates the phase2/phase3/funded
    // account. The review row records the resolved target up front, so the
    // admin approves exactly what will be created.
    const review = await createPendingPromotionReview(client, acc, {
      triggeredBy: 'auto_pass',
      reason: 'Profit target reached',
      payload: { source: 'challengeEngine', account_type: acc.account_type, account_size: acc.account_size }
    })
    if (!review) {
      throw new Error('Failed to raise promotion review for passed account')
    }

    await client.query('COMMIT')

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event:          'promotion_pending_review',
        account_id:     acc.id,
        review_id:      review.id,
        target_account_type: review.target_account_type,
        message:        `Your ${acc.account_type} challenge passed! Your next account is awaiting admin approval.`
      })
    }

    logger.info(
      `Challenge engine: account ${acc.id} PASSED (${acc.account_type}) — ` +
      `promotion review #${review.id} raised for ${review.target_account_type}`
    )

    try {
      const userResult = await pool.query<UserEmailRow>('SELECT email, full_name FROM users WHERE id = $1', [acc.user_id])
      if (userResult.rows.length > 0) {
        const { email, full_name } = userResult.rows[0]!
        enqueuePhasePassedEmail(email, full_name, acc.account_type, acc.account_size, {
          userId: acc.user_id
        }).catch(() => {})
      }
    } catch (emailErr: unknown) {
      logger.error('[mail] passAccount email lookup failed:', { error: errorMessage(emailErr) })
    }
  } catch (err: unknown) {
    await client.query('ROLLBACK')
    logger.error(`passAccount error for ${acc.id}:`, { error: errorMessage(err) })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateScalingPlan — funded accounts only. Every `scaling_target_pct` net
// TRADING profit milestone: (a) raises the account's risk-capacity multiplier
// (scaling_multiplier ^ milestonesEarned, capped so starting_balance *
// multiplier never exceeds `scaling_max_account_size` — enforced as a lot-size
// cap in routes/trades.js's accountSizeK calc), AND (b) injects real capital
// into current_balance: `scaling_increase_per_milestone_pct`% of the account's
// ORIGINAL starting_balance per milestone, via the ledger-backed
// applyBalanceAdjustment() (utils/balanceAdjustments.js) — never a raw UPDATE.
//
// Milestone detection deliberately excludes this function's own past
// injections: it reads prior 'scaling_capital_increase' balance_adjustments
// back out of current_balance before computing net trading profit. Without
// this, an injection would itself read as "trading profit" on the very next
// tick and trigger another injection — a runaway cascade. This mirrors the
// invariant documented on the balance_adjustments migration: current_balance
// = starting_balance + trading P&L + SUM(balance_adjustments.amount).
//
// starting_balance itself is never touched — the trailing drawdown floor
// (services/drawdownService.js) is based on eod_peak_equity, not
// starting_balance, so it self-recalibrates to the new (higher) balance on
// the next tick once eod_peak_equity catches up; there's no fixed-floor/
// growing-balance mismatch to worry about.
// ─────────────────────────────────────────────────────────────────────────────
async function evaluateScalingPlan(acc: EngineAccount, io: TypedServer | null): Promise<void> {
  if (!acc.challenge_model_slug) return
  const model = await fetchStepModelBySlug(acc.challenge_model_slug)
  if (!model || !model.scaling_enabled) return

  const milestonePct = parseFloat(model.scaling_target_pct)
  const doublingFactor = parseFloat(String(model.scaling_multiplier || 1))
  const maxAccountSize = parseFloat(String(model.scaling_max_account_size || 0))
  const increasePerMilestonePct = parseFloat(String(model.scaling_increase_per_milestone_pct || 0))
  if (!(milestonePct > 0) || !(doublingFactor > 1)) return

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // Lock the row for the whole evaluation — a concurrent tick for the same
    // account (unlikely but possible under scheduler overlap) must not read
    // a stale scaling_milestones_claimed and double-grant a milestone.
    const lockedResult = await client.query<ScalingAccountRow>(
      `SELECT id, user_id, starting_balance, current_balance, scaling_milestones_claimed
         FROM accounts WHERE id = $1 FOR UPDATE`,
      [acc.id]
    )
    const locked = lockedResult.rows[0]
    if (!locked) { await client.query('ROLLBACK'); return }

    const startingBalance = parseFloat(locked.starting_balance)
    if (!(startingBalance > 0)) { await client.query('ROLLBACK'); return }

    // Subtract EVERY balance adjustment, not just this function's own past
    // injections. Rearranging the invariant documented on the
    // balance_adjustments migration:
    //
    //   current_balance = starting_balance + trading P&L + SUM(adjustments)
    //   ⇒ trading P&L  = current_balance - starting_balance - SUM(adjustments)
    //
    // so summing the whole ledger is what actually isolates trading profit.
    //
    // Filtering on source = 'scaling_capital_increase' was a live bug: admin
    // balance adjustments landed in the separate admin_balance_adjustments
    // table and so were invisible here, which meant a goodwill credit read as
    // trading profit and could mint a real scaling milestone. Admin
    // adjustments now write the canonical ledger too (routes/admin/accounts.js),
    // and this sum picks them up.
    const injectedResult = await client.query<TotalRow>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM balance_adjustments
        WHERE account_id = $1`,
      [acc.id]
    )
    const cumulativeInjected = parseFloat(String(injectedResult.rows[0]!.total || 0))
    const currentBalance = parseFloat(locked.current_balance)
    const netTradingProfit = currentBalance - startingBalance - cumulativeInjected
    const netProfitPct = (netTradingProfit / startingBalance) * 100
    if (netProfitPct <= 0) { await client.query('ROLLBACK'); return }

    const milestonesEarned = Math.floor(netProfitPct / milestonePct)
    const prevMilestones = parseInt(String(locked.scaling_milestones_claimed || 0), 10)
    if (milestonesEarned <= prevMilestones) { await client.query('ROLLBACK'); return }

    const rawMultiplier = Math.pow(doublingFactor, milestonesEarned)
    const capMultiplier = maxAccountSize > 0 ? (maxAccountSize / startingBalance) : rawMultiplier
    const nextMultiplier = Math.min(rawMultiplier, capMultiplier)

    // Real capital injection — one balance_adjustments row per newly earned
    // milestone, stopping early (not partial-filling) once a full milestone's
    // worth of headroom under scaling_max_account_size runs out. The
    // multiplier above is capped independently and keeps advancing even if
    // capital headroom is exhausted.
    let totalInjected = new Decimal(0)
    let latestBalance = new Decimal(currentBalance)
    if (increasePerMilestonePct > 0) {
      const perMilestoneAmount = new Decimal(startingBalance).times(increasePerMilestonePct).div(100)
      for (let milestone = prevMilestones + 1; milestone <= milestonesEarned; milestone++) {
        if (maxAccountSize > 0 && latestBalance.plus(perMilestoneAmount).greaterThan(maxAccountSize)) break
        const adjustment = await applyBalanceAdjustment(client, {
          accountId: acc.id,
          amount: perMilestoneAmount.toNumber(),
          source: 'scaling_capital_increase',
          reason: `Scaling milestone ${milestone} reached (${milestonePct}% net trading profit increments)`,
          createdBy: 'system',
          metadata: { milestone, model_slug: acc.challenge_model_slug }
        })
        latestBalance = new Decimal(adjustment.balanceAfter)
        totalInjected = totalInjected.plus(perMilestoneAmount)
      }
    }

    const result = await client.query<ScalingMultiplierRow>(
      `UPDATE accounts
          SET scaling_multiplier = $2, scaling_milestones_claimed = $3
        WHERE id = $1 AND scaling_milestones_claimed < $3
        RETURNING scaling_multiplier`,
      [acc.id, nextMultiplier, milestonesEarned]
    )
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return }

    await client.query('COMMIT')

    const injectedThisTick = totalInjected.greaterThan(0)
    logger.info(`Challenge engine: account ${acc.id} scaling upgraded to ${nextMultiplier}x (milestone ${milestonesEarned})${injectedThisTick ? `, capital +$${totalInjected.toFixed(2)}` : ''}`)

    if (io) {
      io.to(String(acc.user_id)).emit('account_update', {
        event: 'scaling_upgrade',
        account_id: acc.id,
        message: injectedThisTick
          ? `🚀 Scaling milestone reached! Your account balance increased by $${totalInjected.toFixed(2)} and risk allocation increased to ${nextMultiplier.toFixed(2)}x.`
          : `🚀 Scaling milestone reached! Your risk allocation just increased to ${nextMultiplier.toFixed(2)}x.`
      })
    }

    if (injectedThisTick) {
      try {
        await createUserNotification(io, locked.user_id, {
          type: 'success',
          title: 'Capital increase!',
          message: `Your account balance increased by $${totalInjected.toFixed(2)} for reaching a scaling milestone. New balance: $${latestBalance.toFixed(2)}.`
        })
      } catch (notifyErr: unknown) {
        logger.warn(`Challenge engine: failed to create scaling notification for account ${acc.id}:`, { error: errorMessage(notifyErr) })
      }
    }
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error(`evaluateScalingPlan error for account ${acc.id}:`, { error: errorMessage(err) })
  } finally {
    client.release()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// processAccount — handles drawdown checks, expiry, and profit target.
// Funded accounts use funded_max_drawdown_pct from platform settings.
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: For financial calculations, use Decimal to avoid floating point errors:
//   const pnl = new Decimal(priceDiff).times(lots).times(contractSize)
//   const balance = new Decimal(oldBalance).plus(pnl)
// Always convert back with .toNumber() or .toFixed(2) for storage

async function processAccount(
  acc: EngineAccount,
  platformSettings: PlatformSettings,
  io: TypedServer | null
): Promise<void> {
  const now = new Date()

  // Only phase1/phase2 have time limits — funded accounts have no expiry
  if (acc.account_type !== 'funded' && acc.phase_end_date && new Date(acc.phase_end_date) <= now) {
    logger.info(`Challenge engine: account ${acc.id} has expired (phase_end_date: ${acc.phase_end_date})`)
    await expireAccount(acc, io)
    return
  }

  if (
    acc.account_type !== 'funded' &&
    platformSettings.inactivity_auto_fail_enabled &&
    platformSettings.inactivity_fail_days > 0
  ) {
    const fallbackDate = acc.phase_start_date || acc.created_at || now
    const lastActivityAt = await getLastTradeActivityAt(acc.id, fallbackDate)
    if (lastActivityAt) {
      const inactiveForMs = now.getTime() - new Date(lastActivityAt).getTime()
      const inactivityLimitMs = platformSettings.inactivity_fail_days * 24 * 60 * 60 * 1000
      if (inactiveForMs >= inactivityLimitMs) {
        const reason = `no trade activity for ${platformSettings.inactivity_fail_days} days`
        logger.info(`Challenge engine: account ${acc.id} FAILED â€” ${reason}`)
        await failAccount(acc, reason, io, platformSettings, {
          skipDrawdownCheck: true,
          closeReason: 'Inactivity Auto-Fail',
          violationType: 'inactivity_auto_fail',
          enforcementAction: 'auto_fail_inactive_account',
          payload: {
            inactivity_fail_days: platformSettings.inactivity_fail_days,
            last_activity_at: new Date(lastActivityAt).toISOString()
          }
        })
        return
      }
    }
  }

  const current_balance  = new Decimal(acc.current_balance!)
  const starting_balance = new Decimal(acc.starting_balance!)

  let max_drawdown_pct = new Decimal(acc.account_type === 'funded'
    ? platformSettings.funded_max_drawdown_pct
    : acc.max_drawdown_pct!)
  let daily_drawdown_pct = acc.daily_drawdown_pct != null ? parseFloat(String(acc.daily_drawdown_pct)) : null
  let drawdownLocksAtPct = null
  if (acc.account_type === 'funded' && acc.challenge_model_slug) {
    const model = await fetchStepModelBySlug(acc.challenge_model_slug)
    if (model) {
      max_drawdown_pct = new Decimal(model.funded_max_drawdown_pct)
      daily_drawdown_pct = parseFloat(model.funded_daily_drawdown_pct)
      drawdownLocksAtPct = model.funded_drawdown_locks_at_pct != null ? parseFloat(model.funded_drawdown_locks_at_pct) : null
    }
  }

  const drawdownBase = starting_balance

  if (drawdownBase.gt(0)) {
    const realised_drawdown_pct = drawdownBase.minus(current_balance).div(drawdownBase).times(100)

    if (io && realised_drawdown_pct.gt(0)) {
      const pctOfLimit = realised_drawdown_pct.div(max_drawdown_pct).times(100).toNumber()
      let warningLevel = null

      // More granular warning levels: 25%, 50%, 75%, 90%
      if (pctOfLimit >= 90 && pctOfLimit < 100) warningLevel = 90
      else if (pctOfLimit >= 75 && pctOfLimit < 90) warningLevel = 75
      else if (pctOfLimit >= 50 && pctOfLimit < 75) warningLevel = 50
      else if (pctOfLimit >= 25 && pctOfLimit < 50) warningLevel = 25

      // FIX (AUDIT): Only emit when warningLevel changes — prevents flooding
      // the client with thousands of identical events per hour.
      const prevLevel = _lastDrawdownWarningLevel.get(String(acc.id))
      if (warningLevel && warningLevel !== prevLevel) {
        _lastDrawdownWarningLevel.set(String(acc.id), warningLevel)
        io.to(String(acc.user_id)).emit('drawdown_warning', {
          account_id:            acc.id,
          warning_level:         warningLevel,
          realised_drawdown_pct: parseFloat(realised_drawdown_pct.toFixed(2)),
          max_drawdown_pct: max_drawdown_pct.toNumber(),
          message: warningLevel === 90
            ? `🚨 CRITICAL: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Account will fail if drawdown reaches ${max_drawdown_pct.toFixed(2)}%.`
            : warningLevel === 75
            ? `⚠️ WARNING: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Reduce your exposure.`
            : warningLevel === 50
            ? `📊 NOTICE: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Consider reducing position sizes.`
            : `ℹ️  INFO: You have used ${realised_drawdown_pct.toFixed(2)}% of your ${max_drawdown_pct.toFixed(2)}% drawdown limit (${warningLevel}% used). Monitor your positions.`
        })
      }
    }

    const floor = await drawdownService.getEffectiveDrawdownFloor(pool, acc, {
      equity: current_balance.toNumber(),
      maxDrawdownPct: max_drawdown_pct.toNumber(),
      drawdownLocksAtPct
    })
    // FIX (F-15): boundary semantics. This was `lt(floor)` while the daily-loss
    // check below used `gte(limit)` — so on the same pass, over the same
    // account, a trader exactly ON the daily limit was failed and a trader
    // exactly ON the drawdown floor survived. Neither convention is wrong on
    // its own; disagreeing is indefensible in a dispute, and neither was
    // documented. Both are now inclusive: reaching the limit is a breach.
    if (current_balance.lte(floor)) {
      const reason = `trailing drawdown breach — balance $${current_balance.toFixed(2)} fell below the $${floor.toFixed(2)} floor`
      logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}`)
      await failAccount(acc, reason, io, platformSettings)
      return
    }
  }

  if (daily_drawdown_pct != null && daily_drawdown_pct > 0 && starting_balance.gt(0)) {
    const todayRealizedMap = await tradingDaysService.getTodayRealizedPnl(pool, [acc.id])
    const todayRealized = new Decimal(todayRealizedMap.get(acc.id) || 0)
    if (todayRealized.isNegative()) {
      const todayLossPct = todayRealized.abs().div(starting_balance).times(100)
      if (todayLossPct.gte(daily_drawdown_pct)) {
        const reason = `daily loss limit breach — today's loss ${todayLossPct.toFixed(2)}% reached the ${daily_drawdown_pct}% daily limit`
        logger.info(`Challenge engine: account ${acc.id} FAILED — ${reason}`)
        await failAccount(acc, reason, io, platformSettings, {
          closeReason: 'Daily Loss Limit Breach',
          violationType: 'daily_loss_limit_breach',
          enforcementAction: 'auto_fail_daily_loss_limit'
        })
        return
      }
    }
  }

  // Funded accounts have no profit target to pass — only drawdown/daily-loss to fail on,
  // plus the scaling plan (risk-capacity increases on profit milestones).
  if (acc.account_type === 'funded') {
    await evaluateScalingPlan(acc, io)
    return
  }

  let profit_target = new Decimal(acc.profit_target || 0)
  if (profit_target.lte(0)) {
    profit_target = starting_balance.times(0.10)
  }

  const realised_profit = current_balance.minus(starting_balance)
  if (realised_profit.gte(profit_target)) {
    const openTradesResult = await pool.query<CountRow>(
      `SELECT COUNT(*) FROM trades WHERE account_id = $1 AND status = 'open'`,
      [acc.id]
    )
    const openCount = parseInt(openTradesResult.rows[0]!.count)
    if (openCount > 0) return

    const minTradingDays = acc.min_trading_days != null ? parseInt(String(acc.min_trading_days), 10) : 0
    if (minTradingDays > 0) {
      const tradingDays = await tradingDaysService.countQualifyingTradingDays(
        pool, acc.id, acc.starting_balance!, acc.min_daily_profit_pct!
      )
      if (tradingDays < minTradingDays) {
        // Explain the hold. This used to be a bare `return`, so a trader who hit
        // 16% on day three saw their target met and then nothing at all — no
        // counter, no message, no reason. It was the single most common support
        // ticket the examination predicted, and the rule is not even the one a
        // trader would guess: a qualifying day is not a day you traded, it is a
        // day you FINISHED UP at least min_daily_profit_pct of starting balance.
        //
        // Level-cached on the remaining count rather than a boolean, so the
        // trader gets a fresh message as the number comes down and nothing at
        // all on the passes in between.
        const remaining = minTradingDays - tradingDays
        const prevRemaining = _lastTradingDaysHoldLevel.get(String(acc.id))
        if (io && prevRemaining !== remaining) {
          _lastTradingDaysHoldLevel.set(String(acc.id), remaining)
          const minDailyPct = acc.min_daily_profit_pct != null ? parseFloat(String(acc.min_daily_profit_pct)) : 0
          io.to(String(acc.user_id)).emit('account_update', {
            event: 'trading_days_hold',
            account_id: acc.id,
            message: `🎯 Target reached — ${remaining} more qualifying day${remaining === 1 ? '' : 's'} to go. ` +
              `You're on ${tradingDays} of ${minTradingDays}; a day counts once you finish it up at least ${minDailyPct}% of your starting balance. ` +
              `You'll pass automatically when the last one lands.`
          })
        }
        return // profit target met, but hasn't traded enough qualifying days yet
      }
      _lastTradingDaysHoldLevel.delete(String(acc.id))
    }

    const consistencyPct = acc.consistency_max_day_pct != null ? parseFloat(String(acc.consistency_max_day_pct)) : null
    if (consistencyPct != null && consistencyPct > 0) {
      const consistency = await tradingDaysService.checkConsistencyRule(pool, acc.id, realised_profit.toNumber(), consistencyPct)
      if (!consistency.ok) {
        const prevLevel = _lastConsistencyWarningLevel.get(String(acc.id))
        if (io && prevLevel !== true) {
          _lastConsistencyWarningLevel.set(String(acc.id), true)
          io.to(String(acc.user_id)).emit('account_update', {
            event: 'consistency_rule_hold',
            account_id: acc.id,
            message: `📊 Almost there — your best single day is ${consistency.bestDayPct.toFixed(1)}% of total profit, which exceeds this model's ${consistencyPct}% consistency limit. Keep trading to bring that ratio down and you'll pass automatically.`
          })
        }
        return // profit target met, but concentrated in too few days — soft hold, not a fail
      }
      _lastConsistencyWarningLevel.delete(String(acc.id))
    }

    logger.info(`Challenge engine: account ${acc.id} hit profit target (${realised_profit.toFixed(2)}) — passing`)
    await passAccount(acc, platformSettings, io)
  }
}

async function runChallengeEngine(io: TypedServer | null): Promise<void> {
  try {
    // Feed circuit breaker — see services/feedHealth.js. This engine fails
    // accounts on drawdown and daily-loss too, so it must suspend on the same
    // signal and at the same threshold as the tick engine and the trading
    // routes. Skipping a pass is safe: the next one re-evaluates from scratch.
    const feedHealth = await checkFeedHealthWithAlerting()
    if (!feedHealth.healthy) return

    const activeAccounts = await pool.query<EngineAccount>(
      `SELECT * FROM accounts
       WHERE status = 'active'
       AND account_type IN ('phase1', 'phase2', 'phase3', 'funded')`
    )

    if (activeAccounts.rows.length === 0) return

    const [progressionSettings, automationSettings] = await Promise.all([
      fetchProgressionSettings(pool),
      fetchChallengeAutomationSettings()
    ])
    const platformSettings: PlatformSettings = { ...progressionSettings, ...automationSettings }

    // ── Bounded-concurrency sweep ─────────────────────────────────────────────
    //
    // This was a plain serial `for … await processAccount()`, and each iteration
    // issues several queries. At the 30s cadence that stops finishing a pass
    // somewhere around 1,500 active accounts — and a pass that does not finish
    // is a pass that does not fail breached accounts or pass qualified ones.
    //
    // Concurrency rather than a rewrite: processAccount already does its own
    // locking (FOR UPDATE SKIP LOCKED on the account it touches), so running N
    // of them at once is safe in exactly the way running two engine instances
    // is. The bound is what keeps it safe operationally — unbounded Promise.all
    // over 5,000 accounts would open 5,000 connections against a 60-connection
    // pool and turn a slow pass into a stalled one.
    //
    // ENGINE_SWEEP_CONCURRENCY is deliberately well under the pool size: the
    // trading hot path shares this pool and must not queue behind a sweep.
    //
    // Per-account errors stay per-account. One bad row must never abort the
    // sweep, which is why each worker catches rather than the batch.
    const workerCount = Math.min(ENGINE_SWEEP_CONCURRENCY, activeAccounts.rows.length)
    let cursor = 0
    const runWorker = async () => {
      for (;;) {
        const index = cursor++
        if (index >= activeAccounts.rows.length) return
        const acc = activeAccounts.rows[index]!
        try {
          await processAccount(acc, platformSettings, io)
        } catch (accErr: unknown) {
          logger.error(`Challenge engine error for account ${acc.id}:`, { error: errorMessage(accErr) })
        }
      }
    }
    await Promise.all(Array.from({ length: workerCount }, runWorker))

    // FIX (BUG-6): detectRapidOpposingTrades must run BEFORE detectOpposingTrades.
    // detectOpposingTrades sets matching accounts to status='locked'. The rapid
    // check queries WHERE status='active' — running it afterwards always found 0
    // results because the accounts were already locked. Swapping the order ensures
    // both functions operate on still-active accounts.

    // ── Rapid opposing trade detection (must run first — needs active accounts) ─
    try {
      await detectRapidOpposingTradesGlobal()
    } catch (rapidErr: unknown) {
      logger.error('[rapid_opposing] Detection error:', { error: errorMessage(rapidErr) })
    }

    // ── Cross-account opposing trade detection (locks accounts) ────────────────
    try {
      await detectOpposingTrades(io)
    } catch (oppErr: unknown) {
      logger.error('[opposing_trades] Detection error:', { error: errorMessage(oppErr) })
    }

    // ── IP-based multi-account detection ───────────────────────────────────────
    // Removed. detectIPMultiAccounts() auto-flagged every account belonging to
    // any two users who shared an exact IP within 24h — no subnet awareness, no
    // scoring, and a guaranteed false positive for households, shared offices
    // and mobile CGNAT. Superseded by services/accountLinkingService.js, which
    // reads the same data plus device/payout/KYC/simultaneity signals, weights
    // each by how rare the shared value is, and produces a scored review queue
    // instead of an automatic flag. Scheduled separately as jobs:account_linking.

  } catch (error: unknown) {
    logger.error('runChallengeEngine error:', { error: errorMessage(error) })
  }
}

// ── Cross-account opposing trade detector ──────────────────────────────────────
// FIX (LOOPHOLE 3): Now auto-locks flagged accounts instead of just flagging.

// Detect rapid open/close opposing trades (gaming the system)
async function detectRapidOpposingTrades(
  userId: string,
  instrument: string,
  accountIds: string[],
  _io: TypedServer | null
): Promise<void> {
  try {
    // FIX (BUG-H5): Corrected three wrong column names:
    //  1. `t.user_id`     → `a.user_id`  (user_id is on accounts, not trades)
    //  2. `t.closed_at`   → `t.close_time` (actual column name in trades table)
    //  3. `buy.opened_at` / `sell.opened_at` → `buy.open_time` / `sell.open_time`
    const recentTrades = await pool.query<RapidTradeRow>(`
      SELECT t.*, a.user_id, a.id as acc_id
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE a.user_id = $1
        AND t.instrument = $2
        AND t.status = 'closed'
        AND t.close_time > NOW() - INTERVAL '24 hours'
      ORDER BY t.close_time DESC
      LIMIT 50
    `, [userId, instrument])

    if (recentTrades.rows.length < 4) return // Need enough trades to analyze

    // Check for opposing directions in recent trades
    const hasBuy = recentTrades.rows.some(t => t.direction === 'buy')
    const hasSell = recentTrades.rows.some(t => t.direction === 'sell')
    
    if (hasBuy && hasSell) {
      // Calculate time between opposing trades using correct column name
      const buys = recentTrades.rows.filter(t => t.direction === 'buy')
      const sells = recentTrades.rows.filter(t => t.direction === 'sell')
      
      let rapidCount = 0
      for (const buy of buys) {
        for (const sell of sells) {
          const timeDiff = Math.abs(new Date(buy.open_time).getTime() - new Date(sell.open_time).getTime())
          if (timeDiff < 5 * 60 * 1000) { // Within 5 minutes
            rapidCount++
          }
        }
      }
      
      if (rapidCount >= 2) {
        logger.warn(`[rapid_opposing] User ${userId}: ${rapidCount} rapid opposing trades on ${instrument}`)
        const reason = `Rapid opposing trades detected on ${instrument}`
        for (const accountId of accountIds) {
          await safeRecordViolation({
            violationType: 'rapid_opposing_trades',
            severity: 'high',
            accountId,
            userId,
            instrument,
            source: 'challenge_engine',
            message: `${reason} (${rapidCount} rapid matches in 24h)`,
            payload: { rapid_count: rapidCount }
          })

          try {
            await applyAccountEnforcement({
              accountId,
              action: 'flag_for_review',
              reason,
              payload: { instrument, rapid_count: rapidCount }
            })
          } catch (silentErr: unknown) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: errorMessage(silentErr) }) }
        }
      }
    }
  } catch (err: unknown) {
    logger.error('[rapid_opposing] Detection error:', { error: errorMessage(err) })
  }
}

// FIX (BUG-6): Global entry point for rapid opposing trade detection.
// Scans all active users who have recent closed trades in both directions
// on the same instrument, then delegates to the per-user checker.
// Must be called BEFORE detectOpposingTrades so accounts are still 'active'.
async function detectRapidOpposingTradesGlobal(): Promise<void> {
  try {
    const result = await pool.query<RapidGroupRow>(`
      SELECT a.user_id, t.instrument,
             array_agg(DISTINCT a.id) AS account_ids
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE t.status = 'closed'
        AND t.close_time > NOW() - INTERVAL '24 hours'
        AND a.status = 'active'
      GROUP BY a.user_id, t.instrument
      HAVING
        COUNT(t.id) FILTER (WHERE t.direction = 'buy')  > 0
        AND COUNT(t.id) FILTER (WHERE t.direction = 'sell') > 0
    `)
    for (const row of result.rows) {
      await detectRapidOpposingTrades(row.user_id, row.instrument, row.account_ids, null)
    }
  } catch (err: unknown) {
    logger.error('[rapid_opposing_global] Scan error:', { error: errorMessage(err) })
  }
}

async function detectOpposingTrades(io: TypedServer | null): Promise<void> {
  if (!reviewFlagColumnsReady) {
    try {
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)
      reviewFlagColumnsReady = true
    } catch (_) {
      return
    }
  }

  const result = await pool.query<OpposingGroupRow>(`
    SELECT
      a.user_id,
      t.instrument,
      COUNT(DISTINCT t.account_id)                                          AS account_count,
      COUNT(t.id) FILTER (WHERE t.direction = 'buy')                       AS buy_count,
      COUNT(t.id) FILTER (WHERE t.direction = 'sell')                      AS sell_count,
      array_agg(DISTINCT a.id)                                             AS account_ids,
      SUM(t.lot_size) FILTER (WHERE t.direction = 'buy')                   AS total_buy_lots,
      SUM(t.lot_size) FILTER (WHERE t.direction = 'sell')                  AS total_sell_lots
    FROM trades t
    JOIN accounts a ON t.account_id = a.id
    WHERE t.status = 'open'
      AND a.status = 'active'
    GROUP BY a.user_id, t.instrument
    HAVING
      COUNT(DISTINCT t.account_id) > 1
      AND COUNT(t.id) FILTER (WHERE t.direction = 'buy') > 0
      AND COUNT(t.id) FILTER (WHERE t.direction = 'sell') > 0
  `)

  if (result.rows.length === 0) return

  for (const row of result.rows) {
    const { user_id, instrument, account_ids } = row

    let alreadyFlagged = false
    try {
      const existing = await pool.query<IdRow>(
        `SELECT id FROM accounts
         WHERE id = ANY($1::uuid[])
           AND review_flagged = true
           AND review_flag_reason ILIKE '%opposing%'`,
        [account_ids]
      )
      alreadyFlagged = existing.rows.length > 0
    } catch (silentErr: unknown) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: errorMessage(silentErr) }) }

    if (alreadyFlagged) continue

    const flagReason = `Cross-account opposing trade detected on ${instrument} — BUY and SELL open simultaneously across ${account_ids.length} accounts`
    for (const accountId of account_ids) {
      await safeRecordViolation({
        violationType: 'cross_account_opposing_trades',
        severity: 'critical',
        accountId,
        userId: user_id,
        instrument,
        source: 'challenge_engine',
        message: flagReason,
        payload: {
          account_ids,
          buy_lots: parseFloat(String(row.total_buy_lots || 0)),
          sell_lots: parseFloat(String(row.total_sell_lots || 0))
        }
      })

      try {
        await applyAccountEnforcement({
          accountId,
          action: 'lock_account',
          reason: flagReason,
          payload: {
            instrument,
            account_ids,
            buy_lots: parseFloat(String(row.total_buy_lots || 0)),
            sell_lots: parseFloat(String(row.total_sell_lots || 0))
          }
        })
      } catch (silentErr: unknown) { logger.warn("[challenge_engine] Non-critical operation failed silently:", { error: errorMessage(silentErr) }) }
    }

    logger.warn(
      `[opposing_trades] User ${user_id} AUTO-LOCKED: ${instrument} opposing across accounts ${account_ids.join(', ')}`
    )

    // Also check for rapid open/close opposing trades (gaming detection)
    // This catches users who open and close opposing trades quickly to manipulate stats
    await detectRapidOpposingTrades(user_id, instrument, account_ids, io)

    if (io) {
      io.to('admin').emit('opposing_trade_detected', {
        user_id, instrument,
        account_ids,
        buy_lots:  parseFloat(String(row.total_buy_lots  || 0)),
        sell_lots: parseFloat(String(row.total_sell_lots || 0)),
        action: 'auto_locked',
        detected_at: new Date().toISOString()
      })

      io.to(String(user_id)).emit('account_update', {
        event: 'account_locked',
        account_ids,
        message: `⚠️ Your accounts have been locked for review due to opposing trades detected on ${instrument}. Please contact support.`
      })
    }
  }
}

const challengeEngine = { runChallengeEngine }

export = challengeEngine
