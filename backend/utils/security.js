/**
 * Security utilities for PropFirm
 * Security headers, rate limiting, and other security middleware
 */

const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const logger = require('./logger');

// FIX (BUG-L7 v2): express-rate-limit v7+ exports `ipKeyGenerator` as a named
// export AND requires you to use it (not a custom req.ip function) to ensure
// proper IPv6 address normalization. Using a custom (req) => req.ip function
// causes ERR_ERL_KEY_GEN_IPV6 at startup. Import the real one from the library.
const { ipKeyGenerator } = require('express-rate-limit');

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
const tradingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 trades per minute per user
  message: { error: 'Too many trading requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId || ipKeyGenerator(req);
  }
});

// API endpoint rate limiter
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: { error: 'Too many API requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip for static files and health checks
    return req.path.startsWith('/uploads/') || req.path === '/';
  },
  keyGenerator: ipKeyGenerator
});

// Password reset rate limiter
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // 3 password reset attempts per 15 minutes
  message: { error: 'Too many password reset attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body.email || ipKeyGenerator(req)
});

// KYC submission rate limiter
const kycLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 KYC submissions per hour
  message: { error: 'Too many KYC submissions. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req)
});

// Payout request rate limiter
const payoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 payout requests per hour
  message: { error: 'Too many payout requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.userId || ipKeyGenerator(req)
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
setInterval(() => { ipRequestCounts.clear() }, 60 * 1000) // reset every minute

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
