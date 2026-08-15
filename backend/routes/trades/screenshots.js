// GET /api/trades/:tradeId/screenshot/:kind — serves journal screenshots.
//
// Split out of the former 2,111-line routes/trades.js. Mounted at the ROOT by
// ./index.js with no path prefix, so every path below stays absolute under
// /api/trades.

const express = require('express')
const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateToken } = require('../middleware')
const { ensureTradeExperienceInfrastructure } = require('../../services/tradeShared')
const { buildTradeScreenshotAbsolutePath } = require('./shared')

const router = express.Router()

router.get('/:tradeId/screenshot/:kind', authenticateToken, async function(req, res) {
  try {
    await ensureTradeExperienceInfrastructure()

    const { tradeId, kind } = req.params
    const normalizedKind = kind === 'close' ? 'close' : 'open'

    const tradeResult = await pool.query(
      `SELECT t.id, t.open_screenshot_path, t.close_screenshot_path
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.id = $1
          AND a.user_id = $2`,
      [tradeId, req.user.userId]
    )

    if (tradeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    const screenshotPath = normalizedKind === 'close'
      ? tradeResult.rows[0].close_screenshot_path
      : tradeResult.rows[0].open_screenshot_path
    const absolutePath = buildTradeScreenshotAbsolutePath(screenshotPath)

    if (!absolutePath) {
      return res.status(404).json({ error: 'Trade screenshot not found' })
    }

    return res.sendFile(absolutePath)
  } catch (error) {
    logger.error('Trade screenshot error:', { error: error.message })
    return res.status(500).json({ error: 'Could not load trade screenshot' })
  }
})

module.exports = router
