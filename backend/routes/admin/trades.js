// Admin trade list and force-close.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability
} = require('../middleware')
const logger = require('../../utils/logger')
const { computeRMultiple } = require('../../services/tradeShared')
require('../../loadEnv')

const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  parseListPaging,
  buildPagination
} = require('./shared/helpers')
const {
  calcTradePnl,
  forceCloseTradeById
} = require('./shared/tradeOps')

router.get('/trades', authenticateAdmin, requireAdminCapability('trader:read'), async function(req, res) {
  try {
    const paging = parseListPaging(req)
    const direction = String(req.query?.direction || 'all').toLowerCase()
    const status = String(req.query?.status || 'all').toLowerCase()
    const search = String(req.query?.search || req.query?.q || '').trim()

    // Built separately from `statusCondition` so the Open/Pending/Closed stat-card
    // breakdown (below) can reflect the full picture under the active search+
    // direction filter, independent of which status tab happens to be selected.
    const searchDirectionConditions = []
    const searchDirectionValues = []
    let sdParamIndex = 1

    if (['buy', 'sell'].includes(direction)) {
      searchDirectionConditions.push(`t.direction = $${sdParamIndex}`)
      searchDirectionValues.push(direction)
      sdParamIndex++
    }
    if (search) {
      searchDirectionConditions.push(`(
        t.id::text ILIKE $${sdParamIndex} OR
        t.account_id::text ILIKE $${sdParamIndex} OR
        a.user_id::text ILIKE $${sdParamIndex} OR
        t.instrument ILIKE $${sdParamIndex}
      )`)
      searchDirectionValues.push(`%${search}%`)
      sdParamIndex++
    }

    const conditions = [...searchDirectionConditions]
    const values = [...searchDirectionValues]
    let paramIndex = sdParamIndex

    if (['open', 'pending', 'closed'].includes(status)) {
      conditions.push(`t.status = $${paramIndex}`)
      values.push(status)
      paramIndex++
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const searchDirectionWhereClause = searchDirectionConditions.length > 0 ? `WHERE ${searchDirectionConditions.join(' AND ')}` : ''

    const [countResult, breakdownResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${whereClause}`,
        values
      ),
      pool.query(
        `SELECT t.status, COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id ${searchDirectionWhereClause} GROUP BY t.status`,
        searchDirectionValues
      )
    ])
    const totalItems = parseInt(countResult.rows[0]?.count || 0, 10)
    const summary = { total: totalItems, open: 0, pending: 0, closed: 0 }
    for (const row of breakdownResult.rows) {
      if (row.status === 'open') summary.open = parseInt(row.count, 10)
      else if (row.status === 'pending') summary.pending = parseInt(row.count, 10)
      else summary.closed += parseInt(row.count, 10)
    }

    const limitParam = paramIndex
    const offsetParam = paramIndex + 1
    const result = await pool.query(
      `SELECT t.id,
              t.account_id,
              a.user_id,
              t.instrument AS symbol,
              UPPER(t.direction) AS type,
              t.lot_size AS lots,
              t.open_price,
              t.close_price,
              t.stop_loss AS sl,
              t.take_profit AS tp,
              t.status,
              t.demo_pnl,
              t.commission,
              p.bid,
              p.ask,
              t.open_time,
              t.close_time
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       ${whereClause}
       ORDER BY
         CASE WHEN t.status = 'open' THEN 0 WHEN t.status = 'pending' THEN 1 ELSE 2 END,
         COALESCE(t.close_time, t.open_time) DESC
       LIMIT $${limitParam} OFFSET $${offsetParam}`,
      [...values, paging.pageSize, (paging.page - 1) * paging.pageSize]
    )

    const rows = result.rows.map(row => {
      let pnl = parseFloat(row.demo_pnl || 0)
      if (row.status === 'open') {
        const livePrice = row.type === 'BUY'
          ? parseFloat(row.bid || row.open_price || 0)
          : parseFloat(row.ask || row.open_price || 0)
        pnl = parseFloat((
          calcTradePnl(
            String(row.type || '').toLowerCase(),
            parseFloat(row.open_price || 0),
            livePrice,
            parseFloat(row.lots || 0),
            row.symbol
          ) - parseFloat(row.commission || 0)
        ).toFixed(2))
      }
      const r_multiple = ['closed', 'cancelled'].includes(row.status)
        ? computeRMultiple({ stop_loss: row.sl, open_price: row.open_price, lot_size: row.lots, demo_pnl: pnl, instrument: row.symbol })
        : null

      return {
        ...row,
        pnl,
        r_multiple
      }
    })

    res.json({
      rows,
      summary,
      pagination: buildPagination({ page: paging.page, pageSize: paging.pageSize, total: totalItems })
    })
  } catch (error) {
    logger.error('Admin trades fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch trades' })
  }
})

router.post('/trades/:tradeId/close', authenticateAdmin, requireAdminCapability('trader:write:scoped'), async function(req, res) {
  const client = await pool.connect()
  try {
    const tradeId = String(req.params.tradeId || '').trim()
    if (!tradeId) return res.status(400).json({ error: 'Valid trade id is required' })

    await client.query('BEGIN')
    const closed = await forceCloseTradeById(client, tradeId, 'Admin Force Close')
    if (!closed) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Trade not found or already closed' })
    }

    try {
      await appendImmutableAudit(client, {
        eventType: 'admin_trade_force_closed',
        entityType: 'trade',
        entityId: String(closed.trade_id),
        payload: {
          account_id: String(closed.account_id),
          instrument: closed.instrument,
          pnl: closed.pnl
        }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    await client.query('COMMIT')

    if (req.app.get('io')) {
      req.app.get('io').to(String(closed.user_id)).emit('account_update', {
        message: `Admin force-closed ${closed.instrument}: ${closed.pnl >= 0 ? '+' : ''}$${closed.pnl.toFixed(2)}`,
        pnl: closed.pnl,
        account_id: closed.account_id,
        event: 'admin_trade_force_closed'
      })
    }

    res.json({
      message: 'Trade force-closed successfully',
      pnl: closed.pnl,
      close_price: closed.close_price
    })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Admin trade force-close error:', { error: error.message })
    res.status(500).json({ error: 'Could not force close trade' })
  } finally {
    client.release()
  }
})

module.exports = router
