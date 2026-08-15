/**
 * Redis Token Cache Utility
 * 
 * Caches token versions and ban status to avoid DB hits on every authenticated request.
 * This critical optimization reduces database load from 1000s of queries/sec to near-zero.
 * 
 * Cache keys:
 *   token_version:{userId} → token version (TTL: 5 min)
 *   banned_status:{userId} → is_banned boolean (TTL: 5 min)
 */

const redis = require('redis')
const logger = require('./logger')

let redisClient = null
let redisInitPromise = null
const CACHE_TTL = 5 * 60 // 5 minutes in seconds

/**
 * Initialize Redis connection
 * Safe to call multiple times - returns existing connection if already initialized
 */
async function initializeRedis() {
  if (redisClient) return redisClient
  if (redisInitPromise) return redisInitPromise

  redisInitPromise = (async () => {
    let candidate = null
    try {
      candidate = redis.createClient({
        url: process.env.REDIS_URL || 'redis://localhost:6379',
        socket: {
          connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '3000', 10) || 3000,
          reconnectStrategy: (retries) => (retries >= 2 ? false : Math.min(retries * 50, 500))
        }
      })

      candidate.on('error', (err) => {
        logger.error('Redis error:', { error: err.message })
        // Don't crash server if Redis fails - fall back to DB
      })

      candidate.on('reconnecting', () => {
        logger.warn('Redis reconnecting...')
      })

      await candidate.connect()
      redisClient = candidate
      logger.info('Redis connected for token caching')
      return redisClient
    } catch (err) {
      logger.error('Failed to initialize Redis:', { error: err.message })
      if (candidate) {
        try {
          candidate.destroy()
        } catch {}
      }
      redisClient = null
      // If Redis fails, we'll just use DB - performance degrades but auth still works
      return null
    } finally {
      redisInitPromise = null
    }
  })()

  return redisInitPromise
}

/**
 * Get cached token data (version + ban status)
 * Falls back to null if cache miss or Redis unavailable
 */
async function getCachedTokenData(userId) {
  if (!redisClient) return null

  try {
    const [version, banned] = await Promise.all([
      redisClient.get(`token_version:${userId}`),
      redisClient.get(`banned_status:${userId}`)
    ])

    if (version !== null) {
      return {
        token_version: parseInt(version, 10),
        is_banned: banned === 'true'
      }
    }
    return null
  } catch (err) {
    logger.warn('Redis cache get failed, falling back to DB:', { error: err.message })
    return null
  }
}

/**
 * Set cached token data
 * Called after database lookup to populate cache
 */
async function cacheTokenData(userId, tokenVersion, isBanned) {
  if (!redisClient) return

  try {
    await Promise.all([
      redisClient.setEx(`token_version:${userId}`, CACHE_TTL, tokenVersion.toString()),
      redisClient.setEx(`banned_status:${userId}`, CACHE_TTL, isBanned ? 'true' : 'false')
    ])
  } catch (err) {
    // Fail silently - cache miss is not critical, just hit DB again
    logger.warn('Failed to cache token data:', { error: err.message })
  }
}

/**
 * Invalidate cached token data for a user.
 * Called on logout, password reset, and ban.
 *
 * Unlike a failed read or write, a failed invalidation is not a performance
 * problem — it is a security one. authenticateToken trusts this cache, so a
 * DEL that silently fails leaves `banned_status:<id>` reading 'false' for the
 * rest of CACHE_TTL and the user keeps HTTP access for up to five more minutes.
 * That is why this logs at error level and reports success back to the caller,
 * rather than warning like the get/set paths do.
 *
 * The blast radius is bounded in two ways: the entries expire on their own via
 * CACHE_TTL, and socketService re-validates against the database directly
 * rather than through this cache, so live WebSocket sessions are unaffected.
 *
 * @returns {Promise<boolean>} true if the cache is known to be clear (including
 *   when Redis is not configured at all, where there is nothing to clear).
 */
async function invalidateTokenCache(userId) {
  if (!redisClient) return true

  try {
    await Promise.all([
      redisClient.del(`token_version:${userId}`),
      redisClient.del(`banned_status:${userId}`)
    ])
    return true
  } catch (err) {
    logger.error('Failed to invalidate token cache — stale session may persist until TTL:', {
      userId: String(userId),
      ttlSeconds: CACHE_TTL,
      error: err.message
    })
    return false
  }
}

/**
 * Invalidate all cached tokens for a user
 * Called when user logs out across all sessions
 *
 * @returns {Promise<boolean>} see invalidateTokenCache
 */
async function invalidateAllUserTokens(userId) {
  // Same as invalidateTokenCache - Redis keys already per-user
  return invalidateTokenCache(userId)
}

/**
 * Get metrics about cache performance (for monitoring)
 */
async function getCacheStats() {
  if (!redisClient) {
    return {
      status: 'unavailable',
      message: 'Redis not initialized'
    }
  }

  try {
    const info = await redisClient.info('stats')
    return {
      status: 'active',
      info
    }
  } catch (err) {
    return {
      status: 'error',
      error: err.message
    }
  }
}

/**
 * Close Redis connection (for graceful shutdown)
 */
async function closeRedis() {
  if (redisClient) {
    try {
      await redisClient.quit()
      redisClient = null
      logger.info('Redis connection closed')
    } catch (err) {
      logger.error('Error closing Redis:', { error: err.message })
    }
  }
}

module.exports = {
  initializeRedis,
  getCachedTokenData,
  cacheTokenData,
  invalidateTokenCache,
  invalidateAllUserTokens,
  getCacheStats,
  closeRedis
}
