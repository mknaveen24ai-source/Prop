/**
 * Winston Logger for PropFirm
 * Centralized logging with levels, file output, and sanitization
 */

import fs from 'node:fs'
import path from 'node:path'
import type { RequestHandler } from 'express'
import winston from 'winston'
import { LOGS_ROOT } from '../config/runtimePaths'

interface LoggerFacade {
  level: string
  silent: boolean
  readonly transports: winston.Logger['transports']
  log: (level: string, message: unknown, meta?: unknown) => winston.Logger
  error: (message: unknown, meta?: unknown) => winston.Logger
  warn: (message: unknown, meta?: unknown) => winston.Logger
  info: (message: unknown, meta?: unknown) => winston.Logger
  http: (message: unknown, meta?: unknown) => winston.Logger
  debug: (message: unknown, meta?: unknown) => winston.Logger
  httpMiddleware: RequestHandler
}

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
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info
    let msg = `${String(timestamp)} [${level}]: ${String(message)}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Test runs share these log files with the real app, so fixture accounts
// (acc-ce-1, trade-race, ...) and deliberately-injected failures were landing in
// logs/error.log and logs/combined.log alongside production entries — which is
// how a batch of test-only "[violation-engine] Failed to record violation"
// lines got triaged as a live incident. Silence every transport under test; the
// suite asserts on behaviour, never on log output.
const isTestRun = process.env.NODE_ENV === 'test' || process.argv.includes('--test');

// Create logger instance
const baseLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: logLevels.levels,
  silent: isTestRun,
  transports: [
    // Console transport for development
    new winston.transports.Console({
      format: consoleFormat,
      stderrLevels: ['error', 'warn']
    }),
    
    // File transport for errors
    new winston.transports.File({
      filename: path.join(LOGS_ROOT, 'error.log'),
      level: 'error',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // File transport for all logs
    new winston.transports.File({
      filename: path.join(LOGS_ROOT, 'combined.log'),
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    
    // HTTP logs
    new winston.transports.File({
      filename: path.join(LOGS_ROOT, 'http.log'),
      level: 'http',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 3
    })
  ]
});

// Create logs directory if it doesn't exist
const logsDir = LOGS_ROOT;
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Sanitize sensitive data from logs
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitizeForLogging(obj: unknown): unknown {
  if (!obj) return obj;
  
  const sensitiveFields = ['password', 'token', 'secret', 'api_key', 'credit_card', 'ssn'];
  
  if (typeof obj === 'string') {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogging(item));
  }
  
  if (isRecord(obj)) {
    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key]
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

// Add sanitizing wrapper.
//
// The requestId is attached here rather than at each call site: every log in
// the app already funnels through this one function, so a single lookup gives
// end-to-end tracing without touching hundreds of logger.* calls. Required
// lazily because requestContext is loaded by server.js, which loads this.
type RequestIdGetter = () => string | undefined
let getRequestId: RequestIdGetter | undefined;
function currentRequestId(): string | undefined {
  if (!getRequestId) {
    const requestContext = require('./requestContext') as { getRequestId: RequestIdGetter }
    getRequestId = requestContext.getRequestId
  }
  return getRequestId();
}

function writeLog(level: string, message: unknown, meta?: unknown): winston.Logger {
  let safeMeta = meta === undefined ? undefined : sanitizeForLogging(meta)
  // undefined outside a request — the engines, workers and startup all log
  // from outside one, and those lines simply carry no id.
  const requestId = currentRequestId();
  if (requestId) {
    safeMeta = isRecord(safeMeta) ? { ...safeMeta, requestId } : { requestId };
  }
  const normalizedMessage = typeof message === 'string' ? message : String(message)
  return safeMeta === undefined
    ? baseLogger.log(level, normalizedMessage)
    : baseLogger.log(level, normalizedMessage, safeMeta)
}

// HTTP request logger middleware
// FIX (LOW #30): Exclude health check and price endpoints to reduce log volume.
// Previously logged every 1-second price poll (86,400+ entries/day).
const HEALTH_ENDPOINTS = ['/', '/health', '/api/prices', '/api/trades/prices', '/api/price-status', '/ping']
const HEALTH_PREFIXES = ['/api/price']

function shouldSkipHttpLog(requestPath: string): boolean {
  if (HEALTH_ENDPOINTS.includes(requestPath)) return true
  return HEALTH_PREFIXES.some(prefix => requestPath.startsWith(prefix))
}

const httpMiddleware: RequestHandler = (req, res, next): void => {
  const start = Date.now();

  res.on('finish', () => {
    // Skip logging health checks and price polling
    if (shouldSkipHttpLog(req.path)) return
    const duration = Date.now() - start;
    writeLog('http', `${req.method} ${req.originalUrl}`, {
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });
  });

  next();
};

const logger: LoggerFacade = {
  get level(): string {
    return baseLogger.level
  },
  set level(value: string) {
    baseLogger.level = value
  },
  get silent(): boolean {
    return baseLogger.silent
  },
  set silent(value: boolean) {
    baseLogger.silent = value
  },
  get transports(): winston.Logger['transports'] {
    return baseLogger.transports
  },
  log: writeLog,
  error: (message, meta) => writeLog('error', message, meta),
  warn: (message, meta) => writeLog('warn', message, meta),
  info: (message, meta) => writeLog('info', message, meta),
  http: (message, meta) => writeLog('http', message, meta),
  debug: (message, meta) => writeLog('debug', message, meta),
  httpMiddleware
}

export = logger;
