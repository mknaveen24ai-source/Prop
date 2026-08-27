// Trader & Risk Intelligence page — read-only firm and trader analyses.

import type {
  AdminTraderPickerResponseDto,
  JsonValue,
  LegacyErrorResponse
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  Router
} from 'express'
import logger = require('../../utils/logger')
import { isValidUUID } from '../../utils/validation'
import { authenticateAdmin, requireSuperAdmin } from '../middleware'

type IntelligenceResponse = JsonValue | LegacyErrorResponse
type TraderListResponse = AdminTraderPickerResponseDto | LegacyErrorResponse
type IntelligenceRequest = ExpressRequest<Record<string, never>, IntelligenceResponse>
type TraderListRequest = ExpressRequest<Record<string, never>, TraderListResponse>
type TraderDetailRequest = ExpressRequest<{ userId: string }, IntelligenceResponse>

interface DateRangeApi {
  parseDateRange: (query: ExpressRequest['query']) => unknown
}

interface RiskApi {
  build: (range: unknown) => Promise<JsonValue>
}

interface TraderEdgeApi {
  listTraders: (options: { search: string; limit: number }) => Promise<JsonValue[]>
  build: (userId: string) => Promise<JsonValue | null>
}

interface TraderListQuery {
  search: string
  limit: number
}

interface TraderIntelligenceTestApi {
  normalizeTraderListQuery: (query: ExpressRequest['query']) => TraderListQuery
}

interface TraderIntelligenceRouter extends Router {
  __test__: TraderIntelligenceTestApi
}

const { parseDateRange } = require('../../services/analytics/helpers') as DateRangeApi
const risk = require('../../services/analytics/risk') as RiskApi
const traderEdge = require('../../services/analytics/traderEdge') as TraderEdgeApi
const router = express.Router() as TraderIntelligenceRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function errorStack(value: unknown): string | undefined {
  return value instanceof Error ? value.stack : undefined
}

function normalizeTraderListQuery(query: ExpressRequest['query']): TraderListQuery {
  const search = typeof query.q === 'string' ? query.q.slice(0, 100) : ''
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '', 10)
  return { search, limit: parsedLimit || 50 }
}

async function riskIntelligenceHandler(
  req: IntelligenceRequest,
  res: ExpressResponse<IntelligenceResponse>
): Promise<ExpressResponse<IntelligenceResponse>> {
  try {
    return res.json(await risk.build(parseDateRange(req.query)))
  } catch (error: unknown) {
    logger.error('[trader-intelligence:risk] failed', {
      error: errorMessage(error),
      stack: errorStack(error)
    })
    return res.status(500).json({ error: 'Could not load risk intelligence' })
  }
}

async function traderListHandler(
  req: TraderListRequest,
  res: ExpressResponse<TraderListResponse>
): Promise<ExpressResponse<TraderListResponse>> {
  try {
    const options = normalizeTraderListQuery(req.query)
    return res.json({
      generated_at: new Date().toISOString(),
      traders: await traderEdge.listTraders(options)
    })
  } catch (error: unknown) {
    logger.error('[trader-intelligence:traders] failed', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load traders' })
  }
}

async function traderDetailHandler(
  req: TraderDetailRequest,
  res: ExpressResponse<IntelligenceResponse>
): Promise<ExpressResponse<IntelligenceResponse>> {
  try {
    const { userId } = req.params
    if (!isValidUUID(userId)) {
      return res.status(400).json({ error: 'A valid trader id is required' })
    }

    const payload = await traderEdge.build(userId)
    if (!payload) return res.status(404).json({ error: 'Trader not found' })
    return res.json(payload)
  } catch (error: unknown) {
    logger.error('[trader-intelligence:trader] failed', {
      error: errorMessage(error),
      stack: errorStack(error),
      userId: req.params.userId
    })
    return res.status(500).json({ error: 'Could not load trader intelligence' })
  }
}

router.get('/trader-intelligence/risk', authenticateAdmin, requireSuperAdmin, riskIntelligenceHandler)
router.get('/trader-intelligence/traders', authenticateAdmin, traderListHandler)
router.get('/trader-intelligence/trader/:userId', authenticateAdmin, traderDetailHandler)

router.__test__ = { normalizeTraderListQuery }

export = router
