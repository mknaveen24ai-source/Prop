/**
 * Winston Logger for PropFirm
 * Centralized logging with levels, file output, and sanitization
 */

const winston = require('winston');
const path = require('path');

// Define log levels
const logLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    debug: 4
  },
  colors: {
    error: 'red',
    warn: 'yellow',
    info: 'green',
    http: 'magenta',
    debug: 'blue'
  }
};

winston.addColors(logLevels.colors);

// Log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: logLevels.levels,
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: consoleFormat,
      stderrLevels: ['error', 'warn']
    }),
    
    // File transport for errors
    new winston.transports.File({
      filename: path.join(__dirname, '..', 'logs', 'error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(__dirname, '..', 'logs', 'combined.log'),
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // HTTP logs
    new winston.transports.File({
      filename: path.join(__dirname, '..', 'logs', 'http.log'),
      level: 'http',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ]
});

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Sanitize sensitive data from logs
function sanitizeForLogging(obj) {
  if (!obj) return obj;
  
  const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'credit_card', 'ssn'];
  
  if (typeof obj === 'string') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item));
  }
  
  if (typeof obj === 'object') {
    const sanitized = {};
    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveFields.some(field => key.toLowerCase().includes(field))) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object') {
        sanitized[key] = sanitizeForLogging(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
  
  return obj;
}

// Add sanitizing wrapper
const originalLog = logger.log.bind(logger);
logger.log = function(level, message, meta) {
  if (meta) {
    meta = sanitizeForLogging(meta);
  }
  return originalLog(level, message, meta);
};

// Convenience methods
logger.error = function(message, meta) {
  return this.log('error', message, meta);
};

logger.warn = function(message, meta) {
  return this.log('warn', message, meta);
};

logger.info = function(message, meta) {
  return this.log('info', message, meta);
};

logger.http = function(message, meta) {
  return this.log('http', message, meta);
};

logger.debug = function(message, meta) {
  return this.log('debug', message, meta);
};

// HTTP request logger middleware
// FIX (LOW #30): Exclude health check and price endpoints to reduce log volume.
// Previously logged every 1-second price poll (86,400+ entries/day).
const HEALTH_ENDPOINTS = ['/', '/health', '/api/prices', '/api/trades/prices', '/api/price-status', '/ping']
const HEALTH_PREFIXES = ['/api/price']

function shouldSkipHttpLog(path) {
  if (HEALTH_ENDPOINTS.includes(path)) return true
  return HEALTH_PREFIXES.some(prefix => path.startsWith(prefix))
}

logger.httpMiddleware = function(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    // Skip logging health checks and price polling
    if (shouldSkipHttpLog(req.path)) return
    const duration = Date.now() - start;
    logger.http(`${req.method} ${req.originalUrl}`, {
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });

  next();
};

module.exports = logger;
