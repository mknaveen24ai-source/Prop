/**
 * Redis Token Caching - Setup and Migration
 * 
 * FIX (C2): Redis Token Caching
 * ─────────────────────────────────────────────────────────────────────────
 * 
 * PROBLEM:
 * - Token version checked against database on EVERY authenticated request
 * - At scale: 1000s of requests/sec = 1000s of DB queries/sec
 * - Database connection pool exhaustion under load
 * - User logout takes seconds instead of milliseconds
 * 
 * SOLUTION:
 * - Cache token version + ban status in Redis with 5-minute TTL
 * - Invalidate cache on logout/password reset for sub-millisecond effect
 * - Fall back to database if Redis unavailable (graceful degradation)
 * 
 * PERFORMANCE IMPROVEMENT:
 * - Before: Every request hits database (10-50ms latency per request)
 * - After: Cache hit = 1-2ms, cache miss = 10-50ms
 * - At 1000 RPS: ~99% cache hit rate during normal operation
 * - ~100x reduction in database load (from token checks)
 * ─────────────────────────────────────────────────────────────────────────
 */

// ============================================================================
// SETUP INSTRUCTIONS
// ============================================================================

/*
STEP 1: Install Redis (if not already installed)

  On macOS:
    brew install redis
    brew services start redis

  On Ubuntu/Debian:
    sudo apt-get install redis-server
    sudo systemctl start redis-server

  On Windows:
    Download from: https://github.com/microsoftarchive/redis/releases
    Or use Docker: docker run -d -p 6379:6379 redis:alpine

  On Docker Compose (recommended for containers):
    Add to docker-compose.yml:
    
      redis:
        image: redis:7-alpine
        ports:
          - "6379:6379"
        volumes:
          - redis_data:/data
        
    volumes:
      redis_data:
    
    Then: docker-compose up -d


STEP 2: Update .env file

  Add or update:
    REDIS_URL=redis://localhost:6379
  
  For production with password:
    REDIS_URL=redis://:your-password@redis-host:6379
  
  For Redis on different port:
    REDIS_URL=redis://localhost:6380
  
  For Redis Cluster or Sentinel, use appropriate connection string


STEP 3: Test Redis Connection

  cd backend
  node -e "
    const redis = require('redis');
    const client = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    client.connect().then(() => {
      console.log('✓ Redis connected');
      process.exit(0);
    }).catch(err => {
      console.error('✗ Redis connection failed:', err.message);
      process.exit(1);
    });
  "


STEP 4: Restart Server

  npm run dev
  
  You should see in logs:
    "✓ Redis connected for token caching"
  
  If Redis unavailable, you'll see:
    "Redis error: ..." (but server continues with database fallback)


STEP 5: Verify It's Working

  Authentication requests should now use cache (1-2ms instead of 50ms)
  
  Check Redis keys:
    redis-cli
    > KEYS "token_version:*"
    > KEYS "banned_status:*"
  
  Both should show cached entries (until 5-min TTL expires)

*/

// ============================================================================
// FILES CHANGED
// ============================================================================

/*
NEW FILES:
  - utils/tokenCache.js
    Redis caching utilities for token validation

MODIFIED FILES:
  - server.js
    • Added Redis import
    • Initialize Redis on startup
    • Graceful Redis shutdown on SIGTERM
    
  - routes/middleware.js
    • Import tokenCache utilities
    • Check Redis cache before DB query
    • Populate cache after DB lookup
    
  - routes/auth.js
    • Import invalidateTokenCache
    • Invalidate cache on /logout
    • Invalidate cache on /logout-all
    • Invalidate cache on /reset-password

*/

// ============================================================================
// HOW IT WORKS
// ============================================================================

