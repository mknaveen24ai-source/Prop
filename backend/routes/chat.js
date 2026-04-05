// Live Chat Support Routes
const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateToken, authenticateAdmin } = require('./middleware')
const rateLimit = require('express-rate-limit')
const logger = require('../utils/logger')

// Rate limiter for chat messages
const chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: { error: 'Too many messages. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
})

// Create chat conversations table
async function ensureChatTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id                BIGSERIAL PRIMARY KEY,
      user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject           TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'open',
      assigned_to       UUID REFERENCES users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_message_at   TIMESTAMPTZ,
      unread_user_count INTEGER NOT NULL DEFAULT 0,
      unread_admin_count INTEGER NOT NULL DEFAULT 0
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
      message         TEXT NOT NULL,
      is_admin        BOOLEAN NOT NULL DEFAULT false,
      sender_name     TEXT NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at         TIMESTAMPTZ,
      attachments     JSONB DEFAULT '[]'::jsonb
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON chat_messages(created_at DESC)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_conversations_user_id_idx ON chat_conversations(user_id)
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_conversations_status_idx ON chat_conversations(status)
  `)
}

// User endpoints
router.post('/conversations', authenticateToken, chatMessageLimiter, async function(req, res) {
  try {
    await ensureChatTables()
    const { subject } = req.body

    if (!subject || subject.trim().length < 3) {
      return res.status(400).json({ error: 'Subject must be at least 3 characters' })
    }

    const userId = req.user.userId

    // Check for existing open conversations
    const existingOpen = await pool.query(
      `SELECT id FROM chat_conversations WHERE user_id = $1 AND status = 'open' LIMIT 1`,
      [userId]
    )

    if (existingOpen.rows.length > 0) {
      return res.status(400).json({
        error: 'You already have an open conversation. Please continue in your existing chat.',
        conversationId: existingOpen.rows[0].id
      })
    }

    const result = await pool.query(
      `INSERT INTO chat_conversations (user_id, subject, last_message_at)
       VALUES ($1, $2, NOW()) RETURNING *`,
      [userId, subject.trim()]
    )

    res.status(201).json({
      message: 'Chat conversation created',
      conversation: result.rows[0]
    })
  } catch (error) {
    logger.error('Create conversation error:', { error: error.message })
    res.status(500).json({ error: 'Could not create conversation' })
  }
})

// Get user's conversations
router.get('/conversations', authenticateToken, async function(req, res) {
  try {
    await ensureChatTables()
    const userId = req.user.userId
    const result = await pool.query(
      `SELECT c.*,
              (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
              (SELECT message FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
       FROM chat_conversations c
       WHERE c.user_id = $1
       ORDER BY c.created_at DESC`,
      [userId]
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch conversations' })
  }
})

// Get single conversation with messages
router.get('/conversations/:id', authenticateToken, async function(req, res) {
  try {
    await ensureChatTables()
    const userId = req.user.userId
    const { id } = req.params

    // Verify ownership
    const convResult = await pool.query(
      `SELECT id, user_id, subject, status, assigned_to, created_at, updated_at,
              last_message_at, unread_user_count, unread_admin_count
       FROM chat_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const messagesResult = await pool.query(
      `SELECT id, conversation_id, user_id, message, is_admin, sender_name,
              created_at, read_at, attachments
       FROM chat_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    )

    // Mark admin messages as read
    await pool.query(
      `UPDATE chat_messages SET read_at = NOW()
       WHERE conversation_id = $1 AND is_admin = true AND read_at IS NULL`,
      [id]
    )

    // Reset unread count
    await pool.query(
      `UPDATE chat_conversations SET unread_admin_count = 0 WHERE id = $1`,
      [id]
    )

    res.json({
      conversation: convResult.rows[0],
      messages: messagesResult.rows
    })
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch conversation' })
  }
})

// Send message in conversation
router.post('/conversations/:id/messages', authenticateToken, chatMessageLimiter, async function(req, res) {
  try {
    await ensureChatTables()
    const userId = req.user.userId
    const { id } = req.params
    const { message } = req.body

    if (!message || message.trim().length < 1) {
      return res.status(400).json({ error: 'Message cannot be empty' })
    }

    // Verify ownership or active conversation
    const convResult = await pool.query(
      `SELECT id, user_id, subject, status, assigned_to, created_at, updated_at,
              last_message_at
       FROM chat_conversations WHERE id = $1 AND user_id = $2`,
      [id, userId]
    )

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const conversation = convResult.rows[0]

    // Don't allow messages on closed conversations
    if (conversation.status === 'closed') {
      return res.status(400).json({ error: 'Cannot send messages to a closed conversation' })
    }

    const user = await pool.query('SELECT full_name FROM users WHERE id = $1', [userId])
    const senderName = user.rows[0]?.full_name || 'User'

    const messageResult = await pool.query(
      `INSERT INTO chat_messages (conversation_id, user_id, message, is_admin, sender_name)
       VALUES ($1, $2, $3, false, $4) RETURNING *`,
      [id, userId, message.trim(), senderName]
    )

    // Update conversation timestamps
    await pool.query(
      `UPDATE chat_conversations 
       SET last_message_at = NOW(), updated_at = NOW(), unread_user_count = 0
       WHERE id = $1`,
      [id]
    )

    // Emit WebSocket event
    const io = req.app.get('io')
    if (io) {
      io.to('admin').emit('chat_new_message', {
        conversation_id: parseInt(id),
        message: messageResult.rows[0],
        conversation_subject: conversation.subject
      })
      io.to(`chat:${id}`).emit('chat_message_received', {
        conversation_id: parseInt(id),
        message: messageResult.rows[0]
      })
    }

    res.status(201).json({ message: 'Message sent', messageData: messageResult.rows[0] })
  } catch (error) {
    logger.error('Send message error:', { error: error.message })
    res.status(500).json({ error: 'Could not send message' })
  }
})

// Close conversation (user)
router.patch('/conversations/:id/close', authenticateToken, async function(req, res) {
  try {
    await ensureChatTables()
    const userId = req.user.userId
    const { id } = req.params

    const result = await pool.query(
      `UPDATE chat_conversations
       SET status = 'closed', updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({ message: 'Conversation closed', conversation: result.rows[0] })
  } catch (error) {
    res.status(500).json({ error: 'Could not close conversation' })
  }
})

