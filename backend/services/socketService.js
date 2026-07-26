'use strict'
/**
 * Socket Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns all Socket.IO configuration that was previously inline in server.js.
 *
 * Exports:
 *   configureSocket(io, pool, deps) — attaches io.use() auth middleware and
 *   io.on('connection', ...) event handlers.
 */

const jwt = require('jsonwebtoken')
const logger = require('../utils/logger')

// ─── Utility ──────────────────────────────────────────────────────────────────
function getCookieValue(cookieHeader, key) {
  if (!cookieHeader || !key) return null
  const parts = String(cookieHeader).split(';')
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=')
    if (k === key) return decodeURIComponent(rest.join('=') || '')
  }
  return null
}

// ─── Auth middleware (io.use) ─────────────────────────────────────────────────
function buildSocketAuthMiddleware(pool) {
  return async function socketAuthMiddleware(socket, next) {
    try {
      const cookieHeader = socket.handshake?.headers?.cookie || ''
      const userToken = socket.handshake?.auth?.token || getCookieValue(cookieHeader, 'token')
      const adminToken = socket.handshake?.auth?.admin_token || getCookieValue(cookieHeader, 'admin_token')

      let userDecoded = null
      let adminDecoded = null

      if (userToken && process.env.JWT_SECRET) {
        try { userDecoded = jwt.verify(userToken, process.env.JWT_SECRET) } catch {}
      }
      if (adminToken && process.env.ADMIN_JWT_SECRET) {
        try {
          const d = jwt.verify(adminToken, process.env.ADMIN_JWT_SECRET)
          if (['admin', 'super_admin'].includes(d?.role)) adminDecoded = d
        } catch {}
      }

      if (!userDecoded && !adminDecoded) {
        throw new Error('Unauthorized socket')
      }

      // FIX (CRITICAL #4): Validate token version against DB to support
      // instant session invalidation (password change, logout all, ban).
      if (userDecoded?.userId) {
        const result = await pool.query(
          'SELECT token_version, is_banned FROM users WHERE id = $1',
          [userDecoded.userId]
        )
        if (result.rows.length === 0) throw new Error('User not found')
        const { token_version, is_banned } = result.rows[0]
        if (is_banned) throw new Error('Account suspended')
        if (userDecoded.tv !== undefined && userDecoded.tv < token_version) {
          throw new Error('Session expired')
        }
        socket.data.userId = String(userDecoded.userId)
        socket.join(socket.data.userId)
        socket.join('prices')
      }

      if (adminDecoded) {
        const result = await pool.query(
          `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
        )
        if (result.rows.length > 0) {
          const serverVersion = parseInt(result.rows[0].value, 10)
          const tokenVersion = adminDecoded.atv || 0
          if (!Number.isNaN(serverVersion) && tokenVersion < serverVersion) {
            throw new Error('Admin session expired')
          }
        }
        socket.data.isAdmin = true
        socket.join('admin')
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// ─── Connection handler (io.on) ───────────────────────────────────────────────
function buildConnectionHandler(pool) {
  return function onConnection(socket) {
    logger.http('Socket connected:', {
      socketId: socket.id,
      isAdmin: socket.data?.isAdmin ? '[admin]' : `[user:${socket.data?.userId}]`
    })

    // ── join_account ──────────────────────────────────────────────────────────
    socket.on('join_account', async function (userId) {
      const requested = String(userId || '').trim()
      if (!requested) return

      if (socket.data?.isAdmin) {
        if (requested === 'admin') {
          socket.join(requested); return
        }

        if (/^\d+$/.test(requested)) {
          try {
            const result = await pool.query(
              `SELECT id FROM users WHERE id = $1 LIMIT 1`,
              [requested]
            )
            if (result.rows.length === 0) {
              socket.emit('auth_error', { error: 'User room not found' }); return
            }
            socket.join(requested); return
          } catch (error) {
            logger.warn('Socket join_account authorization failed:', { error: error.message })
          }
        }

        socket.emit('auth_error', { error: 'Unauthorized room join' }); return
      }

      if (socket.data?.userId && requested === socket.data.userId) {
        socket.join(requested); return
      }

      socket.emit('auth_error', { error: 'Unauthorized room join' })
    })

    // ── join_chat ─────────────────────────────────────────────────────────────
    socket.on('join_chat', async function (conversationId) {
      const parsedConversationId = parseInt(conversationId, 10)
      if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) {
        socket.emit('auth_error', { error: 'Invalid conversation id' }); return
      }

      if (socket.data?.isAdmin) {
        try {
          const result = await pool.query(
            `SELECT id FROM chat_conversations WHERE id = $1 LIMIT 1`,
            [parsedConversationId]
          )
          if (result.rows.length === 0) {
            socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
          }
          socket.join(`chat:${parsedConversationId}`); return
        } catch (error) {
          logger.warn('Socket admin join_chat authorization failed:', { error: error.message })
          socket.emit('auth_error', { error: 'Could not join chat room' }); return
        }
      }

      if (!socket.data?.userId) {
        socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
      }

      try {
        const result = await pool.query(
          `SELECT 1 FROM chat_conversations WHERE id = $1 AND user_id = $2`,
          [parsedConversationId, socket.data.userId]
        )
        if (result.rows.length === 0) {
          socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
        }
        socket.join(`chat:${parsedConversationId}`)
      } catch (error) {
        logger.warn('Socket join_chat authorization failed:', { error: error.message })
        socket.emit('auth_error', { error: 'Could not join chat room' })
      }
    })

    // ── leave_chat ────────────────────────────────────────────────────────────
    socket.on('leave_chat', function (conversationId) {
      const parsedConversationId = parseInt(conversationId, 10)
      if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) return
      socket.leave(`chat:${parsedConversationId}`)
    })

    // ── typing_start ──────────────────────────────────────────────────────────
    socket.on('typing_start', function ({ conversationId, isTyping }) {
      const parsedConversationId = parseInt(conversationId, 10)
      if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) return
      const room = `chat:${parsedConversationId}`
      if (!socket.rooms.has(room)) return
      if (socket.data?.isAdmin) {
        socket.to(room).emit('user_typing', { conversationId: parsedConversationId, isTyping, isAdmin: true })
      } else {
        socket.to(room).emit('user_typing', { conversationId: parsedConversationId, isTyping, userId: socket.data?.userId })
      }
    })

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', function () {
      logger.http('Socket disconnected:', { socketId: socket.id })
    })
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Attaches Socket.IO auth middleware and connection handler to `io`.
 * @param {import('socket.io').Server} io
 * @param {import('pg').Pool} pool
 */
function configureSocket(io, pool) {
  io.use(buildSocketAuthMiddleware(pool))
  io.on('connection', buildConnectionHandler(pool))
  logger.info('[socketService] Socket.IO configured')
}

module.exports = { configureSocket, getCookieValue }
