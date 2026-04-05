/**
 * Shared constants for the PropFirm backend
 * Centralizes configuration to avoid duplication across files
 */

// Contract sizes per instrument
const CONTRACT_SIZES = {
  EURUSD: 100000,
  GBPUSD: 100000,
  XAUUSD: 100,
  XAGUSD: 5000
}

// Account types
const ACCOUNT_TYPES = {
  PHASE1: 'phase1',
  PHASE2: 'phase2',
  FUNDED: 'funded'
}

// Account statuses
const ACCOUNT_STATUSES = {
  ACTIVE: 'active',
  PASSED: 'passed',
  FAILED: 'failed',
  EXPIRED: 'expired'
}

// Trade statuses
const TRADE_STATUSES = {
  OPEN: 'open',
  CLOSED: 'closed',
  PENDING: 'pending'
}

// KYC statuses
const KYC_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
}

// Payout statuses
const PAYOUT_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  PAID: 'paid',
  REJECTED: 'rejected'
}

// Default platform settings
const DEFAULT_PLATFORM_SETTINGS = {
  phase1_profit_target_pct: 10,
  phase1_max_drawdown_pct: 10,
  phase1_day_limit: 30,
  phase2_profit_target_pct: 5,
  phase2_max_drawdown_pct: 5,
  phase2_day_limit: 60,
  funded_profit_split: 80,
  funded_max_drawdown_pct: 5,
  max_accounts_per_user: 3,
  min_payout_amount: 100,
  payout_processing_days: 3
}

// Rate limiting defaults
const RATE_LIMITS = {
  AUTH_WINDOW_MS: 15 * 60 * 1000, // 15 minutes
  AUTH_MAX: 10,
  ACCOUNT_CREATE_WINDOW_MS: 24 * 60 * 60 * 1000, // 24 hours
  ACCOUNT_CREATE_MAX: 5,
  TRADE_WINDOW_MS: 60 * 1000, // 1 minute
  TRADE_MAX: 30,
  KYC_UPLOAD_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  KYC_UPLOAD_MAX: 5,
  PAYOUT_REQUEST_WINDOW_MS: 60 * 60 * 1000, // 1 hour
  PAYOUT_REQUEST_MAX: 3
}

// File upload settings
const UPLOAD_SETTINGS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5MB
  ALLOWED_ID_EXTENSIONS: ['jpg', 'png', 'pdf'],
  ALLOWED_SELFIE_EXTENSIONS: ['jpg', 'png'],
  PRICE_HISTORY_RETAIN_DAYS: 90
}

// Time settings (all in UTC)
const TIME_SETTINGS = {
  MARKET_CLOSE_FRIDAY_UTC: 22, // 22:00 UTC
  WEEKEND_CLOSE_BUFFER_MINUTES: 5,
  SESSION_TIMEOUT_HOURS: 24
}

module.exports = {
  CONTRACT_SIZES,
  // FIX (BUG-4): VALID_SIZES removed from constants.js — accounts.js is the
  // single authoritative source (includes $1k, $2k, $2.5k sizes that this
  // file was missing). Any file needing VALID_SIZES should import from accounts.js.
  ACCOUNT_TYPES,
  ACCOUNT_STATUSES,
  TRADE_STATUSES,
  KYC_STATUSES,
  PAYOUT_STATUSES,
  DEFAULT_PLATFORM_SETTINGS,
  RATE_LIMITS,
  UPLOAD_SETTINGS,
  TIME_SETTINGS
}
