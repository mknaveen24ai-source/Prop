/**
 * routes/copier.js
 *
 * Admin API routes for controlling the trade copier.
 * Mount in your main server: app.use('/api/admin', require('./routes/copier'))
 */

'use strict'

const express = require('express')
const router  = express.Router()
const pool    = require('../db')
const { authenticateAdmin } = require('./middleware')
const logger = require('../utils/logger')

// ─────────────────────────────────────────────────────────────────────────────
// Ensure copier settings columns exist
// ─────────────────────────────────────────────────────────────────────────────
async function ensureCopierSettings() {
  const defaults = [
    ['copier_enabled',         'true'],
    ['copier_mode',            'mirror'],   // 'mirror' | 'reverse'
    ['copier_lot_multiplier',  '1.0'],
    ['copier_only_funded',     'true'],
  ]
  for (const [key, value] of defaults) {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, value]
    ).catch(() => {})
  }
}
// FIX (HIGH #7): Export both router and function for server startup.
// This will be placed at the END of the file after all routes are defined.
// module.exports = { router, ensureCopierSettings }  <-- Moved to end of file

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/copier/status
// Returns current copier config + live stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/copier/status', authenticateAdmin, async (req, res) => {
  try {
    const settings = await pool.query(
      `SELECT key, value FROM platform_settings WHERE key LIKE 'copier_%'`
    )
    const cfg = {}
    settings.rows.forEach(r => { cfg[r.key] = r.value })

    // Live stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE t.status = 'open') as open_trades,
        COUNT(*) FILTER (WHERE t.status = 'closed' AND t.close_time >= NOW() - INTERVAL '1 hour') as closed_last_hour,
        COUNT(*) FILTER (WHERE t.status = 'closed' AND t.close_time >= NOW() - INTERVAL '24 hours') as closed_last_24h
      FROM trades t
      JOIN accounts a ON t.account_id = a.id
      WHERE ($1 = 'false' OR a.account_type = 'funded')
    `, [cfg.copier_only_funded || 'true'])

    res.json({
      config: {
        enabled:        cfg.copier_enabled        !== 'false',
        mode:           cfg.copier_mode           || 'mirror',
        lot_multiplier: parseFloat(cfg.copier_lot_multiplier || '1.0'),
        only_funded:    cfg.copier_only_funded    !== 'false',
      },
      stats: stats.rows[0]
    })
  } catch (err) {
    logger.error('[copier/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not fetch copier status' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/copier/config
// Update copier settings
// Body: { enabled, mode, lot_multiplier, only_funded }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/copier/config', authenticateAdmin, async (req, res) => {
  try {
    const { enabled, mode, lot_multiplier, only_funded } = req.body

    if (mode !== undefined && !['mirror', 'reverse'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "mirror" or "reverse"' })
    }
    if (lot_multiplier !== undefined) {
      const lm = parseFloat(lot_multiplier)
      if (isNaN(lm) || lm <= 0 || lm > 10) {
        return res.status(400).json({ error: 'lot_multiplier must be between 0.01 and 10' })
      }
    }

    const updates = {}
    if (enabled        !== undefined) updates.copier_enabled        = String(Boolean(enabled))
    if (mode           !== undefined) updates.copier_mode           = mode
    if (lot_multiplier !== undefined) updates.copier_lot_multiplier = String(parseFloat(lot_multiplier))
    if (only_funded    !== undefined) updates.copier_only_funded    = String(Boolean(only_funded))

    for (const [key, value] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO platform_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, value]
      )
    }

    logger.info('[ADMIN] Copier config updated:', { updates })
    res.json({ message: 'Copier config saved', config: updates })
  } catch (err) {
    logger.error('[copier/config] error:', { error: err.message })
    res.status(500).json({ error: 'Could not save copier config' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/copier/open-trades
// Returns trades currently being watched (open funded trades)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/copier/open-trades', authenticateAdmin, async (req, res) => {
  try {
    const onlyFunded = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'copier_only_funded'`
    )
    const fundedOnly = onlyFunded.rows[0]?.value !== 'false'

    const result = await pool.query(`
      SELECT t.id, t.instrument, t.direction, t.lot_size,
             t.open_price, t.stop_loss, t.take_profit,
             t.open_time, a.account_type, u.email,
             CASE 
               WHEN a.account_type IN ('phase1', 'phase2') THEN 'reverse'
               ELSE 'mirror'
             END AS copier_action
      FROM   trades t
      JOIN   accounts a ON a.id = t.account_id
      JOIN   users    u ON u.id = a.user_id
      WHERE  t.status = 'open'
        -- Business model update: allow copying phase 1/2 if they are to be reversed
        AND ($1 = false OR a.account_type IN ('phase1', 'phase2', 'funded'))
      ORDER  BY t.open_time DESC
      LIMIT  200
    `, [fundedOnly])

    res.json(result.rows)
  } catch (err) {
    logger.error('[copier/open-trades] error:', { error: err.message })
    res.status(500).json({ error: 'Could not fetch open trades' })
  }
})

// FIX (HIGH #7): Export both router and ensureCopierSettings function
module.exports = { router, ensureCopierSettings }
