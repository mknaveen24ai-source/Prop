const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')

const PAGE_SIZE = 50

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notifications
// The trader's own persisted notification history (user_notifications,
// migration 025). Distinct from GET /api/admin/notifications, which is the
// admin-side broadcast composer's queue — this is the read-side a trader's
// own dashboard bell consumes so history survives a localStorage clear and
// syncs across devices/tabs.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, type, title, message, read, created_at
         FROM user_notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [req.user.userId, PAGE_SIZE]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Fetch notifications error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch notifications' })
  }
})

router.post('/mark-all-read', authenticateToken, async function(req, res) {
  try {
    await pool.query(
      `UPDATE user_notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [req.user.userId]
    )
    res.json({ success: true })
  } catch (error) {
    logger.error('Mark notifications read error:', { error: error.message })
    res.status(500).json({ error: 'Could not update notifications' })
  }
})

router.delete('/', authenticateToken, async function(req, res) {
  try {
    await pool.query(`DELETE FROM user_notifications WHERE user_id = $1`, [req.user.userId])
    res.json({ success: true })
  } catch (error) {
    logger.error('Clear notifications error:', { error: error.message })
    res.status(500).json({ error: 'Could not clear notifications' })
  }
})

module.exports = router
