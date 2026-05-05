/**
 * Redis Token Cache Utility
 * 
 * Caches token versions and ban status to avoid DB hits on every authenticated request.
 * This critical optimization reduces database load from 1000s of queries/sec to near-zero.
 * 
 * Cache keys:
 *   token_version:{userId} → token version (TTL: 5 min)
 *   banned_status:{userId} → is_banned boolean (TTL: 5 min)
 *   tenant_id:{userId} → tenant id (TTL: 5 min)
 */

const redis = require('redis')
const logger = require('./logger')

let redisClient = null
const CACHE_TTL = 5 * 60 // 5 minutes in seconds

/**
 * Initialize Redis connection
 * Safe to call multiple times - returns existing connection if already initialized
 */
async function initializeRedis() {
  if (redisClient) return redisClient

  try {
    redisClient = redis.createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 50, 500)
      }
    })

    redisClient.on('error', (err) => {
      logger.error('Redis error:', { error: err.message })
      // Don't crash server if Redis fails - fall back to DB
    })

    redisClient.on('reconnecting', () => {
      logger.warn('Redis reconnecting...')
    })

    await redisClient.connect()
    logger.info('Redis connected for token caching')
    return redisClient
  } catch (err) {
    logger.error('Failed to initialize Redis:', { error: err.message })
    // If Redis fails, we'll just use DB - performance degrades but auth still works
    return null
  }
}

/**
 * Get cached token data (version + ban status)
 * Falls back to null if cache miss or Redis unavailable
 */
async function getCachedTokenData(userId) {
  if (!redisClient) return null

  try {
    const [version, banned, tenantId] = await Promise.all([
      redisClient.get(`token_version:${userId}`),
      redisClient.get(`banned_status:${userId}`),
      redisClient.get(`tenant_id:${userId}`)
    ])

    if (version !== null) {
      return {
        token_version: parseInt(version, 10),
        is_banned: banned === 'true',
        tenant_id: tenantId !== null && tenantId !== '' ? parseInt(tenantId, 10) : null
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
async function cacheTokenData(userId, tokenVersion, isBanned, tenantId = null) {
  if (!redisClient) return

  try {
    await Promise.all([
      redisClient.setEx(`token_version:${userId}`, CACHE_TTL, tokenVersion.toString()),
      redisClient.setEx(`banned_status:${userId}`, CACHE_TTL, isBanned ? 'true' : 'false'),
      redisClient.setEx(`tenant_id:${userId}`, CACHE_TTL, tenantId == null ? '' : String(tenantId))
    ])
  } catch (err) {
    // Fail silently - cache miss is not critical, just hit DB again
    logger.warn('Failed to cache token data:', { error: err.message })
  }
}

/**
 * Invalidate cached token data for a user
 * Called on logout or password reset
 */
async function invalidateTokenCache(userId) {
  if (!redisClient) return

  try {
    await Promise.all([
      redisClient.del(`token_version:${userId}`),
      redisClient.del(`banned_status:${userId}`),
      redisClient.del(`tenant_id:${userId}`)
    ])
  } catch (err) {
    logger.warn('Failed to invalidate token cache:', { error: err.message })
  }
}

/**
 * Invalidate all cached tokens for a user
 * Called when user logs out across all sessions
 */
async function invalidateAllUserTokens(userId) {
  // Same as invalidateTokenCache - Redis keys already per-user
  await invalidateTokenCache(userId)
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
