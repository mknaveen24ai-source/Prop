/**
 * Socket Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns all Socket.IO configuration that was previously inline in server.js.
 *
 * Exports:
 *   configureSocket(io, pool, deps) — attaches io.use() auth middleware and
 *   io.on('connection', ...) event handlers.
 */

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { QueryResultRow } from 'pg'
import type { Pool } from 'pg'
import type { ExtendedError, Server, Socket } from 'socket.io'
import type { createAdapter as createRedisAdapter } from '@socket.io/redis-adapter'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { BUILT_IN_ROLES } from '../routes/middleware'
import { getRedisClient } from '../utils/tokenCache'
import { isValidUUID } from '../utils/validation'
import { adminClaimsSchema, userClaimsSchema } from '../validation/auth'
import logger = require('../utils/logger')
import * as realtimeFanout from './realtimeFanout'
import * as socketRegistry from './socketRegistry'

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type DatabasePool = Pick<Pool, 'query'>

interface UserSessionRow extends QueryResultRow {
  token_version: number
  is_banned: boolean
}

interface AdminTokenVersionRow extends QueryResultRow {
  value: string
}

interface AdminSessionRow extends QueryResultRow {
  status: string
  token_version: number | string | null
}

interface IdRow extends QueryResultRow {
  id: string | number
}

interface RevalidationSocket {
  id: string
  data: SocketData & { _revalidateTimer?: NodeJS.Timeout | null }
  disconnect: (close?: boolean) => unknown
}

const legacyConversationIdSchema = z.unknown().transform((value, context) => {
  const parsed = parseInt(String(value), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    context.addIssue({ code: 'custom', message: 'Invalid conversation id' })
    return z.NEVER
  }
  return parsed
})

