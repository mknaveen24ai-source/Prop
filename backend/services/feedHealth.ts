/**
 * Price-feed circuit breaker.
 * ─────────────────────────────────────────────────────────────────────────────
 * The asymmetry this fixes:
 *
 *   routes/trades/open.js  — refuses an order when the quote is >10s old
 *   routes/trades/close.js — refuses a close when the quote is >10s old
 *   services/tradeEngine.js — no staleness guard at all; marks every open
 *                             position against whatever the cache holds and
 *                             fails accounts on it
 *
 * So during a feed stall — the exact moment it is most likely to happen, a fast
 * market — a trader cannot close (correctly refused as stale) while the engine
 * keeps evaluating breaches against a frozen mark. When the feed resumes and
 * prices gap, a wave of accounts fails on marks nobody could act on, and each
 * of those traders has the platform's own "price feed is currently delayed"
 * error message proving they tried to get out.
 *
 * ── Why the threshold is shared, not merely similar ──
 *
 * STALE_THRESHOLD_MS is exported and used by BOTH the trading routes and the
 * engine. If enforcement suspended at a LATER threshold than trading refuses,
 * the gap between the two is precisely the window described above. Equal
 * thresholds mean the moment a trader can no longer act is the moment the
 * platform can no longer fail them. Two constants that merely happen to both
 * say 10000 would drift; one constant cannot.
 *
 * ── Fail-safe direction ──
 *
 * If feed age cannot be determined at all, the feed is treated as UNHEALTHY and
 * enforcement suspends. Declining to fail an account on data we cannot vouch
 * for is recoverable; failing one on data we cannot vouch for is not.
 */

import type { QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('../utils/logger')
import * as priceCache from '../utils/priceCache'
import { emitAdminEvent } from '../utils/realtime'

interface FeedAgeRow extends QueryResultRow {
  newest: Date | string | null
}

interface FeedHealth {
  healthy: boolean
  ageMs: number | null
  reason: string | null
}

interface FeedAgeCache {
  ageMs: number | null
  at: number
}

interface SuspensionState {
  suspended: boolean
  since: string | null
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

// Shared with routes/trades/open.js and routes/trades/close.js.
const STALE_THRESHOLD_MS = 10000

// The DB fallback is only consulted when the in-memory cache cannot answer, and
// memoised briefly so a 1s engine cadence cannot turn it into a per-pass query.
const DB_AGE_CACHE_MS = 1000
let _dbAgeCache: FeedAgeCache = { ageMs: null, at: 0 }

let _suspended = false
let _suspendedSince: Date | null = null

async function getFeedAgeMs(): Promise<number | null> {
  // Fast path: the event pipeline keeps this warm.
  const cacheAge = priceCache.getPriceCacheAgeMs()
  if (cacheAge != null && cacheAge <= STALE_THRESHOLD_MS) return cacheAge

  const now = Date.now()
  if (_dbAgeCache.at && (now - _dbAgeCache.at) < DB_AGE_CACHE_MS) {
    return _dbAgeCache.ageMs
  }

  try {
    const result = await pool.query<FeedAgeRow>(`SELECT MAX(updated_at) AS newest FROM price_feed`)
    const newest = result.rows[0]?.newest
    const ageMs = newest ? (Date.now() - new Date(newest).getTime()) : null
    _dbAgeCache = { ageMs, at: now }
    return ageMs
  } catch (error: unknown) {
    logger.error('[feed-health] Could not read feed age', { error: errorMessage(error) })
    _dbAgeCache = { ageMs: null, at: now }
    return null
  }
}

/**
 * @returns {Promise<{healthy: boolean, ageMs: number|null, reason: string|null}>}
 */
async function checkFeedHealth(): Promise<FeedHealth> {
  const ageMs = await getFeedAgeMs()

  if (ageMs == null) {
    return { healthy: false, ageMs: null, reason: 'Price feed age is unknown' }
  }
  if (ageMs > STALE_THRESHOLD_MS) {
    return { healthy: false, ageMs, reason: `Price feed is ${Math.round(ageMs / 1000)}s stale` }
  }
  return { healthy: true, ageMs, reason: null }
}

/**
 * Health check with edge-triggered logging and admin notification.
 *
 * Transitions are announced once, not once per pass — an engine loop running at
 * 1s would otherwise emit sixty identical alarms a minute during an outage, and
 * an alarm that repeats that often is one operators learn to filter out.
 */
async function checkFeedHealthWithAlerting(): Promise<FeedHealth> {
  const health = await checkFeedHealth()

  if (!health.healthy && !_suspended) {
    _suspended = true
    _suspendedSince = new Date()
    logger.error('[feed-health] SUSPENDING breach enforcement — price feed unhealthy', {
      reason: health.reason, ageMs: health.ageMs
    })
    emitAdminEvent('feed_health_changed', {
      healthy: false, reason: health.reason, age_ms: health.ageMs,
      suspended_since: _suspendedSince.toISOString()
    })
  } else if (health.healthy && _suspended) {
    const outageMs = _suspendedSince ? Date.now() - _suspendedSince.getTime() : null
    logger.warn('[feed-health] Price feed recovered — resuming breach enforcement', {
      outageMs, ageMs: health.ageMs
    })
    emitAdminEvent('feed_health_changed', {
      healthy: true, reason: null, age_ms: health.ageMs, outage_ms: outageMs
    })
    _suspended = false
    _suspendedSince = null
  }

  return health
}

/** Current state, for the trader-facing banner and the health endpoint. */
function getSuspensionState(): SuspensionState {
  return {
    suspended: _suspended,
    since: _suspendedSince ? _suspendedSince.toISOString() : null
  }
}

/** Test seam. */
function __reset(): void {
  _suspended = false
  _suspendedSince = null
  _dbAgeCache = { ageMs: null, at: 0 }
}

export {
  STALE_THRESHOLD_MS,
  getFeedAgeMs,
  checkFeedHealth,
  checkFeedHealthWithAlerting,
  getSuspensionState,
  __reset
}
