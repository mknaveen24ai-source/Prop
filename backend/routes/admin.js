const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin } = require('./middleware')
const jwt = require('jsonwebtoken')
require('dotenv').config()

router.post('/login', async function(req, res) {
  try {
    const { password } = req.body

    if (password !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid admin password' })
    }

    const token = jwt.sign(
      { role: 'admin' },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    )

    res.json({ message: 'Admin login successful', token })

  } catch (error) {
    res.status(500).json({ error: 'Admin login error' })
  }
})

router.get('/overview', authenticateAdmin, async function(req, res) {
  try {
    const accounts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase1') AS phase1_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase2') AS phase2_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded') AS funded_active,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE status = 'passed') AS total_passed,
        COUNT(*) FILTER (WHERE status = 'expired') AS total_expired
       FROM accounts`
    )

    const users = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE kyc_status = 'pending') AS kyc_pending,
        COUNT(*) FILTER (WHERE kyc_status = 'approved') AS kyc_approved
       FROM users`
    )

    const pnl = await pool.query(
      `SELECT
        COALESCE(SUM(demo_pnl), 0) AS total_demo_pnl,
        COALESCE(SUM(broker_pnl), 0) AS total_broker_pnl,
        COUNT(*) FILTER (WHERE status = 'closed') AS total_closed_trades,
        COUNT(*) FILTER (WHERE status = 'open') AS total_open_trades
       FROM trades`
    )

    const payouts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS total_paid_out
       FROM payouts`
    )

    res.json({
      accounts: accounts.rows[0],
      users: users.rows[0],
      trading: pnl.rows[0],
      payouts: payouts.rows[0]
    })

  } catch (error) {
    console.error('Admin overview error:', error.message)
    res.status(500).json({ error: 'Could not fetch overview' })
  }
})

router.get('/traders', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, country, phone, kyc_status,
        is_banned, affiliate_code, created_at
       FROM users ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch traders' })
  }
})

router.post('/kyc/approve', authenticateAdmin, async function(req, res) {
  try {
    const { user_id } = req.body

    await pool.query(
      `UPDATE users SET kyc_status = 'approved' WHERE id = $1`,
      [user_id]
    )

    res.json({ message: 'KYC approved successfully' })
  } catch (error) {
    res.status(500).json({ error: 'Could not approve KYC' })
  }
})

router.post('/kyc/reject', authenticateAdmin, async function(req, res) {
  try {
    const { user_id } = req.body

    await pool.query(
      `UPDATE users SET kyc_status = 'rejected' WHERE id = $1`,
      [user_id]
    )

    res.json({ message: 'KYC rejected' })
  } catch (error) {
    res.status(500).json({ error: 'Could not reject KYC' })
  }
})

router.post('/ban', authenticateAdmin, async function(req, res) {
  try {
    const { user_id } = req.body

    await pool.query(
      `UPDATE users SET is_banned = true WHERE id = $1`,
      [user_id]
    )

    res.json({ message: 'Trader banned successfully' })
  } catch (error) {
    res.status(500).json({ error: 'Could not ban trader' })
  }
})

router.post('/unban', authenticateAdmin, async function(req, res) {
  try {
    const { user_id } = req.body

    await pool.query(
      `UPDATE users SET is_banned = false WHERE id = $1`,
      [user_id]
    )

    res.json({ message: 'Trader unbanned successfully' })
  } catch (error) {
    res.status(500).json({ error: 'Could not unban trader' })
  }
})

router.get('/accounts', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT a.*, u.email, u.full_name
       FROM accounts a
       JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

router.get('/payouts', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT p.*, u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.requested_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch payouts' })
  }
})

router.post('/payouts/mark-paid', authenticateAdmin, async function(req, res) {
  try {
    const { payout_id, transaction_id } = req.body

    await pool.query(
      `UPDATE payouts SET
       status = 'paid',
       paid_at = NOW(),
       transaction_id = $1
       WHERE id = $2`,
      [transaction_id, payout_id]
    )

    res.json({ message: 'Payout marked as paid' })
  } catch (error) {
    res.status(500).json({ error: 'Could not update payout' })
  }
})

module.exports = router
