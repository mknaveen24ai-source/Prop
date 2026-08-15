/**
 * Security utilities for PropFirm
 * Security headers, rate limiting, and other security middleware
 */

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const logger = require('./logger');

// express-rate-limit v7+ exports `ipKeyGenerator` as a named export and
// requires you to route IP keys through it rather than using a bare
// (req) => req.ip, which trips ERR_ERL_KEY_GEN_IPV6 at startup because IPv6
// addresses need normalising to a /56 subnet before they can be used as a key.
//
// IT TAKES THE IP STRING, NOT THE REQUEST. Calling ipKeyGenerator(req) returns
// the request object itself, and because MemoryStore keys off a Map, every
// request then lands in its own bucket under a unique object identity -- the
// limiter accepts everything and silently enforces nothing. That is how
// apiLimiter and passwordResetLimiter below ended up disabled. Always pass
// req.ip; test/rateLimitKeys.test.js guards this.
const { ipKeyGenerator } = require('express-rate-limit');

// ─────────────────────────────────────────────────────────────────────────────
// FIX (H-04): shared Redis-backed rate-limit store
// ─────────────────────────────────────────────────────────────────────────────
// Every limiter in this app used express-rate-limit's default MemoryStore, so
// every counter lived in one process's heap. Three consequences, all bad:
//
//   1. Limits reset on every deploy, restart or crash. The payout limiter is
//      "1 request per 24 hours" — a restart handed every trader a fresh one.
//   2. With N instances behind a load balancer the effective limit is N x the
//      configured value, silently.
//   3. Nothing survived a process swap mid-attack.
//
// Nginx's limit_req zones give a real per-IP floor, but nothing enforced the
// per-USER limits that matter for payout and trading abuse.
//
// createLimiter() injects a Redis store when Redis is up and falls back to
// MemoryStore with a loud warning when it is not — a single instance with no
// Redis still works exactly as before, rather than failing to boot.
//
// Limiters are constructed while modules are still being required — long before
// startServer() calls initializeRedis(). So the store cannot capture a client at
// construction time; it resolves one per command instead, and degrades to an
// in-process MemoryStore for as long as Redis is down.
let _warnedNoRedis = false;

function makeSharedStore(prefix) {
  const { getRedisClient } = require('./tokenCache');
  const { RedisStore } = require('rate-limit-redis');

  const memoryFallback = new rateLimit.MemoryStore();
  const redisStore = new RedisStore({
    prefix: `rl:${prefix}:`,
    // async, not a bare throw: RedisStore.init() calls sendCommand to load its
    // increment script and awaits the result, so a synchronous throw escapes as
    // an unhandled rejection and takes the process down at require time.
    sendCommand: async (...args) => {
      const client = getRedisClient();
      if (!client) throw new Error('Redis client not connected yet');
      return client.sendCommand(args);
    }
  });

  let initOptions = null;
  let redisReady = false;

  function warnOnce(error) {
    if (_warnedNoRedis) return;
    _warnedNoRedis = true;
    logger.warn(
      '[security] Rate limiting fell back to in-process counters: ' + error.message + '. ' +
      'Safe on a single instance; limits reset on restart and multiply by instance count if you scale out.'
    );
  }

  // RedisStore.init() loads a Lua script and caches its SHA; until that
  // succeeds, increment() cannot work. Module load happens long before
  // initializeRedis(), so the first attempt always fails — this retries it on
  // demand, once Redis is actually up, instead of leaving every limiter
  // permanently stuck on the memory fallback.
  async function ensureRedisReady() {
    if (redisReady) return true;
    if (!getRedisClient()) return false;
    await redisStore.init(initOptions);
    redisReady = true;
    return true;
  }

  // Delegating wrapper rather than a hard choice at boot: Redis coming back
  // after a blip silently restores shared counting.
  return {
    init(options) {
      initOptions = options;
      // MemoryStore.init() resets the window, so it is called exactly once here
      // and never again. Re-initialising it per request (as an earlier version
      // did) reset the counter on every call, which meant the fallback counted
      // to one forever and enforced nothing — and tripped express-rate-limit's
      // ERR_ERL_DOUBLE_COUNT validator.
      memoryFallback.init(options);
    },
    async increment(key) {
      try {
        if (!(await ensureRedisReady())) throw new Error('Redis client not connected yet');
        return await redisStore.increment(key);
      } catch (error) {
        redisReady = false;
        warnOnce(error);
        return memoryFallback.increment(key);
      }
    },
    async decrement(key) {
      try {
        if (!(await ensureRedisReady())) throw new Error('redis-unavailable');
        return await redisStore.decrement(key);
      } catch { return memoryFallback.decrement(key); }
    },
    async resetKey(key) {
      try {
        if (!(await ensureRedisReady())) throw new Error('redis-unavailable');
        return await redisStore.resetKey(key);
      } catch { return memoryFallback.resetKey(key); }
    }
  };
}