// Admin endpoints
router.get('/admin/conversations', authenticateAdmin, async function(req, res) {
  try {
    await ensureChatTables()
    const { status, page = 1, limit = 20 } = req.query
    
    let query = `
      SELECT c.*, 
             u.email as user_email,
             u.full_name as user_name,
             (SELECT COUNT(*) FROM chat_messages WHERE conversation_id = c.id) as message_count,
             (SELECT message FROM chat_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM chat_conversations c
      JOIN users u ON c.user_id = u.id
    `
    
    const conditions = []
    const values = []
    let paramIndex = 1

    if (status) {
      conditions.push(`c.status = $${paramIndex}`)
      values.push(status)
      paramIndex++
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ')
    }

    query += ' ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC'
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`
    values.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit))

    const result = await pool.query(query, values)
    
    const countQuery =
      `SELECT COUNT(*) FROM chat_conversations` +
      (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '')
    const countValues = status ? [status] : []
    const countResult = await pool.query(countQuery, countValues)

    res.json({
      conversations: result.rows,
      total: parseInt(countResult.rows[0]?.count || 0),
      page: parseInt(page),
      limit: parseInt(limit)
    })
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch conversations' })
  }
})

// Admin get conversation
router.get('/admin/conversations/:id', authenticateAdmin, async function(req, res) {
  try {
    await ensureChatTables()
    const { id } = req.params

    const convResult = await pool.query(
      `SELECT c.id, c.user_id, c.subject, c.status, c.assigned_to, c.created_at,
              c.updated_at, c.last_message_at, c.unread_user_count, c.unread_admin_count,
              u.email as user_email, u.full_name as user_name
       FROM chat_conversations c
       JOIN users u ON c.user_id = u.id
       WHERE c.id = $1`,
      [id]
    )

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const messagesResult = await pool.query(
      `SELECT id, conversation_id, user_id, message, is_admin, sender_name,
              created_at, read_at, attachments
       FROM chat_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id]
    )

    // Mark user messages as read
    await pool.query(
      `UPDATE chat_messages SET read_at = NOW() 
       WHERE conversation_id = $1 AND is_admin = false AND read_at IS NULL`,
      [id]
    )

    // Reset unread count
    await pool.query(
      `UPDATE chat_conversations SET unread_user_count = 0 WHERE id = $1`,
      [id]
    )

    res.json({
      conversation: convResult.rows[0],
      messages: messagesResult.rows
    })
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch conversation' })
  }
})

