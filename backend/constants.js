/**
 * Shared constants for the PropFirm backend
 * Centralizes configuration to avoid duplication across files
 */

const {
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_CATALOG,
  INSTRUMENTS,
  USD_QUOTED_INSTRUMENTS,
  getTradableInstruments,
  isTradableInstrument,
  isFxConversionEnabled,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  INDEX_INSTRUMENTS,
  CONTRACT_SIZES,
  LEVERAGE,
  TWELVE_DATA_SYMBOLS,
  DEFAULT_SPREADS,
  getInstrumentConfig,
  getPriceDecimals,
  getInputStep,
  getInputStepString,
  getPipSize,
  getMinDistance,
  getPointMultiplier,
  getSpreadPoints,
  getWideSpreadThreshold,
  getQuickMoveThreshold,
  roundPrice,
  formatPrice
} = require('./instruments')

const ACCOUNT_TYPES = {
  PHASE1: 'phase1',
  PHASE2: 'phase2',
  FUNDED: 'funded'
}

const ACCOUNT_STATUSES = {
  ACTIVE: 'active',
  PASSED: 'passed',
  FAILED: 'failed',
  EXPIRED: 'expired'
}

const TRADE_STATUSES = {
  OPEN: 'open',
  CLOSED: 'closed',
  PENDING: 'pending'
}

const KYC_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
}

const PAYOUT_STATUSES = {
  PENDING: 'pending',
  APPROVED: 'approved',
  PAID: 'paid',
  REJECTED: 'rejected'
}

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

const RATE_LIMITS = {
  AUTH_WINDOW_MS: 15 * 60 * 1000,
  AUTH_MAX: 10,
  ACCOUNT_CREATE_WINDOW_MS: 24 * 60 * 60 * 1000,
  ACCOUNT_CREATE_MAX: 5,
  TRADE_WINDOW_MS: 60 * 1000,
  TRADE_MAX: 30,
  KYC_UPLOAD_WINDOW_MS: 60 * 60 * 1000,
  KYC_UPLOAD_MAX: 5,
  PAYOUT_REQUEST_WINDOW_MS: 60 * 60 * 1000,
  PAYOUT_REQUEST_MAX: 3
}

const UPLOAD_SETTINGS = {
  MAX_FILE_SIZE: 5 * 1024 * 1024,
  ALLOWED_ID_EXTENSIONS: ['jpg', 'png', 'pdf'],
  ALLOWED_SELFIE_EXTENSIONS: ['jpg', 'png'],
  PRICE_HISTORY_RETAIN_DAYS: 90
}

const TIME_SETTINGS = {
  MARKET_CLOSE_FRIDAY_UTC: 22,
  WEEKEND_CLOSE_BUFFER_MINUTES: 5,
  SESSION_TIMEOUT_HOURS: 24
}

module.exports = {
  INSTRUMENT_DEFINITIONS,
  INSTRUMENT_CATALOG,
  INSTRUMENTS,
  USD_QUOTED_INSTRUMENTS,
  getTradableInstruments,
  isTradableInstrument,
  isFxConversionEnabled,
  FOREX_INSTRUMENTS,
  COMMODITY_INSTRUMENTS,
  INDEX_INSTRUMENTS,
  CONTRACT_SIZES,
  LEVERAGE,
  TWELVE_DATA_SYMBOLS,
  DEFAULT_SPREADS,
  getInstrumentConfig,
  getPriceDecimals,
  getInputStep,
  getInputStepString,
  getPipSize,
  getMinDistance,
  getPointMultiplier,
  getSpreadPoints,
  getWideSpreadThreshold,
  getQuickMoveThreshold,
  roundPrice,
  formatPrice,
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
