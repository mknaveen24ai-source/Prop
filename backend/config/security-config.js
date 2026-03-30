/**
 * Security Configuration for PropFirm
 * Centralized security settings and policies
 */

const logger = require('../utils/logger');

// Security configuration
const securityConfig = {
  // Password policies
  password: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumbers: true,
    requireSpecialChars: false,
    maxAttempts: 5,
    lockoutDuration: 15 * 60 * 1000, // 15 minutes
  },

  // Session settings
  session: {
    tokenExpiry: '7d',
    adminTokenExpiry: '8h',
    refreshThreshold: '1h',
    maxConcurrentSessions: 5,
  },

  // Rate limiting
  rateLimit: {
    // General API limits
    api: {
      windowMs: 60 * 1000, // 1 minute
      max: 100, // requests per minute
    },
    
    // Authentication limits
    auth: {
      windowMs: 60 * 1000, // 1 minute
      max: 10, // attempts per minute
    },
    
    // Trading limits
    trading: {
      windowMs: 60 * 1000, // 1 minute
      max: 30, // trades per minute
    },
    
    // Password reset limits
    passwordReset: {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 3, // attempts per 15 minutes
    },
    
    // Account creation limits
    accountCreation: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 20, // accounts per hour
    },
    
    // KYC submission limits
    kyc: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 5, // submissions per hour
    },
    
    // Payout request limits
    payout: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 3, // requests per hour
    },
    
    // Support ticket limits
    support: {
      windowMs: 60 * 60 * 1000, // 1 hour
      max: 10, // tickets per hour
    },
  },

  // File upload policies
  fileUpload: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    allowedDocumentTypes: ['application/pdf', 'text/plain'],
    scanForMalware: true,
    quarantineSuspicious: true,
  },

  // Input validation
  validation: {
    maxStringLength: 5000,
    emailMaxLength: 255,
    nameMaxLength: 100,
    maxDecimalPlaces: 8,
    sanitizeHtml: true,
    stripScripts: true,
  },

  // CORS settings
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  },

  // CSP (Content Security Policy)
  csp: {
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
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
    },
  },

  // Blocked countries and regions
  blockedCountries: [
    'United States', 'Canada', 'Iran', 'North Korea', 'Cuba', 'Syria'
  ],

  // Blocked email domains (temporary email providers)
  blockedEmailDomains: [
    'tempmail.com', 'guerrillamail.com', 'mailinator.com',
    'throwaway.email', 'fakeinbox.com', '10minutemail.com',
    'yopmail.com', 'trashmail.com', 'sharklasers.com'
  ],

  // Security headers
  headers: {
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    frameguard: 'deny',
    noSniff: true,
    referrerPolicy: 'strict-origin-when-cross-origin',
  },

  // Logging and monitoring
  logging: {
    logLevel: process.env.LOG_LEVEL || 'info',
    logRequests: true,
    logErrors: true,
    logSecurityEvents: true,
    logPerformanceMetrics: true,
    retainLogs: {
      error: 30, // days
      access: 7, // days
      security: 90, // days
    },
  },

  // Monitoring and alerting
  monitoring: {
    enableMetrics: true,
    enableAlerts: true,
    alertThresholds: {
      errorRate: 0.05, // 5%
      responseTime: 2000, // 2 seconds
      failedLogins: 10, // per minute
      suspiciousActivity: 5, // per minute
    },
  },

  // Database security
  database: {
    connectionTimeout: 30000, // 30 seconds
    queryTimeout: 10000, // 10 seconds
    maxConnections: 20,
    idleTimeout: 300000, // 5 minutes
    enableQueryLogging: false,
    sanitizeInputs: true,
  },

  // Trading security
  trading: {
    maxPositionSize: 1000, // lots
    maxDailyTrades: 100,
    maxLossPerTrade: 0.1, // 10% of account
    requiredHoldTime: 60, // seconds
    weekendCloseTime: '21:58:00', // UTC
    marketHours: {
      weekend: false,
      rolloverStart: '21:55:00', // UTC
      rolloverEnd: '22:05:00', // UTC
    },
  },
};

// Security monitoring functions
const securityMonitor = {
  // Log security events
  logSecurityEvent: (event, details) => {
    logger.warn(`[SECURITY] ${event}`, details);
  },

  // Detect suspicious patterns
  detectSuspiciousActivity: (req, res, next) => {
    const patterns = {
      rapidRequests: req.requestCount > 100,
      adminAccess: req.path.includes('/admin') && !req.user?.isAdmin,
      blockedCountry: securityConfig.blockedCountries.includes(req.country),
      unusualUserAgent: req.get('User-Agent')?.length < 10,
    };

    const suspiciousPatterns = Object.entries(patterns)
      .filter(([_, isSuspicious]) => isSuspicious)
      .map(([pattern]) => pattern);

    if (suspiciousPatterns.length > 0) {
      securityMonitor.logSecurityEvent('Suspicious activity detected', {
        ip: req.ip,
        patterns: suspiciousPatterns,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });
    }

    next();
  },

  // Check for common attack patterns
  checkAttackPatterns: (req, res, next) => {
    const attackPatterns = [
      /\.\./,  // Path traversal
      /<script/i,  // XSS
      /union.*select/i,  // SQL injection
      /javascript:/i,  // JavaScript injection
      /data:.*base64/i,  // Base64 injection
    ];

    const requestString = JSON.stringify(req.body) + req.path + req.get('User-Agent');
    
    for (const pattern of attackPatterns) {
      if (pattern.test(requestString)) {
        securityMonitor.logSecurityEvent('Potential attack pattern detected', {
          ip: req.ip,
          pattern: pattern.toString(),
          path: req.path,
          userAgent: req.get('User-Agent'),
        });
        
        return res.status(400).json({ error: 'Invalid request detected' });
      }
    }

    next();
  },
};

module.exports = {
  securityConfig,
  securityMonitor,
};