// Admin send message
router.post('/admin/conversations/:id/messages', authenticateAdmin, chatMessageLimiter, async function(req, res) {
  try {
    await ensureChatTables()
    const { id } = req.params
    const { message } = req.body

    if (!message || message.trim().length < 1) {
      return res.status(400).json({ error: 'Message cannot be empty' })
    }

    const convResult = await pool.query(
      `SELECT id, user_id, subject, status, assigned_to, created_at, updated_at,
              last_message_at
       FROM chat_conversations WHERE id = $1`,
      [id]
    )

    if (convResult.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    const conversation = convResult.rows[0]

    if (conversation.status === 'closed') {
      return res.status(400).json({ error: 'Cannot send messages to a closed conversation' })
    }

    const senderName = 'Support'

    const messageResult = await pool.query(
      `INSERT INTO chat_messages (conversation_id, user_id, message, is_admin, sender_name)
       VALUES ($1, $2, $3, true, $4) RETURNING *`,
      [id, null, message.trim(), senderName]
    )

    // Update conversation
    await pool.query(
      `UPDATE chat_conversations
       SET last_message_at = NOW(), updated_at = NOW(), unread_admin_count = 0
       WHERE id = $1`,
      [id]
    )

    // Emit WebSocket event to user
    const io = req.app.get('io')
    if (io) {
      io.to(String(conversation.user_id)).emit('chat_new_message', {
        conversation_id: parseInt(id),
        message: messageResult.rows[0],
        conversation_subject: conversation.subject
      })
      io.to(`chat:${id}`).emit('chat_message_received', {
        conversation_id: parseInt(id),
        message: messageResult.rows[0]
      })
    }

    res.status(201).json({ message: 'Message sent', messageData: messageResult.rows[0] })
  } catch (error) {
    logger.error('Admin send message error:', { error: error.message })
    res.status(500).json({ error: 'Could not send message' })
  }
})

// Admin update conversation status
router.patch('/admin/conversations/:id', authenticateAdmin, async function(req, res) {
  try {
    await ensureChatTables()
    const { id } = req.params
    const { status, assigned_to } = req.body

    const validStatuses = ['open', 'pending', 'resolved', 'closed']
    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    const updates = []
    const values = []
    let paramIndex = 1

    if (status) {
      updates.push(`status = $${paramIndex}`)
      values.push(status)
      paramIndex++
    }

    if (assigned_to) {
      updates.push(`assigned_to = $${paramIndex}`)
      values.push(assigned_to)
      paramIndex++
    }

    updates.push(`updated_at = NOW()`)

    const result = await pool.query(
      `UPDATE chat_conversations 
       SET ${updates.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      [...values, id]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({ message: 'Conversation updated', conversation: result.rows[0] })
  } catch (error) {
    res.status(500).json({ error: 'Could not update conversation' })
  }
})

// Admin get stats
router.get('/admin/chat-stats', authenticateAdmin, async function(req, res) {
  try {
    await ensureChatTables()
    
    const stats = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM chat_conversations WHERE status = 'open') as open_count,
        (SELECT COUNT(*) FROM chat_conversations WHERE status = 'pending') as pending_count,
        (SELECT COUNT(*) FROM chat_conversations WHERE status = 'resolved') as resolved_count,
        (SELECT COUNT(*) FROM chat_conversations WHERE status = 'closed') as closed_count,
        (SELECT COUNT(*) FROM chat_conversations WHERE unread_admin_count > 0) as unread_count,
        (SELECT COUNT(*) FROM chat_messages WHERE is_admin = false AND created_at > NOW() - INTERVAL '24 hours') as messages_24h
    `)

    res.json(stats.rows[0])
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch stats' })
  }
})

module.exports = router
module.exports.ensureChatTables = ensureChatTables