/**
 * rateLimit() with the shared Redis-backed store attached.
 *
 * @param {string} name     stable identifier used as the Redis key prefix.
 *                          Changing it resets that limiter's counters.
 * @param {object} options  anything express-rate-limit accepts
 */
function createLimiter(name, options = {}) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
    // Tests run without Redis and assert on counting behaviour directly;
    // MemoryStore is both correct and faster there.
    ...(process.env.NODE_ENV === 'test' ? {} : { store: makeSharedStore(name) })
  });
}

// Enhanced security headers configuration
const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
});

// Trading operations rate limiter (stricter than general API)
const tradingLimiter = createLimiter('trading', {
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 trades per minute per user
  message: { error: 'Too many trading requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId || ipKeyGenerator(req.ip);
  }
});

// API endpoint rate limiter
const apiLimiter = createLimiter('api', {
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many API requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip for static files and health checks
    return req.path.startsWith('/uploads/') || req.path === '/';
  },
  keyGenerator: (req) => ipKeyGenerator(req.ip)
});

// Password reset rate limiter
const passwordResetLimiter = createLimiter('password-reset', {
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 password reset attempts per 15 minutes
  message: { error: 'Too many password reset attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // FIX: Key on IP, not email. Keying on req.body.email lets an attacker rotate
  // through different email addresses to bypass per-email limits while still
  // probing the same target. IP is the right unit of isolation here.
  keyGenerator: (req) => ipKeyGenerator(req.ip)
});

// KYC submission rate limiter
const kycLimiter = createLimiter('kyc', {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 KYC submissions per hour
  message: { error: 'Too many KYC submissions. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req.ip)
});

// Payout request rate limiter
const payoutLimiter = createLimiter('payout', {
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 payout requests per hour
  message: { error: 'Too many payout requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req.ip)
});

// File upload security middleware
const fileUploadSecurity = (req, res, next) => {
  // Check file size (10MB limit)
  if (req.file && req.file.size > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'File too large. Maximum size is 10MB.' });
  }

  // Check file type for images
  if (req.file && req.file.mimetype.startsWith('image/')) {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Invalid image type. Only JPEG, PNG, GIF, and WebP are allowed.' });
    }
  }

  // Check for malicious file patterns
  if (req.file && req.file.originalname) {
    const dangerousPatterns = [
      /\.(exe|bat|cmd|scr|pif|com|js|vbs|jar|sh|php|asp|aspx|jsp)$/i,
      /\b(executable|script|malware|virus)\b/i
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(req.file.originalname)) {
        logger.warn('Malicious file upload attempt:', {
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
          ip: req.ip,
          userId: req.user?.userId
        });
        return res.status(400).json({ error: 'Invalid file type.' });
      }
    }
  }

  next();
};

// IP-based blocking for repeated abuse
const abusiveIPs = new Map()
const MAX_ABUSIVE_IPS = 10000
const ABUSIVE_IP_TTL = 60 * 60 * 1000 // 1 hour

