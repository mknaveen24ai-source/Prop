const express = require('express')
const jwt = require('jsonwebtoken')
const rateLimit = require('express-rate-limit')

const pool = require('../db')
const logger = require('../utils/logger')
const {
  authenticateAdmin,
  authenticateToken
} = require('./middleware')
const {
  normalizeSupportReplyPayload,
  normalizeSupportTicketPayload
} = require('../utils/supportValidation')

const router = express.Router()
const adminRouter = express.Router()

const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many support requests. Wait before retrying.' },
  standardHeaders: true,
  legacyHeaders: false
})

function optionalUserAuth(req, _res, next) {
  const token = req.cookies?.token || (req.headers.authorization || '').split(' ')[1]
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET) } catch {}
  }
  next()
}

router.post('/ticket', supportLimiter, optionalUserAuth, async function(req, res) {
  try {
    const userId = req.user?.userId
    const normalized = normalizeSupportTicketPayload(req.body, {
      email: req.user?.email,
      name: req.user?.full_name
    })
    if (normalized.errors.length > 0) {
      return res.status(400).json({ error: normalized.errors.join('; ') })
    }
    const { category, subject, message, email, name } = normalized.value

    await pool.query(
      `INSERT INTO support_tickets (user_id, email, name, category, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId || null, email, name, category, subject, message]
    )
    res.status(201).json({ message: 'Support ticket submitted successfully' })
  } catch (error) {
    logger.error('Support ticket error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit support ticket' })
  }
})

async function loadUserSupportTickets(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, category, subject, message, status, created_at
       FROM support_tickets
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Load support tickets error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch tickets' })
  }
}

router.get('/tickets', authenticateToken, loadUserSupportTickets)
router.get('/my-tickets', authenticateToken, loadUserSupportTickets)

router.get('/ticket/:id', authenticateToken, async function(req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' })
    }

    const ticketResult = await pool.query(
      `SELECT id, user_id, category, subject, message, status, created_at
       FROM support_tickets
       WHERE id = $1 AND user_id = $2`,
      [ticketId, req.user.userId]
    )
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' })
    }

    const messagesResult = await pool.query(
      `SELECT id, sender_type, sender_name, message, created_at
       FROM support_ticket_messages
       WHERE ticket_id = $1
       ORDER BY created_at ASC, id ASC`,
      [ticketId]
    )

    res.json({
      ticket: ticketResult.rows[0],
      messages: messagesResult.rows
    })
  } catch (error) {
    logger.error('Load support ticket detail error:', { error: error.message })
    res.status(500).json({ error: 'Could not load ticket thread' })
  }
})

router.post('/ticket/:id/reply', authenticateToken, async function(req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' })
    }

    const normalized = normalizeSupportReplyPayload(req.body)
    if (normalized.errors.length > 0) {
      return res.status(400).json({ error: normalized.errors.join('; ') })
    }
    const { message } = normalized.value

    const ticketResult = await pool.query(
      `SELECT id, status
       FROM support_tickets
       WHERE id = $1 AND user_id = $2`,
      [ticketId, req.user.userId]
    )
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' })
    }
    if (ticketResult.rows[0].status === 'closed') {
      return res.status(400).json({ error: 'Closed tickets cannot receive new replies' })
    }

    const replyResult = await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message)
       VALUES ($1, 'user', $2, $3)
       RETURNING id, sender_type, sender_name, message, created_at`,
      [ticketId, 'You', message]
    )

    res.status(201).json({
      message: 'Reply sent successfully',
      reply: replyResult.rows[0]
    })
  } catch (error) {
    logger.error('Support ticket reply error:', { error: error.message })
    res.status(500).json({ error: 'Could not send reply' })
  }
})

adminRouter.get('/support-tickets', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT * FROM support_tickets
       ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Admin support tickets fetch error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch tickets' })
  }
})

adminRouter.patch('/support-tickets/:id', authenticateAdmin, async function(req, res) {
  try {
    const { status } = req.body
    if (!['open', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const result = await pool.query(
      `UPDATE support_tickets
          SET status = $1
        WHERE id = $2
        RETURNING *`,
      [status, req.params.id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    res.json({ message: 'Ticket updated', ticket: result.rows[0] })
  } catch (error) {
    logger.error('Admin support ticket update error:', { error: error.message })
    res.status(500).json({ error: 'Could not update ticket' })
  }
})

module.exports = {
  router,
  adminRouter
}
