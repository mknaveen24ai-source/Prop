// POST /api/trades/open — market and pending order entry.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.
//
// Kept whole at ~580 lines: it is a single transaction from validation
// through insert, and splitting it across files would obscure that.

import type {
  JsonValue,
  OpenTradeErrorResponseDto,
  OpenTradeResponseDto,
  TradeMutationRecordDto
} from '@propfirm/contracts'
import Decimal from 'decimal.js'
import express from 'express'
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  Router
} from 'express'
import type { PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'
import pool = require('../../db')
import logger = require('../../utils/logger')
import newsService = require('../../services/newsService')
import type { PendingIndexRow, TradeIndexRow } from '../../utils/tradeIndex'
import { getCurrentPricesForTenant } from '../../priceFeed'
import {
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  CONTRACT_SIZES,
  getPipSize,
  roundPrice
} from '../../constants'
import {
  abandonIdempotentRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  getIdempotencyKey
} from '../../utils/idempotency'
import { calculatePnL } from '../../utils/pnlCalculator'
import { getRequestIp } from '../../utils/requestIp'
import { tradingLimiter } from '../../utils/security'
import { resolveTieredInstrumentSetting } from '../../utils/tenantSettings'
import { isValidLotSize, sanitizeString } from '../../utils/validation'
import { serializeDecimal } from '../../utils/money'
import tradeShared = require('../../services/tradeShared')
import tradeRouteShared = require('./shared')
import { authenticateToken } from '../middleware'

type OpenResponse = OpenTradeResponseDto | OpenTradeErrorResponseDto | JsonValue
type OpenRequest = ExpressRequest<Record<string, never>, OpenResponse, unknown>
type NumericInput = string | number | null | undefined
type LivePrice = Awaited<ReturnType<typeof tradeShared.getLivePrice>>

interface NewsEvent {
  title: string
}

interface NewsServiceApi {
  getActiveNewsEvent: (minutes: number) => NewsEvent | null
}

interface UuidApi {
  v4: () => string
}

interface PendingOrderValidationApi {
  validatePendingOrderPrice: (
    orderType: string,
    pendingPrice: number,
    bid: number,
    ask: number
  ) => string | null
}

interface StepModel {
  no_hedging?: boolean
  no_grid_trading?: boolean
  no_martingale?: boolean
}

interface StepModelsApi {
  fetchStepModelBySlug: (slug: string) => Promise<StepModel | null>
}

interface IdentitySignalsApi {
  recordRequestSignals: (
    userId: string,
    input: {
      ip: string | null
      deviceSignature: ExpressRequest['deviceSignature']
      context: string
    }
  ) => Promise<unknown>
}

interface TradeIndexSyncApi {
  publish: (type: unknown, payload: unknown) => Promise<boolean>
}

interface OpenEngineApi {
  syncPendingOrder: (trade: PendingIndexRow) => Promise<unknown>
  syncOpenedTrade: (trade: TradeIndexRow) => Promise<unknown>
}

interface LockedAccountRow extends QueryResultRow {
  id: string
  user_id: string
  account_size: string
  current_balance: string
  starting_balance: string
  peak_balance: string
  status: string
  account_type: string
  phase_end_date: Date | string | null
  scaling_multiplier: string | null
  challenge_model_slug: string | null
  kyc_status: string | null
}

interface SnapshotOpenTrade {
  direction: string
  open_price: NumericInput
  lot_size: NumericInput
  instrument: string
  commission: NumericInput
}

interface LastClosedSetup {
  lot_size: NumericInput
  demo_pnl: NumericInput
}

interface SnapshotRow extends QueryResultRow {
  opposite_open: unknown
  same_direction_open: unknown
  last_closed_setup: unknown
  trades_today: NumericInput
  exposure_lots: NumericInput
  open_or_pending_count: NumericInput
  open_trades: unknown
}

interface PreTradeSnapshot {
  opposite_open: boolean
  same_direction_open: boolean
  last_closed_setup: LastClosedSetup | null
  trades_today: NumericInput
  exposure_lots: NumericInput
  open_or_pending_count: NumericInput
  open_trades: SnapshotOpenTrade[]
}

interface InsertedTradeRow extends TradeIndexRow, PendingIndexRow {
  status: string
  demo_trade_id: string | null
  open_screenshot_path?: string | null
}

interface OcoSiblingConfig {
  order_type: string
  pending_price: number
  direction: string
}

interface IdempotencyDecision {
  status: number
  body: JsonValue
}

interface OpenTestApi {
  normalizePositiveNumber: (value: unknown) => number | null
  mapTradeMutationRecord: (row: QueryResultRow) => TradeMutationRecordDto
  openTradeHandler: (
    req: OpenRequest,
    res: ExpressResponse<OpenResponse>
  ) => Promise<ExpressResponse<OpenResponse>>
}

interface OpenRouter extends Router {
  __test__: OpenTestApi
}

const requestRecordSchema = z.record(z.string(), z.unknown())
const numericInputSchema = z.union([z.string(), z.number(), z.null(), z.undefined()])
const snapshotOpenTradeSchema: z.ZodType<SnapshotOpenTrade> = z.object({
  direction: z.string(),
  open_price: numericInputSchema,
  lot_size: numericInputSchema,
  instrument: z.string(),
  commission: numericInputSchema
})
const lastClosedSetupSchema: z.ZodType<LastClosedSetup> = z.object({
  lot_size: numericInputSchema,
  demo_pnl: numericInputSchema
})
const typedNewsService = newsService as NewsServiceApi
const { v4: uuidv4 } = require('uuid') as UuidApi
const { validatePendingOrderPrice } = require('../../utils/pendingOrderValidation') as PendingOrderValidationApi
const { fetchStepModelBySlug } = require('../../utils/stepModels') as StepModelsApi
const { recordRequestSignals } = require('../../services/identitySignals') as IdentitySignalsApi
const router = express.Router() as OpenRouter

function normalizePositiveNumber(value: unknown): number | null {
  if (value === '' || value === null || value === undefined) return null
  const parsed = Number.parseFloat(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function requestBody(value: unknown): Record<string, unknown> {
  const parsed = requestRecordSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function errorCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('code' in value)) return null
  return typeof value.code === 'string' ? value.code : null
}

function isNamedError(value: unknown, name: string): value is Error {
  return value instanceof Error && value.name === name
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value === 'object') {
    const output: { [key: string]: JsonValue } = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (nestedValue !== undefined) output[key] = toJsonValue(nestedValue)
    }
    return output
  }
  return String(value)
}

