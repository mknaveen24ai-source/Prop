// GET /api/trades/:tradeId/screenshot/:kind — serves journal screenshots.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

import type { LegacyErrorResponse } from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import pool = require('../../db')
import logger = require('../../utils/logger')
import { authenticateToken } from '../middleware'
import tradeShared = require('../../services/tradeShared')
import tradeRouteShared = require('./shared')

interface TradeScreenshotRow extends QueryResultRow {
  id: string
  open_screenshot_path: string | null
  close_screenshot_path: string | null
}

interface ScreenshotTestApi {
  screenshotHandler: (
    req: ExpressRequest<Record<string, unknown>, LegacyErrorResponse>,
    res: ExpressResponse<LegacyErrorResponse>
  ) => Promise<void | ExpressResponse<LegacyErrorResponse>>
}

interface ScreenshotRouter extends Router {
  __test__: ScreenshotTestApi
}

const { ensureTradeExperienceInfrastructure } = tradeShared
const { buildTradeScreenshotAbsolutePath } = tradeRouteShared
const router = express.Router() as ScreenshotRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

async function screenshotHandler(
  req: ExpressRequest<Record<string, unknown>, LegacyErrorResponse>,
  res: ExpressResponse<LegacyErrorResponse>
): Promise<void | ExpressResponse<LegacyErrorResponse>> {
  try {
    await ensureTradeExperienceInfrastructure()

    const { tradeId, kind } = req.params
    const normalizedKind = kind === 'close' ? 'close' : 'open'

    const tradeResult = await pool.query<TradeScreenshotRow>(
      `SELECT t.id, t.open_screenshot_path, t.close_screenshot_path
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1
          AND a.user_id = $2`,
      [tradeId, authenticatedUserId(req)]
    )

    const trade = tradeResult.rows[0]
    if (!trade) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    const screenshotPath = normalizedKind === 'close'
      ? trade.close_screenshot_path
      : trade.open_screenshot_path
    const absolutePath = buildTradeScreenshotAbsolutePath(screenshotPath)

    if (!absolutePath) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    return res.sendFile(absolutePath)
  } catch (error: unknown) {
    logger.error('Trade screenshot error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load trade screenshot' })
  }
}

router.get('/:tradeId/screenshot/:kind', authenticateToken as RequestHandler, screenshotHandler)

router.__test__ = { screenshotHandler }

export = router