/*
CACHE FLOW:

1. User Makes Authenticated Request:
   GET /api/trades/open
   Authorization: Bearer <JWT_TOKEN>

2. Middleware (authenticateToken) Receives Request:
   a. Decode JWT locally (fast, no I/O)
   b. Get cached token data from Redis (if available, 1-2ms)
   c. If cache miss:
      - Query database (10-50ms)
      - Populate Redis cache (set TTL to 5 min)
   d. Check token_version and ban status
   e. Allow/deny request

3. Cache Keys in Redis:
   key: "token_version:{userId}"
   value: "{token_version_number}"
   TTL: 5 minutes
   
   key: "banned_status:{userId}"
   value: "true" or "false"
   TTL: 5 minutes

4. Cache Invalidation:
   When user:
     - Logs out: invalidate cache immediately (instant logout)
     - Logs out from all devices: invalidate cache immediately
     - Resets password: invalidate cache (old tokens invalid)
   
   Then on next request:
     - Cache miss (entry deleted)
     - Hits database (picks up new token_version)
     - Populates fresh cache for next 5 minutes


GRACEFUL DEGRADATION:

If Redis becomes unavailable:
  - Middleware detects Redis error
  - Falls back to database query
  - Performance degrades but authentication still works
  - Logs warning message for ops team
  - Server continues operating normally

This means:
  - Single Redis failure doesn't crash authentication
  - No downtime even if Redis node offline
  - Performance gradually improves as Redis recovers
*/

// ============================================================================
// MONITORING & OPERATIONS
// ============================================================================

/*
MONITOR CACHE PERFORMANCE:

1. Check Cache Hit Rate:
   redis-cli
   > INFO stats
   
   Look for:
   - keyspace_hits: Cache lookups that hit
   - keyspace_misses: Cache lookups that missed
   
   Good health: >90% hit rate after initial requests

2. Monitor Cache Size:
   redis-cli
   > DBSIZE
   
   Should be <1000 keys (one per active user + one for status)
   ~2KB per user, so <2MB even with 1000 users

3. Check TTL:
   redis-cli
   > TTL token_version:{userId}
   
   Should show 300 (5 minutes) if recently accessed
   Shows -1 if key has no expiry
   Shows -2 if key doesn't exist

4. Manual Cache Invalidation (for testing):
   # Logout all users immediately:
   redis-cli > FLUSHDB
   
   # This disconnects all users (they must log in again)


ALERTS TO SET UP:

  - Redis connection lost → Alert ops team
  - Redis CPU >80% → Check for excessive key eviction
  - Redis memory >90% → Increase memory or reduce TTL
  - Redis response time >50ms → Check network latency

*/

// ============================================================================
// TROUBLESHOOTING
// ============================================================================

/*
Q: Redis pool exhaustion error?
A: Redis default is 10 connections. Increase in redis-cli config:
   maxclients 100000
   // But first check if app creating too many connections

Q: "Redis connection failed: ECONNREFUSED"?
A: Redis server not running. Check:
   - ps aux | grep redis (Linux)
   - brew services list (macOS)
   - Services tab (Windows)
   - docker ps | grep redis (Docker)

Q: "Redis timeout error"?
A: Network latency too high. Check:
   - Latency: redis-cli --latency
   - If >10ms, check network configuration
   - Try connecting locally first

Q: Cache not working (still slow)?
A: Verify Redis is initialized:
   - Check logs for "✓ Redis connected"
   - Manually check: redis-cli > KEYS *
   - If no keys, Redis might not be running
   - Restart server: npm run dev

Q: Want to disable Redis caching?
A: Comment out initializeRedis() in server.js
   Server will work via database only (slower but functional)

*/

// ============================================================================
// NEXT STEPS
// ============================================================================

/*
After deploying Redis token caching:

1. Monitor for 1 week
   - Check cache hit rate
   - Monitor database query count
   - Verify logout is instant

2. If hit rate <80%, investigate:
   - Are tokens expiring naturally?
   - Are users staying logged in long enough?
   - Adjust TTL if needed (currently 5 min)

3. Load test with Redis vs without
   - Measure: requests/sec with cache
   - Compare: requests/sec without cache
   - Baseline should be ~100x improvement

4. Consider Redis persistence
   If using in production:
   - Enable AOF (Append Only File)
   - Enable RDB (Redis Database snapshots)
   - Setup Redis replication for HA

*/

// ============================================================================
// RELATED DOCUMENTATION
// ============================================================================

/*
See also:
  - utils/tokenCache.js - Implementation details
  - routes/middleware.js - Cache usage in auth
  - ALL_BUGS_AND_ISSUES.md - Full C2 description
  - Redis documentation: https://redis.io/docs/
*/
