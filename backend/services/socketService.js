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

// How often a live socket re-checks that its session is still good. The
// handshake alone is not enough: a Socket.IO connection can outlive a ban or a
// token_version bump by hours, and until this existed such a socket kept
// receiving price and account events for the whole session.
const SESSION_REVALIDATE_MS = 5 * 60 * 1000

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

// ─── Session validation ───────────────────────────────────────────────────────
// Used by both the handshake and the periodic re-check below, so the two can
// never drift apart on what counts as a valid session.
//
// A rejection carries sessionInvalid = true. Anything else escaping these
// (a dropped pool connection, say) is an infrastructure fault, and the periodic
// check deliberately keeps the socket open for those rather than mass-
// disconnecting every trader because the database blipped.
function sessionError(message) {
  const err = new Error(message)
  err.sessionInvalid = true
  return err
}

async function assertUserSessionValid(pool, userId, tokenVersion) {
  const result = await pool.query(
    'SELECT token_version, is_banned FROM users WHERE id = $1',
    [userId]
  )
  if (result.rows.length === 0) throw sessionError('User not found')
  const { token_version, is_banned } = result.rows[0]
  if (is_banned) throw sessionError('Account suspended')
  if (tokenVersion !== undefined && tokenVersion < token_version) {
    throw sessionError('Session expired')
  }
}

async function assertAdminSessionValid(pool, adminTokenVersion) {
  const result = await pool.query(
    `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
  )
  if (result.rows.length === 0) return
  const serverVersion = parseInt(result.rows[0].value, 10)
  if (!Number.isNaN(serverVersion) && (adminTokenVersion || 0) < serverVersion) {
    throw sessionError('Admin session expired')
  }
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
        await assertUserSessionValid(pool, userDecoded.userId, userDecoded.tv)
        socket.data.userId = String(userDecoded.userId)
        // Kept so the periodic re-check can compare against the same version
        // this handshake was granted on.
        socket.data.tokenVersion = userDecoded.tv
        socket.join(socket.data.userId)
        socket.join('prices')
      }

      if (adminDecoded) {
        await assertAdminSessionValid(pool, adminDecoded.atv)
        socket.data.isAdmin = true
        socket.data.adminTokenVersion = adminDecoded.atv
        socket.join('admin')
      }
      next()
    } catch (err) {
      next(err)
    }
  }
}

// ─── Periodic session re-validation ───────────────────────────────────────────
/**
 * Re-runs the handshake's session checks every SESSION_REVALIDATE_MS for as
 * long as the socket is open, so a ban or a token_version bump takes effect
 * within five minutes instead of surviving until the client reconnects.
 *
 * The first tick is jittered across the window: without it every socket
 * connected during a restart would re-query in the same instant, which at a few
 * thousand traders is a self-inflicted thundering herd on the pool.
 */
function startSessionRevalidation(pool, socket) {
  const firstDelay = Math.floor(Math.random() * SESSION_REVALIDATE_MS)

  async function revalidate() {
    try {
      if (socket.data?.userId) {
        await assertUserSessionValid(pool, socket.data.userId, socket.data.tokenVersion)
      }
      if (socket.data?.isAdmin) {
        await assertAdminSessionValid(pool, socket.data.adminTokenVersion)
      }
    } catch (err) {
      if (!err.sessionInvalid) {
        // Database trouble, not a revoked session — leave the socket alone.
        logger.warn('Socket session re-validation could not run:', {
          socketId: socket.id, error: err.message
        })
        return
      }
      logger.info('Socket session revoked, disconnecting:', {
        socketId: socket.id,
        userId: socket.data?.userId || null,
        isAdmin: Boolean(socket.data?.isAdmin),
        reason: err.message
      })
      stopSessionRevalidation(socket)
      socket.disconnect(true)
    }
  }

  const timer = setTimeout(function firstRun() {
    revalidate()
    socket.data._revalidateTimer = setInterval(revalidate, SESSION_REVALIDATE_MS)
    if (typeof socket.data._revalidateTimer.unref === 'function') {
      socket.data._revalidateTimer.unref()
    }
  }, firstDelay)

  if (typeof timer.unref === 'function') timer.unref()
  socket.data._revalidateTimer = timer
}

function stopSessionRevalidation(socket) {
  if (!socket.data?._revalidateTimer) return
  clearTimeout(socket.data._revalidateTimer)
  clearInterval(socket.data._revalidateTimer)
  socket.data._revalidateTimer = null
}

// ─── Connection handler (io.on) ───────────────────────────────────────────────
function buildConnectionHandler(pool) {
  return function onConnection(socket) {
    logger.http('Socket connected:', {
      socketId: socket.id,
      isAdmin: socket.data?.isAdmin ? '[admin]' : `[user:${socket.data?.userId}]`
    })

    startSessionRevalidation(pool, socket)

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
      stopSessionRevalidation(socket)
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

module.exports = {
  configureSocket,
  getCookieValue,
  SESSION_REVALIDATE_MS,
  // Exported for test/socketRevalidation.test.js — the handshake and the
  // periodic re-check share these, so testing them covers both paths.
  assertUserSessionValid,
  assertAdminSessionValid,
  startSessionRevalidation,
  stopSessionRevalidation
}