function mapTradeMutationRecord(row: QueryResultRow): TradeMutationRecordDto {
  const output: { [key: string]: JsonValue } = {}
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) output[key] = toJsonValue(value)
  }
  return output
}

function parseSnapshot(row: SnapshotRow): PreTradeSnapshot {
  const openTrades = z.array(snapshotOpenTradeSchema).parse(row.open_trades ?? [])
  const lastClosedSetup = row.last_closed_setup == null
    ? null
    : lastClosedSetupSchema.parse(row.last_closed_setup)
  return {
    opposite_open: Boolean(row.opposite_open),
    same_direction_open: Boolean(row.same_direction_open),
    last_closed_setup: lastClosedSetup,
    trades_today: row.trades_today,
    exposure_lots: row.exposure_lots,
    open_or_pending_count: row.open_or_pending_count,
    open_trades: openTrades
  }
}

function timestampMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return new Date(value).getTime()
  return new Date(String(value)).getTime()
}

function persistedDecimal(value: Decimal.Value): string {
  return serializeDecimal(new Decimal(value))
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch (_error: unknown) {
    // The primary transaction error remains authoritative.
  }
}

async function publishTradeIndex(type: unknown, payload: unknown): Promise<boolean> {
  const sync = require('../../services/tradeIndexSync') as TradeIndexSyncApi
  return sync.publish(type, payload)
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
async function openTradeHandler(
  req: OpenRequest,
  res: ExpressResponse<OpenResponse>
): Promise<ExpressResponse<OpenResponse>> {
  let idempotencyClaim: string | null = null
  try {
    await tradeShared.ensureTradeExperienceInfrastructure()

    const body = requestBody(req.body)
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
    } = body

    // Enhanced input validation
    if (!account_id || !instrument || !direction || !lots) {
      return res.status(400).json({ error: 'account_id, instrument, direction, and lots are required' })
    }

    if (screenshot_data_url != null && !tradeRouteShared.isValidImageDataUrl(screenshot_data_url)) {
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
    
    if (!tradeShared.VALID_INSTRUMENTS.includes(sanitizedInstrument)) {
      return res.status(400).json({ error: 'Invalid instrument' })
    }

    // C-01 containment: PnL is computed as priceDiff * lots * contractSize and
    // booked as USD, which is only correct for USD-quoted instruments. Until
    // FX conversion lands, block *opening* anything else. Existing positions on
    // restricted instruments are unaffected — they still price, chart and close.
    if (!tradeShared.isTradableInstrument(sanitizedInstrument)) {
      return res.status(400).json({
        error: `${sanitizedInstrument} is temporarily unavailable for new positions. Existing positions can still be managed and closed as normal.`
      })
    }

    if (!['buy', 'sell'].includes(sanitizedDirection)) {
      return res.status(400).json({ error: 'Direction must be buy or sell' })
    }

    // â”€â”€ Strict News Protection (3 min USD High Impact) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const activeNews = typedNewsService.getActiveNewsEvent(3)
    if (activeNews) {
      return res.status(400).json({ error: `Cannot open trade. USD High-impact news event '${activeNews.title}' is active.` })
    }

    // Use validation utility for lot size
    if (!isValidLotSize(lots)) {
      return res.status(400).json({ error: 'Invalid lot size. Must be between 0.01 and 1000 in 0.01 increments.' })
    }

    const lotsNum = Number.parseFloat(String(lots))
    // â”€â”€ Minimum lot size (admin-configurable) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let rules = await tradeShared.getTradingRules()
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

    const marketStatus = tradeShared.getMarketStatus(instrumentFinal, { purpose: 'open' })
    const PENDING_ORDER_TYPES: readonly string[] = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop']
    const orderTypeFinal = order_type ? String(order_type) : 'market'
    const isPending         = PENDING_ORDER_TYPES.includes(orderTypeFinal)
    const hasOcoSibling = !!oco_sibling

    if (!isPending && !marketStatus.open) {
      return res.status(400).json({ error: marketStatus.reason })
    }

    if (hasOcoSibling && !isPending) {
      return res.status(400).json({ error: 'OCO is only available for pending orders' })
    }

    let ocoSiblingConfig: OcoSiblingConfig | null = null
    if (hasOcoSibling) {
      const parsedSibling = requestRecordSchema.safeParse(oco_sibling)
      if (!parsedSibling.success) {
        return res.status(400).json({ error: 'Invalid OCO sibling payload' })
      }
      const siblingOrderType = sanitizeString(String(parsedSibling.data.order_type || '').toLowerCase(), 20)
      const siblingPendingPrice = normalizePositiveNumber(parsedSibling.data.pending_price)
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
    let newTrade: InsertedTradeRow | undefined
    try {
      await client.query('BEGIN')

      // Lock the account row for this transaction.
      //
      // u.kyc_status is joined in rather than fetched separately: the funded-stage
      // KYC gate immediately below needs it, and a second round-trip while this
      // transaction already holds FOR UPDATE on the account row is the pool
      // -deadlock shape documented in routes/payouts.js. FOR UPDATE OF a keeps
      // the lock on the account row only — we are not locking the user row.
      const lockedAccount = await client.query<LockedAccountRow>(
        `SELECT a.id, a.user_id, a.account_size, a.current_balance, a.starting_balance, a.peak_balance,
                a.status, a.account_type, a.phase_end_date, a.scaling_multiplier, a.challenge_model_slug,
                u.kyc_status
         FROM accounts a
         JOIN users u ON u.id = a.user_id
         WHERE a.id = $1 AND a.user_id = $2 AND a.status = 'active'
         FOR UPDATE OF a`,
        [accountIdStr, authenticatedUserId(req)]
      )
      const account = lockedAccount.rows[0]
      if (!account) {
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Account not found or not active' })
      }

      // ── Funded-stage KYC gate ────────────────────────────────────────────────
      //
      // KYC used to be required before a trader could BUY a challenge, which meant
      // manual review hours were spent on people who had paid nothing, and a
      // trader could pay for an order and then be rejected with no way to trade
      // and no refund path. That gate is gone (routes/accounts.js POST /create).
      //
      // It moves here instead: identity is verified at the point real capital is
      // at stake, not at the point money comes in. A passed trader keeps their
      // result and their funded account is created normally — they simply cannot
      // open a position on it until KYC clears. Evaluation phases are unaffected.
      //
      // Closing is deliberately NOT gated: promotion only happens with zero open
      // trades, so there is nothing to close here, but if that ever changes a
      // trader must always be able to flatten risk.
      if (account.account_type === 'funded'
          && String(account.kyc_status || '').toLowerCase() !== 'approved') {
        await client.query('ROLLBACK')
        return res.status(403).json({
          error: 'Identity verification is required before trading a funded account. Your account is safe — complete verification and trading unlocks immediately.',
          code: 'KYC_REQUIRED_FOR_FUNDED',
          kyc_status: account.kyc_status || 'pending'
        })
      }

      // FIX (LOOPHOLE 2): Reject trades on accounts past their phase_end_date
      // The challenge engine checks every 30s, so there's a window where traders
      // could still open trades on an expired account.
      rules = await tradeShared.getTradingRules()
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

      const snapshotResult = await client.query<SnapshotRow>(
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
      )
      const snapshotRow = snapshotResult.rows[0]
      if (!snapshotRow) throw new Error('Pre-trade snapshot returned no row')
      const snapshot = parseSnapshot(snapshotRow)

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
            if (lastRow
                && Number.parseFloat(String(lastRow.demo_pnl)) < 0
                && lotsNum > Number.parseFloat(String(lastRow.lot_size))) {
              await client.query('ROLLBACK')
              return res.status(400).json({
                error: `Martingale trading is not allowed on this account. You cannot increase lot size after a loss on the same ${instrumentFinal} ${directionFinal} setup.`
              })
            }
          }
        }
      }

      // ── Position-count cap ──────────────────────────────────────────────
      //
      // The ONLY structural position limit left. The per-$1k lot caps,
      // max_trades_per_1k and max_daily_trades were all removed alongside the
      // move to unlimited leverage: with no margin requirement, a cap expressed
      // in lots-per-$1k no longer describes anything a trader can reason about.
      // Risk is now governed by the drawdown rules, not by size.
      //
      // This one survives because it is not a size control — it bounds how many
      // positions can be open at once, which is what stops runaway automation
      // and keeps the equity/breach scan bounded per account. Admin-configurable
      // via platform_settings.max_open_positions; zero or negative disables it.
      const maxOpenTrades = rules.maxOpenPositions
      const currentOpenCount = Number.parseInt(String(snapshot.open_or_pending_count), 10)

      if (maxOpenTrades > 0 && currentOpenCount >= maxOpenTrades) {
        await client.query('ROLLBACK')
        return res.status(400).json({
          error: `Maximum of ${maxOpenTrades} open or pending positions at once. You currently have ${currentOpenCount}. Close one before opening another.`
        })
      }

      // â”€â”€ Margin check (inside transaction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      
      const livePrices = await getCurrentPricesForTenant()
      // Read in the same snapshot query above, under the same lock. json_agg
      // renders numerics as JSON numbers rather than the strings a normal row
      // gives, which the parseFloat calls below already tolerate.
      const openTradesResult = { rows: snapshot.open_trades }
      for (const t of openTradesResult.rows) {
        const livePrice = livePrices[t.instrument]
        if (!livePrice) continue
        const currentPrice = t.direction === 'buy'
          ? Number.parseFloat(String(livePrice.bid))
          : Number.parseFloat(String(livePrice.ask))
        try {
          calculatePnL(
            t.direction,
            Number.parseFloat(String(t.open_price)),
            currentPrice,
            Number.parseFloat(String(t.lot_size)),
            t.instrument,
            Number.parseFloat(String(t.commission || 0))
          )
        } catch (error: unknown) {
          // Under FX conversion, calculatePnL throws when the instrument's
          // QUOTE/USD rate source is missing from the price cache. The cross-JPY
          // pairs all take their rate from USDJPY, so one dark symbol can leave
          // several open positions unvaluable.
          //
          // This must REFUSE, not skip. The engine's equivalent loop skips
          // safely because understating floating loss there means declining to
          // declare a breach. Here the sum is the equity behind a margin check,
          // so understating loss OVERSTATES equity and would admit a trade that
          // should have been refused for insufficient margin. Failing closed is
          // the only safe direction on this path.
          if (!isNamedError(error, 'FxRateUnavailableError')) throw error
          await client.query('ROLLBACK')
          logger.warn('[trades/open] refused: an open position cannot be valued', {
            accountId: account.id, instrument: t.instrument, error: error.message
          })
          return res.status(503).json({
            error: 'Your open positions cannot be valued right now because a currency rate is unavailable. ' +
                   'No new trade was opened. Please try again shortly.'
          })
        }
      }
      
      // ── Notional ceiling (replaces the margin/equity check) ─────────────────
      //
      // Leverage is unlimited, so calculateMargin() returns 0 and the old
      // "Insufficient equity. Required margin: X" refusal can never fire — an
      // account with $1 of equity may now open any size it likes. That is the
      // intended product.
      //
      // What remains is a fat-finger guard, not a risk limit. It refuses a
      // single order whose NOTIONAL value (lots x contract size x price, in the
      // instrument's quote currency) exceeds max_notional_multiple times the
      // account size. At the default 500x, a $10k account can open $5m of
      // notional — far beyond any deliberate trade — so the only orders this
      // rejects are mistyped ones: the trader who means 5 lots and types 500.
      //
      // Deliberately measured per-order rather than as aggregate exposure. An
      // aggregate cap is a position-size limit by another name, which is exactly
      // what was removed here.
      const notionalMultiple = rules.maxNotionalMultiple
      if (notionalMultiple > 0) {
        const quote = livePrices[instrumentFinal]
        const referencePrice = Number.parseFloat(String(quote?.ask ?? quote?.bid ?? 0))
        if (referencePrice > 0) {
          const notional = new Decimal(lotsNum)
            .times(CONTRACT_SIZES[instrumentFinal] || 100000)
            .times(referencePrice)
          const ceiling = new Decimal(account.account_size).times(notionalMultiple)
          if (notional.gt(ceiling)) {
            await client.query('ROLLBACK')
            return res.status(400).json({
              error: `That order is ${notional.div(account.account_size).toDecimalPlaces(0)}x your account size in notional value, which looks like a typo. ` +
                     `The per-order ceiling is ${notionalMultiple}x ($${ceiling.toDecimalPlaces(0)}). Check your lot size.`,
              code: 'NOTIONAL_CEILING'
            })
          }
        }
      }

      const demo_trade_id = uuidv4()
      const commissionPerLot = resolveTieredInstrumentSetting(rules.commissionPerLotJson, account.account_type, instrumentFinal, rules.dynamicCommissionPerLot)
      const tradeCommission = Number.parseFloat((lotsNum * commissionPerLot).toFixed(2))

      async function ensureTradeOpenIdempotencyClaim(): Promise<IdempotencyDecision | null> {
        if (idempotencyClaim) return null

        const idempotencyResult = await beginIdempotentRequest(pool, {
          scope: 'trades:open',
          actorId: authenticatedUserId(req),
          idempotencyKey: getIdempotencyKey(req)
        })

        // FIX (H-03): a missing header used to mean "no replay protection",
        // so a retried request opened a second position.
        if ('required' in idempotencyResult && idempotencyResult.required) {
          return { status: 400, body: { error: idempotencyResult.error } }
        }
        if ('replay' in idempotencyResult && idempotencyResult.replay) {
          return {
            status: idempotencyResult.responseStatus,
            body: idempotencyResult.responseBody
          }
        }
        if ('inProgress' in idempotencyResult && idempotencyResult.inProgress) {
          return {
            status: 409,
            body: { error: 'This trade-open request is already being processed.' }
          }
        }

        idempotencyClaim = 'claimId' in idempotencyResult ? idempotencyResult.claimId : null
        return null
      }

      // â”€â”€ Pending order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (isPending) {
        const pendingPriceNumber = Number.parseFloat(String(pending_price))
        const price: LivePrice | null = await tradeShared.getLivePrice(instrumentFinal)
          .catch((_error: unknown) => null)
        const bid = price ? Number.parseFloat(String(price.bid)) : Number.NaN
        const ask = price ? Number.parseFloat(String(price.ask)) : Number.NaN

        const validationError = validatePendingOrderPrice(orderTypeFinal, pendingPriceNumber, bid, ask)
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
        const pendingTradeResult = await client.query<InsertedTradeRow>(
          `INSERT INTO trades
           (account_id, demo_trade_id, instrument, direction, lot_size,
            status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
            oco_group_id)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
           RETURNING *`,
          [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, persistedDecimal(lotsNum),
           stop_loss   ? persistedDecimal(String(stop_loss))   : null,
           take_profit ? persistedDecimal(String(take_profit)) : null,
           orderTypeFinal,
           persistedDecimal(pendingPriceNumber),
           persistedDecimal(tradeCommission),
           ocoGroupId]
        )
        newTrade = pendingTradeResult.rows[0]
        if (!newTrade) throw new Error('Pending trade insert returned no row')
        if (screenshot_data_url) {
          const openScreenshotPath = await tradeRouteShared.persistTradeScreenshot({
            tradeId: newTrade.id,
            userId: authenticatedUserId(req),
            kind: 'open',
            dataUrl: screenshot_data_url
          })
          if (openScreenshotPath) {
            await client.query(
              'UPDATE trades SET open_screenshot_path = $1 WHERE id = $2',
              [openScreenshotPath, newTrade.id]
            )
            newTrade.open_screenshot_path = openScreenshotPath
          }
        }
        let siblingTradeId: string | null = null
        if (ocoSiblingConfig && ocoGroupId) {
          const siblingTrade = await client.query<InsertedTradeRow>(
            `INSERT INTO trades
             (account_id, demo_trade_id, instrument, direction, lot_size,
              status, stop_loss, take_profit, order_type, pending_price, commission, original_commission,
              oco_group_id)
             VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $10, $11)
             RETURNING *`,
            [accountIdStr, uuidv4(), instrumentFinal, ocoSiblingConfig.direction, persistedDecimal(lotsNum),
             stop_loss   ? persistedDecimal(String(stop_loss))   : null,
             take_profit ? persistedDecimal(String(take_profit)) : null,
             ocoSiblingConfig.order_type,
             persistedDecimal(ocoSiblingConfig.pending_price),
             persistedDecimal(tradeCommission),
             ocoGroupId]
          )
          siblingTradeId = siblingTrade.rows[0]?.id ?? null
        }
        await client.query(
          `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
           VALUES ($1, $2, $3, $4, NOW())`,
          [newTrade.id, authenticatedUserId(req), accountIdStr, tradeIp]
        )
        // FIX (M-10): the daily-trade limit counts trade_logs rows, but only the
        // primary leg was ever logged — so an OCO pair counted as one trade
        // while creating two orders, letting a trader place twice the cap.
        if (siblingTradeId) {
          await client.query(
            `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [siblingTradeId, authenticatedUserId(req), accountIdStr, tradeIp]
          )
        }
        await client.query('COMMIT')

        // Fire-and-forget, and only after COMMIT — a fraud signal must never
        // hold a trade transaction open or fail an order.
        void recordRequestSignals(authenticatedUserId(req), {
          ip: tradeIp,
          deviceSignature: req.deviceSignature,
          context: 'trade'
        })

        const tradeRow = newTrade

        // Keep the engine's in-memory index in step with what was just written,
        // so the order can be triggered on the very next price tick rather than
        // waiting for the next reconciliation.
        await (tradeRouteShared.engine() as OpenEngineApi).syncPendingOrder(tradeRow)
        await publishTradeIndex('pending', { trade: tradeRow })
        if (siblingTradeId && ocoSiblingConfig) {
          const siblingIndexTrade: InsertedTradeRow = {
            ...tradeRow,
            id: siblingTradeId,
            direction: ocoSiblingConfig.direction,
            order_type: ocoSiblingConfig.order_type,
            pending_price: ocoSiblingConfig.pending_price
          }
          await (tradeRouteShared.engine() as OpenEngineApi).syncPendingOrder(siblingIndexTrade)
          await publishTradeIndex('pending', { trade: siblingIndexTrade })
        }

        const responseBody: OpenTradeResponseDto = {
          message: `${orderTypeFinal.replace(/_/g, ' ')} order placed`,
          trade_id: tradeRow.id,
          account_id: tradeRow.account_id,
          trade: mapTradeMutationRecord(tradeRow),
          oco_sibling_trade_id: siblingTradeId
        }
        if (idempotencyClaim) {
          await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
          idempotencyClaim = null
        }
        return res.status(201).json(responseBody)
      }

      // â”€â”€ Market order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const price = await tradeShared.getLivePrice(instrumentFinal)
      const priceAgeMs = Date.now() - timestampMillis(price.updated_at)
      // Allow up to 10 seconds for price age (more lenient for slower MT5 setups)
      if (priceAgeMs > 10000) {
        logger.warn('Price feed too old:', { instrument: instrumentFinal, ageMs: priceAgeMs })
        await client.query('ROLLBACK')
        return res.status(400).json({ error: 'Price feed is currently delayed. Order rejected due to volatility protection/latency.' })
      }
      let openPrice = directionFinal === 'buy'
        ? Number.parseFloat(String(price.ask))
        : Number.parseFloat(String(price.bid))

      // M-08 resolved by behaviour change. The draw used to be
      // `Math.random() * max` applied ALWAYS against the trader — buys filled
      // higher and closed lower, sells the reverse, so a round trip paid it
      // twice on top of spread and commission. It was a house edge that no
      // trader could see, and the marketing had denied it outright.
      //
      // The draw is now symmetric: -max … +max, so slippage can favour the
      // trader as often as it costs them, which is what slippage means. The
      // stored setting keeps its `..._adverse` name to avoid a settings
      // migration; it is the half-width of the distribution, not its direction.
      //
      // slippage_pips is therefore signed now — positive is against the trader,
      // negative is in their favour. Anything aggregating it must not assume ≥ 0.
      let slippageIncurred = 0
      const openSlippageMaxPips = resolveTieredInstrumentSetting(rules.slippageMaxPipsAdverseJson, account.account_type, instrumentFinal, rules.slippageMaxPipsAdverse)
      if (rules.slippageSimulatorEnabled && openSlippageMaxPips > 0) {
        const randPips = (Math.random() * 2 - 1) * openSlippageMaxPips
        slippageIncurred = Number.parseFloat(randPips.toFixed(2))
        const slippageAmt = randPips * getPipSize(instrumentFinal)

        openPrice = directionFinal === 'buy' ? openPrice + slippageAmt : openPrice - slippageAmt
        openPrice = roundPrice(openPrice, instrumentFinal)
      }

      if (stop_loss) {
        if (directionFinal === 'buy' && Number.parseFloat(String(stop_loss)) >= openPrice) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be below entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && Number.parseFloat(String(stop_loss)) <= openPrice) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Stop loss must be above entry price for SELL trades' })
        }
      }

      if (take_profit) {
        if (directionFinal === 'buy' && Number.parseFloat(String(take_profit)) <= openPrice) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be above entry price for BUY trades' })
        }
        if (directionFinal === 'sell' && Number.parseFloat(String(take_profit)) >= openPrice) {
          await client.query('ROLLBACK')
          return res.status(400).json({ error: 'Take profit must be below entry price for SELL trades' })
        }
      }

      const marketClaimResult = await ensureTradeOpenIdempotencyClaim()
      if (marketClaimResult) {
        await client.query('ROLLBACK')
        return res.status(marketClaimResult.status).json(marketClaimResult.body)
      }

      const marketTradeResult = await client.query<InsertedTradeRow>(
        `INSERT INTO trades
         (account_id, demo_trade_id, instrument, direction, lot_size, open_price, open_time,
          status, stop_loss, take_profit, order_type, commission, original_commission, slippage_pips)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'open', $7, $8, 'market', $9, $9, $10)
         RETURNING *`,
        [accountIdStr, demo_trade_id, instrumentFinal, directionFinal, persistedDecimal(lotsNum), persistedDecimal(openPrice),
         stop_loss   ? persistedDecimal(String(stop_loss))   : null,
         take_profit ? persistedDecimal(String(take_profit)) : null,
         persistedDecimal(tradeCommission),
         slippageIncurred]
      )
      newTrade = marketTradeResult.rows[0]
      if (!newTrade) throw new Error('Market trade insert returned no row')

      if (screenshot_data_url) {
        const openScreenshotPath = await tradeRouteShared.persistTradeScreenshot({
          tradeId: newTrade.id,
          userId: authenticatedUserId(req),
          kind: 'open',
          dataUrl: screenshot_data_url
        })
        if (openScreenshotPath) {
          await client.query(
            'UPDATE trades SET open_screenshot_path = $1 WHERE id = $2',
            [openScreenshotPath, newTrade.id]
          )
          newTrade.open_screenshot_path = openScreenshotPath
        }
      }

      await client.query(
        `INSERT INTO trade_logs (trade_id, user_id, account_id, ip_address, logged_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [newTrade.id, authenticatedUserId(req), accountIdStr, tradeIp]
      )

      await client.query('COMMIT')

    } catch (transactionError: unknown) {
      await rollback(client)
      throw transactionError
    } finally {
      client.release()
    }

    // Fire-and-forget, post-COMMIT — see the pending-order path above.
    void recordRequestSignals(authenticatedUserId(req), {
      ip: tradeIp,
      deviceSignature: req.deviceSignature,
      context: 'trade'
    })

    if (!newTrade) throw new Error('Trade transaction completed without a row')
    const tradeRow = newTrade

    // Index the new position (and seed its floating PnL from the current price)
    // so it is eligible for SL/TP and drawdown checks on the next tick.
    await (tradeRouteShared.engine() as OpenEngineApi).syncOpenedTrade(tradeRow)
    await publishTradeIndex('open', { trade: tradeRow })

    const responseBody: OpenTradeResponseDto = {
      message: 'Trade opened successfully',
      trade_id: tradeRow.id,
      account_id: tradeRow.account_id,
      trade: mapTradeMutationRecord(tradeRow)
    }
    if (idempotencyClaim) {
      await completeIdempotentRequest(pool, idempotencyClaim, 201, responseBody)
      idempotencyClaim = null
    }
    return res.status(201).json(responseBody)

    // â”€â”€ IP logging on trade open (non-fatal, runs after response) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  } catch (error: unknown) {
    if (idempotencyClaim) {
      await abandonIdempotentRequest(pool, idempotencyClaim).catch((_abandonError: unknown) => {})
    }
    logger.error('Open trade error:', { error: errorMessage(error) })
    if (errorCode(error) === 'PRICE_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'This instrument is currently unavailable for your tenant feed.' })
    }
    return res.status(500).json({ error: 'Could not open trade' })
  }
}

router.post('/open', authenticateToken, tradingLimiter, openTradeHandler)
router.__test__ = { normalizePositiveNumber, mapTradeMutationRecord, openTradeHandler }

export = router
