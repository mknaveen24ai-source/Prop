import type { LegacyErrorResponse } from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import pool = require('../db')
import instruments = require('../instruments')
import logger = require('../utils/logger')
import {
  getTenantSettingsMap,
  parseSpreadMarkupMap,
  upsertTenantSettings
} from '../utils/tenantSettings'

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireSuperAdmin: RequestHandler
}

interface AdminInternalsApi {
  appendImmutableAudit: (
    database: typeof pool,
    input: {
      eventType: string
      entityType: string
      entityId: string
      actor: unknown
      payload: unknown
    }
  ) => Promise<unknown>
  ensureFeatureTables: () => Promise<void>
  getAdminActorLabel: (admin: Express.AuthenticatedAdmin | undefined) => string
}

interface TradingEconomicsParams {
  [key: string]: string
}

interface TradingEconomicsResponse {
  commission_per_lot: Record<string, unknown>
  slippage_max_pips_adverse: Record<string, unknown>
  default_commission_per_lot: number
  default_slippage_max_pips_adverse: number
  instruments: readonly string[]
  tiers: readonly TradingTier[]
}

interface TradingEconomicsUpdateResponse {
  message: 'Trading economics settings updated'
  commission_per_lot: TieredMap
  slippage_max_pips_adverse: TieredMap
}

interface TradingEconomicsTestApi {
  validateTieredMap: (map: unknown, label: string) => TieredMap
}

interface TradingEconomicsRouter extends Router {
  __test__: TradingEconomicsTestApi
}

type TradingTier = 'challenge' | 'funded' | 'competition'
type TieredMap = Record<string, Record<string, unknown>>
type TradingEconomicsRouteResponse = TradingEconomicsResponse
  | TradingEconomicsUpdateResponse
  | LegacyErrorResponse
type TradingEconomicsRequest = ExpressRequest<
  TradingEconomicsParams,
  TradingEconomicsRouteResponse,
  unknown
>

const { authenticateAdmin, requireSuperAdmin } = require('./middleware') as MiddlewareApi
const { appendImmutableAudit, getAdminActorLabel, ensureFeatureTables } = (
  require('./admin') as { _internals: AdminInternalsApi }
)._internals
const { INSTRUMENTS } = instruments
const TIERS: readonly TradingTier[] = ['challenge', 'funded', 'competition']
const router = express.Router() as TradingEconomicsRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function errorStatusCode(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || !('statusCode' in value)) return null
  const statusCode = value.statusCode
  return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : null
}

function badRequest(message: string): Error & { statusCode: 400 } {
  return Object.assign(new Error(message), { statusCode: 400 as const })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestBodyRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

async function auditLog(
  req: TradingEconomicsRequest,
  eventType: string,
  payload: unknown
): Promise<void> {
  try {
    await ensureFeatureTables()
    await appendImmutableAudit(pool, {
      eventType,
      entityType: 'trading_economics',
      entityId: 'global',
      actor: getAdminActorLabel(req.admin),
      payload
    })
  } catch (error: unknown) {
    logger.warn('[admin-trading-economics] Non-critical audit log failed:', {
      error: errorMessage(error)
    })
  }
}

// Validates a {tier: {instrument|'*': number}} map, rejecting unknown tiers,
// unknown instruments (other than the '*' wildcard), and non-finite/negative values.
function validateTieredMap(map: unknown, label: string): TieredMap {
  if (map === undefined || map === null) return {}
  if (!isRecord(map)) {
    throw badRequest(`${label} must be an object keyed by tier`)
  }

  const validated: TieredMap = {}
  for (const [tier, instrumentMap] of Object.entries(map)) {
    if (!TIERS.includes(tier as TradingTier)) {
      throw badRequest(`${label}: unknown tier "${tier}"`)
    }
    if (!isRecord(instrumentMap)) {
      throw badRequest(`${label}: tier "${tier}" must map to an object`)
    }
    for (const [instrument, value] of Object.entries(instrumentMap)) {
      if (instrument !== '*' && !INSTRUMENTS.includes(instrument)) {
        throw badRequest(`${label}: unknown instrument "${instrument}"`)
      }
      const numeric = Number(value)
      if (!Number.isFinite(numeric) || numeric < 0) {
        throw badRequest(`${label}: value for ${tier}/${instrument} must be a non-negative number`)
      }
    }
    validated[tier] = instrumentMap
  }
  return validated
}

async function getTradingEconomicsHandler(
  _req: TradingEconomicsRequest,
  res: ExpressResponse<TradingEconomicsRouteResponse>
): Promise<ExpressResponse<TradingEconomicsRouteResponse>> {
  try {
    const settings = await getTenantSettingsMap([
      'commission_per_lot_json',
      'slippage_max_pips_adverse_json',
      'dynamic_commission_per_lot',
      'slippage_max_pips_adverse'
    ])
    return res.json({
      commission_per_lot: parseSpreadMarkupMap(settings.commission_per_lot_json),
      slippage_max_pips_adverse: parseSpreadMarkupMap(settings.slippage_max_pips_adverse_json),
      default_commission_per_lot: Number.parseFloat(settings.dynamic_commission_per_lot || '0'),
      default_slippage_max_pips_adverse: Number.parseFloat(settings.slippage_max_pips_adverse || '0'),
      instruments: INSTRUMENTS,
      tiers: TIERS
    })
  } catch (error: unknown) {
    logger.error('[admin-trading-economics] Failed to load settings:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Failed to load trading economics settings' })
  }
}

async function updateTradingEconomicsHandler(
  req: TradingEconomicsRequest,
  res: ExpressResponse<TradingEconomicsRouteResponse>
): Promise<ExpressResponse<TradingEconomicsRouteResponse>> {
  try {
    const body = requestBodyRecord(req.body)
    const commissionMap = validateTieredMap(body.commission_per_lot, 'commission_per_lot')
    const slippageMap = validateTieredMap(body.slippage_max_pips_adverse, 'slippage_max_pips_adverse')

    await upsertTenantSettings(pool, {
      commission_per_lot_json: JSON.stringify(commissionMap),
      slippage_max_pips_adverse_json: JSON.stringify(slippageMap)
    })

    await auditLog(req, 'trading_economics_updated', {
      commission_per_lot: commissionMap,
      slippage_max_pips_adverse: slippageMap
    })
    return res.json({
      message: 'Trading economics settings updated',
      commission_per_lot: commissionMap,
      slippage_max_pips_adverse: slippageMap
    })
  } catch (error: unknown) {
    const statusCode = errorStatusCode(error)
    if (statusCode !== null) {
      return res.status(statusCode).json({ error: errorMessage(error) })
    }
    logger.error('[admin-trading-economics] Failed to update settings:', {
      error: errorMessage(error)
    })
    return res.status(500).json({ error: 'Failed to update trading economics settings' })
  }
}

router.get<TradingEconomicsParams>(
  '/trading-economics',
  authenticateAdmin,
  requireSuperAdmin,
  getTradingEconomicsHandler
)
router.post<TradingEconomicsParams, TradingEconomicsRouteResponse, unknown>(
  '/trading-economics',
  authenticateAdmin,
  requireSuperAdmin,
  updateTradingEconomicsHandler
)

router.__test__ = { validateTieredMap }

export = router