const typingPayloadSchema = z.object({
  conversationId: legacyConversationIdSchema,
  isTyping: z.boolean()
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// How often a live socket re-checks that its session is still good. The
// handshake alone is not enough: a Socket.IO connection can outlive a ban or a
// token_version bump by hours, and until this existed such a socket kept
// receiving price and account events for the whole session.
const SESSION_REVALIDATE_MS = 5 * 60 * 1000

// ─── Utility ──────────────────────────────────────────────────────────────────
function getCookieValue(cookieHeader: unknown, key: unknown): string | null {
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
class SocketSessionError extends Error {
  override name = 'SocketSessionError'
  readonly sessionInvalid = true
}

function sessionError(message: string): SocketSessionError {
  return new SocketSessionError(message)
}

async function assertUserSessionValid(
  pool: DatabasePool,
  userId: string,
  tokenVersion: number | undefined
): Promise<void> {
  const result = await pool.query<UserSessionRow>(
    'SELECT token_version, is_banned FROM users WHERE id = $1',
    [userId]
  )
  const user = result.rows[0]
  if (!user) throw sessionError('User not found')
  const { token_version, is_banned } = user
  if (is_banned) throw sessionError('Account suspended')
  if (tokenVersion !== undefined && tokenVersion < token_version) {
    throw sessionError('Session expired')
  }
}

async function assertAdminSessionValid(
  pool: DatabasePool,
  adminTokenVersion: number | undefined,
  adminId: string | null = null
): Promise<void> {
  const result = await pool.query<AdminTokenVersionRow>(
    `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
  )
  const versionRow = result.rows[0]
  if (versionRow) {
    const serverVersion = parseInt(versionRow.value, 10)
    if (!Number.isNaN(serverVersion) && (adminTokenVersion || 0) < serverVersion) {
      throw sessionError('Admin session expired')
    }
  }

  // FIX (M-05): this only ever checked the GLOBAL admin_token_version, never
  // the per-admin row that authenticateAdmin checks on every HTTP request. So
  // deactivating an admin, or bumping just their token_version, cut off their
  // API access while their socket stayed connected to the `admin` room —
  // still receiving every admin event until they happened to disconnect.
  if (!adminId) return
  const admin = await pool.query<AdminSessionRow>(
    `SELECT status, token_version FROM platform_admins WHERE id = $1`,
    [adminId]
  )
  const adminRow = admin.rows[0]
  if (!adminRow) throw sessionError('Platform admin not found')
  if (adminRow.status !== 'active') throw sessionError('Platform admin account is inactive')
  if ((adminTokenVersion || 0) < parseInt(String(adminRow.token_version || 1), 10)) {
    throw sessionError('Admin session expired')
  }
}

// ─── Auth middleware (io.use) ─────────────────────────────────────────────────
function buildSocketAuthMiddleware(pool: DatabasePool) {
  return async function socketAuthMiddleware(
    socket: TypedSocket,
    next: (error?: ExtendedError) => void
  ): Promise<void> {
    try {
      const cookieHeader = socket.handshake?.headers?.cookie || ''
      const rawAuth: unknown = socket.handshake?.auth
      const auth = isRecord(rawAuth) ? rawAuth : {}
      const userToken = auth.token || getCookieValue(cookieHeader, 'token')
      const adminToken = auth.admin_token || getCookieValue(cookieHeader, 'admin_token')

      let userDecoded: z.infer<typeof userClaimsSchema> | null = null
      let adminDecoded: z.infer<typeof adminClaimsSchema> | null = null

      if (userToken && process.env.JWT_SECRET) {
        try {
          const parsed = userClaimsSchema.safeParse(jwt.verify(String(userToken), process.env.JWT_SECRET))
          if (parsed.success) userDecoded = parsed.data
        } catch {}
      }
      if (adminToken && process.env.ADMIN_JWT_SECRET) {
        try {
          const parsed = adminClaimsSchema.safeParse(
            jwt.verify(String(adminToken), process.env.ADMIN_JWT_SECRET)
          )
          if (!parsed.success) throw new Error('Invalid admin claims')
          const d = parsed.data
          // FIX (C-03): mirrors routes/middleware.js authenticateAdmin. The old
          // literal ['admin', 'super_admin'] check denied every scoped role a
          // realtime channel, so a kyc_reviewer or finance_ops admin got no
          // socket at all. Recognised-role check only; per-action authority
          // still comes from requireAdminCapability on the HTTP routes.
          const role = String(d?.role || '').trim().toLowerCase()
          if (role === 'admin' || BUILT_IN_ROLES.includes(role)) adminDecoded = d
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
        void socket.join(socket.data.userId)
        // Default to receiving every instrument. A client that calls
        // subscribe_instruments is moved out of this room and pays only for what
        // it asked for; one that never does keeps today's behaviour, still as a
        // delta rather than the full map.
        void socket.join(realtimeFanout.ALL_PRICES_ROOM)
      }

      if (adminDecoded) {
        await assertAdminSessionValid(pool, adminDecoded.atv, adminDecoded.adminId)
        socket.data.isAdmin = true
        socket.data.adminTokenVersion = adminDecoded.atv
        // Kept so the periodic re-check can consult the same platform_admins
        // row this handshake was granted against (M-05).
        socket.data.adminId = adminDecoded.adminId || null
        void socket.join('admin')
      }
      next()
    } catch (error: unknown) {
      next(error instanceof Error ? error : new Error(String(error)))
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
 *
 * ── Do not route this through utils/tokenCache ──
 *
 * It looks like an obvious optimisation and it is not. That cache is what the
 * HTTP path reads, and its own documentation names this function as the reason a
 * failed cache invalidation is survivable: HTTP access can go stale for up to
 * CACHE_TTL, but a live WebSocket is cut because THIS check goes straight to the
 * database. Reading the cache here would remove that second line of defence and
 * let a banned trader keep a live feed for the whole TTL.
 *
 * The load it would save does not justify that. One query per socket per five
 * minutes is ~33/second at 10,000 connections — noise next to everything else on
 * the pool, and spread flat by the jitter above.
 */
function startSessionRevalidation(pool: DatabasePool, socket: RevalidationSocket): void {
  const firstDelay = Math.floor(Math.random() * SESSION_REVALIDATE_MS)

  async function revalidate(): Promise<void> {
    try {
      if (socket.data?.userId) {
        await assertUserSessionValid(pool, socket.data.userId, socket.data.tokenVersion)
      }
      if (socket.data?.isAdmin) {
        await assertAdminSessionValid(pool, socket.data.adminTokenVersion, socket.data.adminId)
      }
    } catch (error: unknown) {
      if (!(error instanceof SocketSessionError)) {
        // Database trouble, not a revoked session — leave the socket alone.
        logger.warn('Socket session re-validation could not run:', {
          socketId: socket.id, error: error instanceof Error ? error.message : String(error)
        })
        return
      }
      logger.info('Socket session revoked, disconnecting:', {
        socketId: socket.id,
        userId: socket.data?.userId || null,
        isAdmin: Boolean(socket.data?.isAdmin),
        reason: error.message
      })
      stopSessionRevalidation(socket)
      socket.disconnect(true)
    }
  }

  const timer = setTimeout(function firstRun() {
    void revalidate()
    socket.data._revalidateTimer = setInterval(() => {
      void revalidate()
    }, SESSION_REVALIDATE_MS)
    if (typeof socket.data._revalidateTimer.unref === 'function') {
      socket.data._revalidateTimer.unref()
    }
  }, firstDelay)

  if (typeof timer.unref === 'function') timer.unref()
  socket.data._revalidateTimer = timer
}

function stopSessionRevalidation(socket: RevalidationSocket): void {
  if (!socket.data?._revalidateTimer) return
  clearTimeout(socket.data._revalidateTimer)
  clearInterval(socket.data._revalidateTimer)
  socket.data._revalidateTimer = null
}

// ─── Connection handler (io.on) ───────────────────────────────────────────────
function buildConnectionHandler(pool: DatabasePool) {
  return function onConnection(socket: TypedSocket): void {
    logger.http('Socket connected:', {
      socketId: socket.id,
      isAdmin: socket.data?.isAdmin ? '[admin]' : `[user:${socket.data?.userId}]`
    })

    startSessionRevalidation(pool, socket)
    // Per-user events (equity snapshots) are written straight to local sockets
    // rather than through a room, so the Redis adapter does not turn each one
    // into its own publish. See services/socketRegistry.js.
    socketRegistry.register(socket)

    // ── subscribe_instruments ─────────────────────────────────────────────────
    // Narrows this socket's price feed to the instruments it actually displays:
    // the open chart, the watchlist and whatever it holds positions in. A trader
    // watching one symbol stops being sent the other 44.
    //
    // Unauthenticated by design beyond the handshake — prices are the same
    // public quotes for everyone, so there is nothing to authorise. The only
    // limit is on list length, so one client cannot make the server join
    // thousands of rooms.
    socket.on('subscribe_instruments', function (instruments): void {
      try {
        const rawInstruments: unknown = instruments
        const result = realtimeFanout.setSocketSubscriptions(socket, rawInstruments)
        socket.emit('subscribed_instruments', result)
      } catch (error: unknown) {
        logger.warn('Socket subscribe_instruments failed:', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })

    // ── join_account ──────────────────────────────────────────────────────────
    socket.on('join_account', function (userId): void {
      void (async () => {
        const requested = String(userId || '').trim()
        if (!requested) return

        if (socket.data?.isAdmin) {
          if (requested === 'admin') {
            await socket.join(requested); return
          }

        // UUID, not digits. users.id has been `uuid DEFAULT gen_random_uuid()`
        // since the core schema — the old /^\d+$/ guard is a leftover from the
        // pre-UUID ids and could never match a real user, so every admin
        // join_account fell through to "Unauthorized room join". The membership
        // check below is the actual authorisation; the format check only keeps
        // a malformed id from reaching the query as a cast error.
          if (isValidUUID(requested)) {
            try {
              const result = await pool.query<IdRow>(
                `SELECT id FROM users WHERE id = $1 LIMIT 1`,
                [requested]
              )
              if (result.rows.length === 0) {
                socket.emit('auth_error', { error: 'User room not found' }); return
              }
              await socket.join(requested); return
            } catch (error: unknown) {
              logger.warn('Socket join_account authorization failed:', {
                error: error instanceof Error ? error.message : String(error)
              })
            }
          }

          socket.emit('auth_error', { error: 'Unauthorized room join' }); return
        }

        if (socket.data?.userId && requested === socket.data.userId) {
          await socket.join(requested); return
        }

        socket.emit('auth_error', { error: 'Unauthorized room join' })
      })().catch((error: unknown) => {
        logger.warn('Socket join_account failed:', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    })

    // ── join_chat ─────────────────────────────────────────────────────────────
    socket.on('join_chat', function (conversationId): void {
      void (async () => {
        const parsed = legacyConversationIdSchema.safeParse(conversationId)
        if (!parsed.success) {
          socket.emit('auth_error', { error: 'Invalid conversation id' }); return
        }
        const parsedConversationId = parsed.data

        if (socket.data?.isAdmin) {
          try {
            const result = await pool.query<IdRow>(
              `SELECT id FROM chat_conversations WHERE id = $1 LIMIT 1`,
              [parsedConversationId]
            )
            if (result.rows.length === 0) {
              socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
            }
            await socket.join(`chat:${parsedConversationId}`); return
          } catch (error: unknown) {
            logger.warn('Socket admin join_chat authorization failed:', {
              error: error instanceof Error ? error.message : String(error)
            })
            socket.emit('auth_error', { error: 'Could not join chat room' }); return
          }
        }

        if (!socket.data?.userId) {
          socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
        }

        try {
          const result = await pool.query<QueryResultRow>(
            `SELECT 1 FROM chat_conversations WHERE id = $1 AND user_id = $2`,
            [parsedConversationId, socket.data.userId]
          )
          if (result.rows.length === 0) {
            socket.emit('auth_error', { error: 'Unauthorized chat access' }); return
          }
          await socket.join(`chat:${parsedConversationId}`)
        } catch (error: unknown) {
          logger.warn('Socket join_chat authorization failed:', {
            error: error instanceof Error ? error.message : String(error)
          })
          socket.emit('auth_error', { error: 'Could not join chat room' })
        }
      })().catch((error: unknown) => {
        logger.warn('Socket join_chat failed:', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error)
        })
      })
    })

    // ── leave_chat ────────────────────────────────────────────────────────────
    socket.on('leave_chat', function (conversationId): void {
      const parsed = legacyConversationIdSchema.safeParse(conversationId)
      if (!parsed.success) return
      void socket.leave(`chat:${parsed.data}`)
    })

    // ── typing_start ──────────────────────────────────────────────────────────
    socket.on('typing_start', function (input): void {
      const parsed = typingPayloadSchema.safeParse(input)
      if (!parsed.success) return
      const { conversationId: parsedConversationId, isTyping } = parsed.data
      const room = `chat:${parsedConversationId}`
      if (!socket.rooms.has(room)) return
      if (socket.data?.isAdmin) {
        socket.to(room).emit('user_typing', { conversationId: parsedConversationId, isTyping, isAdmin: true })
      } else {
        const userId = socket.data?.userId
        if (userId) {
          socket.to(room).emit('user_typing', { conversationId: parsedConversationId, isTyping, userId })
        } else {
          socket.to(room).emit('user_typing', { conversationId: parsedConversationId, isTyping })
        }
      }
    })

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on('disconnect', function (): void {
      stopSessionRevalidation(socket)
      socketRegistry.unregister(socket)
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
/**
 * Attach the Redis adapter so rooms and emits cross process boundaries.
 *
 * FIX (H-08): without this, every io.to(userId).emit(...) — SL/TP fills,
 * account_failed, payout_approved — only reaches clients connected to the
 * process that emitted it. With two instances behind a load balancer roughly
 * half of all realtime events are silently lost, and the loss is invisible:
 * nothing errors, traders just stop seeing their own fills.
 *
 * Best-effort by design. A single instance works fine without Redis, so a
 * missing or dead Redis degrades to the previous in-process behaviour with a
 * loud warning rather than refusing to start.
 */
async function attachRedisAdapter(io: TypedServer): Promise<boolean> {
  const client = getRedisClient()
  if (!client) {
    logger.warn('[socketService] No Redis client — Socket.IO is in-process only. ' +
      'Safe on a single instance; realtime events will be lost if you scale out.')
    return false
  }

  try {
    const { createAdapter } = require('@socket.io/redis-adapter') as {
      createAdapter: typeof createRedisAdapter
    }
    // Duplicate rather than reuse: a client in subscriber mode cannot serve
    // the ordinary GET/SETEX calls the token cache makes on the same connection.
    const subClient = client.duplicate()
    const pubClient = client.duplicate()
    subClient.on('error', (err: Error) => logger.error('Socket.IO Redis sub error:', { error: err.message }))
    pubClient.on('error', (err: Error) => logger.error('Socket.IO Redis pub error:', { error: err.message }))
    await Promise.all([subClient.connect(), pubClient.connect()])
    io.adapter(createAdapter(pubClient, subClient))
    logger.info('[socketService] Socket.IO Redis adapter attached — rooms span instances')
    return true
  } catch (error: unknown) {
    logger.error('[socketService] Could not attach Redis adapter — staying in-process:', {
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

function configureSocket(io: TypedServer, pool: DatabasePool): void {
  const authenticate = buildSocketAuthMiddleware(pool)
  io.use((socket, next) => {
    void authenticate(socket, next)
  })
  io.on('connection', buildConnectionHandler(pool))
  logger.info('[socketService] Socket.IO configured')
}

export {
  attachRedisAdapter,
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
