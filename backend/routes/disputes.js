const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')

// POST /api/disputes/submit
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user
    const { account_id, reason, description } = req.body

    if (!account_id || !reason || !description) {
      return res.status(400).json({ error: 'All fields are required.' })
    }

    // Verify account belongs to user and is failed/expired
    const accountCheck = await pool.query(
      `SELECT status FROM accounts WHERE id = $1 AND user_id = $2`,
      [account_id, userId]
    )
    if (accountCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found or belongs to another user.' })
    }
    const accStatus = accountCheck.rows[0].status
    if (!['failed', 'expired'].includes(accStatus)) {
      return res.status(400).json({ error: 'Only failed or expired accounts can be disputed.' })
    }

    const result = await pool.query(
      `INSERT INTO disputes (user_id, account_id, reason, description, status)
       VALUES ($1, $2, $3, $4, 'open')
       RETURNING id, status, created_at`,
      [userId, account_id, reason, description]
    )

    res.json({ message: 'Dispute submitted successfully', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Submit dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit dispute' })
  }
})

// GET /api/disputes/my-disputes
router.get('/my-disputes', authenticateToken, async (req, res) => {
  try {
    const { userId } = req.user
    const result = await pool.query(
      `SELECT d.*, a.account_size, a.status as account_status
       FROM disputes d
       JOIN accounts a ON d.account_id = a.id
       WHERE d.user_id = $1
       ORDER BY d.created_at DESC`,
      [userId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Fetch my-disputes error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch disputes' })
  }
})

module.exports = router