// FIX (BUG-M1): Server-side per-IP request counter — replaces the old approach
// that read the client-controlled X-Request-Count header, which attackers could
// freely set to any value to manipulate the abuse detector.
const ipRequestCounts = new Map()
const IP_BLOCK_THRESHOLD = 600 // requests per minute before auto-block
const ipRequestCountsResetTimer = setInterval(() => { ipRequestCounts.clear() }, 60 * 1000) // reset every minute
if (typeof ipRequestCountsResetTimer.unref === 'function') {
  ipRequestCountsResetTimer.unref()
}

// FIX (HIGH #5): Periodic cleanup of expired abusive IP entries to prevent
// unbounded memory growth in long-running servers.
const ABUSIVE_IPS_CLEANUP_INTERVAL = 10 * 60 * 1000 // 10 minutes
const abusiveIpsCleanupTimer = setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [ip, entry] of abusiveIPs.entries()) {
    if (now > entry.expiresAt) {
      abusiveIPs.delete(ip)
      cleaned++
    }
  }
  if (cleaned > 0) {
    logger.info('Abusive IPs periodic cleanup:', { cleaned, remaining: abusiveIPs.size })
  }
}, ABUSIVE_IPS_CLEANUP_INTERVAL)
if (typeof abusiveIpsCleanupTimer.unref === 'function') {
  abusiveIpsCleanupTimer.unref()
}

const abuseDetector = (req, res, next) => {
  const clientIP = req.ip || 'unknown'

  // Check if IP is in abusive list
  if (abusiveIPs.has(clientIP)) {
    const entry = abusiveIPs.get(clientIP)
    if (Date.now() > entry.expiresAt) {
      // TTL expired, remove from map
      abusiveIPs.delete(clientIP)
    } else {
      return res.status(429).json({
        error: 'Access temporarily blocked due to suspicious activity.'
      })
    }
  }

  // Clean up old entries if map is getting too large
  if (abusiveIPs.size > MAX_ABUSIVE_IPS) {
    const now = Date.now()
    for (const [ip, entry] of abusiveIPs.entries()) {
      if (now > entry.expiresAt) {
        abusiveIPs.delete(ip)
      }
    }
    // If still over limit, remove oldest entries
    if (abusiveIPs.size > MAX_ABUSIVE_IPS) {
      const entries = Array.from(abusiveIPs.entries())
        .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      const toRemove = Math.floor(abusiveIPs.size * 0.2) // Remove 20%
      for (let i = 0; i < toRemove; i++) {
        abusiveIPs.delete(entries[i][0])
      }
      logger.warn('Abusive IPs map cleaned:', { remainingSize: abusiveIPs.size, removed: toRemove })
    }
  }

  // FIX (BUG-M1): Server-side counter — NOT reading any client-supplied header.
  // Attackers can forge headers; they cannot forge server state.
  const count = (ipRequestCounts.get(clientIP) || 0) + 1
  ipRequestCounts.set(clientIP, count)
  if (count > IP_BLOCK_THRESHOLD) {
    abusiveIPs.set(clientIP, {
      addedAt: Date.now(),
      expiresAt: Date.now() + ABUSIVE_IP_TTL
    })
    logger.warn('IP auto-blocked (server-side counter):', { ip: clientIP, requestsPerMinute: count })
  }

  next()
}

// Request size limiter
const requestSizeLimiter = (req, res, next) => {
  const contentLength = parseInt(req.headers['content-length'] || '0');
  const maxSize = 10 * 1024 * 1024; // 10MB

  if (contentLength > maxSize) {
    return res.status(413).json({ 
      error: 'Request too large. Maximum size is 10MB.' 
    });
  }

  next();
};

module.exports = {
  createLimiter,
  securityHeaders,
  tradingLimiter,
  apiLimiter,
  passwordResetLimiter,
  kycLimiter,
  payoutLimiter,
  fileUploadSecurity,
  abuseDetector,
  requestSizeLimiter
};
