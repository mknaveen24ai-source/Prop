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

import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { Socket } from 'socket.io'
import logger = require('./../utils/logger')

type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** @type {Map<string, Set<import('socket.io').Socket>>} */
const byUser = new Map<string, Set<TypedSocket>>()

function register(socket: TypedSocket): void {
  const userId = socket?.data?.userId
  if (!userId) return
  let sockets = byUser.get(userId)
  if (!sockets) {
    sockets = new Set()
    byUser.set(userId, sockets)
  }
  sockets.add(socket)
}

function unregister(socket: TypedSocket): void {
  const userId = socket?.data?.userId
  if (!userId) return
  const sockets = byUser.get(userId)
  if (!sockets) return
  sockets.delete(socket)
  // Drop the empty Set rather than leaving it: users churn, and a Map that only
  // ever grows is a slow leak on a process expected to stay up for weeks.
  if (sockets.size === 0) byUser.delete(userId)
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
function emitToUser<EventName extends keyof ServerToClientEvents>(
  userId: string,
  event: EventName,
  payload: Parameters<ServerToClientEvents[EventName]>[0],
  volatile = false
): number {
  const sockets = byUser.get(String(userId))
  if (!sockets || sockets.size === 0) return 0

  let delivered = 0
  for (const socket of sockets) {
    try {
      const args = [payload] as Parameters<ServerToClientEvents[EventName]>
      if (volatile) socket.volatile.emit(event, ...args)
      else socket.emit(event, ...args)
      delivered++
    } catch (error: unknown) {
      // One bad socket must not stop delivery to the rest of this user's tabs.
      logger.warn('[socketRegistry] emit failed:', { userId, event, error: errorMessage(error) })
    }
  }
  return delivered
}

function hasUser(userId: unknown): boolean {
  return byUser.has(String(userId))
}

function getUserCount(): number {
  return byUser.size
}

function getSocketCount(): number {
  let total = 0
  for (const sockets of byUser.values()) total += sockets.size
  return total
}

function __reset(): void {
  byUser.clear()
}

export {
  register,
  unregister,
  emitToUser,
  hasUser,
  getUserCount,
  getSocketCount,
  __reset
}
