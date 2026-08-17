'use strict'
/**
 * Local socket registry
 * ─────────────────────────────────────────────────────────────────────────────
 * Maps `userId → the sockets for that user ON THIS PROCESS`, so per-user events
 * can be written straight to the connections that exist here.
 *
 * ── Why not just use rooms ──
 *
 * `io.to(userId).emit(...)` looks equivalent and is not, once the Redis adapter
 * is attached (services/socketService.js attaches it whenever Redis is
 * available, including on single-instance deployments). Every room emit is
 * published to Redis and fanned to every node, because the adapter cannot know
 * which node holds that room without asking.
 *
 * That is fine at a few hundred events a second. Equity updates are not a few
 * hundred: the engine emits a snapshot per account whose numbers moved, and at
 * 100K open positions one tick touches thousands of accounts. Turning each of
 * those into a Redis publish makes the adapter — not the engine, not the
 * database — the thing that falls over first.
 *
 * So per-user delivery goes through this registry (local, synchronous, no
 * serialisation beyond the one socket write), and cross-node delivery is done
 * ONCE per tick as a single batched publish (services/realtimeFanout.js) rather
 * than once per recipient.
 *
 * Rooms are still the right tool for price fan-out, where the same bytes go to
 * many sockets and the adapter's single-publish-per-room is exactly what you
 * want. This is only about the per-user path.
 */

const logger = require('./../utils/logger')

/** @type {Map<string, Set<import('socket.io').Socket>>} */
const _byUser = new Map()

function register(socket) {
  const userId = socket?.data?.userId
  if (!userId) return
  let sockets = _byUser.get(userId)
  if (!sockets) {
    sockets = new Set()
    _byUser.set(userId, sockets)
  }
  sockets.add(socket)
}

function unregister(socket) {
  const userId = socket?.data?.userId
  if (!userId) return
  const sockets = _byUser.get(userId)
  if (!sockets) return
  sockets.delete(socket)
  // Drop the empty Set rather than leaving it: users churn, and a Map that only
  // ever grows is a slow leak on a process expected to stay up for weeks.
  if (sockets.size === 0) _byUser.delete(userId)
}

/**
 * Write an event to every local socket for a user.
 *
 * @param {string} userId
 * @param {string} event
 * @param {object} payload
 * @param {boolean} [volatile] Drop the frame for clients that are behind rather
 *   than buffering it. Correct for equity snapshots — the next tick carries a
 *   fresher number, so a queued stale one has negative value.
 * @returns {number} sockets written to
 */
function emitToUser(userId, event, payload, volatile = false) {
  const sockets = _byUser.get(String(userId))
  if (!sockets || sockets.size === 0) return 0

  let delivered = 0
  for (const socket of sockets) {
    try {
      if (volatile) socket.volatile.emit(event, payload)
      else socket.emit(event, payload)
      delivered++
    } catch (error) {
      // One bad socket must not stop delivery to the rest of this user's tabs.
      logger.warn('[socketRegistry] emit failed:', { userId, event, error: error.message })
    }
  }
  return delivered
}

function hasUser(userId) {
  return _byUser.has(String(userId))
}

function getUserCount() {
  return _byUser.size
}

function getSocketCount() {
  let total = 0
  for (const sockets of _byUser.values()) total += sockets.size
  return total
}

function __reset() {
  _byUser.clear()
}

module.exports = {
  register,
  unregister,
  emitToUser,
  hasUser,
  getUserCount,
  getSocketCount,
  __reset
}
