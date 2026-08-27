/**
 * Shared constants for the PropFirm backend
 * Centralizes configuration to avoid duplication across files
 */

import instruments = require('./instruments')

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
} = instruments

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

// ─── Profit share: one source of truth ───────────────────────────────────────
// FIX (F-02): profit_share_pct had five independent fallbacks — payouts.js used
// 80 twice, accounts.js and tradeAnalytics.js used 80, and the React dashboard
// initialised at 80 — while setup.js seeds the platform at 75 and
// DEFAULT_TENANT_SETTINGS says 75. A stored-but-unparseable value (an admin
// clearing the field in Admin > Settings writes '') overrode the 75 default and
// landed on whichever 80 the caller happened to use, paying traders five points
// over on every payout.
//
// This lives in constants.js rather than utils/tenantSettings.js because
// services/tradeAnalytics.js is deliberately database-free and unit-testable;
// importing tenantSettings there would pull in the pg pool at require time.
const PROFIT_SHARE_FALLBACK_PCT = 100

/**
 * Parses a stored profit_share_pct into a usable percentage.
 * Returns null when the value is absent or outside (0, 100] — callers decide
 * what that means, because "show a number" and "pay a number" carry different
 * risk. Deliberately substitutes no default of its own.
 *
 * @param {unknown} rawValue value as stored in platform_settings
 * @returns {number|null} percentage in (0, 100], or null if unusable
 */
function resolveProfitSharePct(rawValue: unknown): number | null {
  const parsed = parseFloat(String(rawValue ?? '').trim())
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null
  return parsed
}

const DEFAULT_PLATFORM_SETTINGS = {
  phase1_profit_target_pct: 10,
  phase1_max_drawdown_pct: 10,
  phase1_day_limit: 30,
  phase2_profit_target_pct: 5,
  phase2_max_drawdown_pct: 5,
  phase2_day_limit: 60,
  funded_profit_split: 100,
  funded_max_drawdown_pct: 5,
  max_accounts_per_user: 0,   // 0 = unlimited (see routes/accounts.js)
  min_payout_amount: 100,
  payout_processing_days: 3
}

/**
 * Payout rails the platform actually settles on.
 *
 * routes/payouts.js enforced six methods while the published Terms named USDT
 * (TRC20) only, so the contract and the code disagreed about how a trader gets
 * paid. Exported so the route, the public settings response and the Terms all
 * read one list — a method added here reaches all three or none.
 */
const PAYOUT_METHODS = [
  { id: 'usdt_trc20', label: 'USDT', network: 'TRC20' },
  { id: 'usdt_bep20', label: 'USDT', network: 'BEP20' },
  { id: 'usdt_erc20', label: 'USDT', network: 'ERC20' },
  { id: 'usdt_polygon', label: 'USDT', network: 'Polygon' },
  { id: 'btc', label: 'Bitcoin', network: 'BTC' },
  { id: 'ltc', label: 'Litecoin', network: 'LTC' }
]

const PAYOUT_METHOD_IDS = PAYOUT_METHODS.map((method) => method.id)

/**
 * The payout commitment the platform is willing to publish.
 *
 * FUNDED_STAGE.payout_frequency used to read 'weekly' and the landing page
 * advertised "Weekly Payout Cycles" — but nothing read that field and nothing
 * ran a cycle. Payouts are on-demand, one request per 24h, paid when an admin
 * approves. On-demand is the better offer; it just needed an SLA behind it
 * instead of a cadence that did not exist.
 *
 * services/schedulerService.js alerts ops when a pending request ages past
 * PAYOUT_SLA_PAID_HOURS, so the published number is one the platform watches.
 */
const PAYOUT_SLA = {
  REVIEW_HOURS: 24,
  PAID_HOURS: 48
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

const constants = {
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
  PROFIT_SHARE_FALLBACK_PCT,
  PAYOUT_METHODS,
  PAYOUT_METHOD_IDS,
  PAYOUT_SLA,
  resolveProfitSharePct,
  DEFAULT_PLATFORM_SETTINGS,
  RATE_LIMITS,
  UPLOAD_SETTINGS,
  TIME_SETTINGS
}

export = constants
