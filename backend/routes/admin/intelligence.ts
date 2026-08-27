// Firm Intelligence page — 75 read-only analyses across six data tabs plus a
// catalogue. Mounted at the router root by ./index.js, so every path below is
// absolute under /api/admin.

import type { JsonValue, LegacyErrorResponse } from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse
} from 'express'
import logger = require('../../utils/logger')

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
  requireSuperAdmin: RequestHandler
}

interface DateRangeApi {
  parseDateRange: (query: ExpressRequest['query']) => unknown
}

interface IntelligenceBuilderApi {
  build: (range?: unknown) => Promise<JsonValue>
}

interface RegistryApi {
  METRICS: JsonValue
  TABS: JsonValue
  summary: () => JsonValue
}

interface TabRouteOptions {
  rangeless?: boolean
}

type IntelligenceResponse = JsonValue | LegacyErrorResponse
type IntelligenceBuilder = (range?: unknown) => Promise<JsonValue>

const { authenticateAdmin, requireSuperAdmin } = require('../middleware') as MiddlewareApi
const { parseDateRange } = require('../../services/analytics/helpers') as DateRangeApi
const revenue = require('../../services/analytics/revenue') as IntelligenceBuilderApi
const models = require('../../services/analytics/models') as IntelligenceBuilderApi
const liability = require('../../services/analytics/liability') as IntelligenceBuilderApi
const growth = require('../../services/analytics/growth') as IntelligenceBuilderApi
const ops = require('../../services/analytics/ops') as IntelligenceBuilderApi
const pulse = require('../../services/analytics/pulse') as IntelligenceBuilderApi
const registry = require('../../services/analytics/registry') as RegistryApi
const router = express.Router()

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function errorStack(value: unknown): string | undefined {
  return value instanceof Error ? value.stack : undefined
}

// One wrapper for every tab: parse the range, run the builder, log and 500
// cleanly. Keeps each route below to its one real line.
function tabRoute(
  name: string,
  builder: IntelligenceBuilder,
  { rangeless = false }: TabRouteOptions = {}
): RequestHandler<Record<string, never>, IntelligenceResponse> {
  return async function handler(
    req: ExpressRequest<Record<string, never>, IntelligenceResponse>,
    res: ExpressResponse<IntelligenceResponse>
  ): Promise<void> {
    try {
      const payload = rangeless
        ? await builder()
        : await builder(parseDateRange(req.query))
      res.json(payload)
    } catch (error: unknown) {
      logger.error(`[intelligence:${name}] failed`, {
        error: errorMessage(error),
        stack: errorStack(error)
      })
      res.status(500).json({ error: `Could not load ${name} intelligence` })
    }
  }
}

// Revenue & unit economics is super-admin only because it contains firm P&L.
router.get('/intelligence/revenue', authenticateAdmin, requireSuperAdmin,
  tabRoute('revenue', revenue.build))
router.get('/intelligence/models', authenticateAdmin,
  tabRoute('models', models.build))
router.get('/intelligence/liability', authenticateAdmin, requireSuperAdmin,
  tabRoute('liability', liability.build))
router.get('/intelligence/growth', authenticateAdmin,
  tabRoute('growth', growth.build))
router.get('/intelligence/ops', authenticateAdmin,
  tabRoute('ops', ops.build))
router.get('/intelligence/pulse', authenticateAdmin,
  tabRoute('pulse', pulse.build, { rangeless: true }))

async function catalogueHandler(
  _req: ExpressRequest<Record<string, never>, IntelligenceResponse>,
  res: ExpressResponse<IntelligenceResponse>
): Promise<void> {
  try {
    res.json({
      generated_at: new Date().toISOString(),
      summary: registry.summary(),
      tabs: registry.TABS,
      metrics: registry.METRICS
    })
  } catch (error: unknown) {
    logger.error('[intelligence:catalogue] failed', { error: errorMessage(error) })
    res.status(500).json({ error: 'Could not load the analysis catalogue' })
  }
}

router.get('/intelligence/catalogue', authenticateAdmin, catalogueHandler)

export = router
