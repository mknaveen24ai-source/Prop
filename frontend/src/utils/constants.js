/**
 * Shared constants for PropFirm Frontend
 * Centralizes configuration to avoid duplication across components
 */

// Contract sizes (units per 1 lot) - must match backend
// FIX (LOW #26): This is the single source of truth for frontend.
// Backend CONTRACT_SIZES defined in backend/constants.js
// Always update here when backend adds new instruments.
export const CONTRACT_SIZES = {
  EURUSD: 100000,
  GBPUSD: 100000,
  USDJPY: 100000,
  USDCHF: 100000,
  AUDUSD: 100000,
  USDCAD: 100000,
  XAUUSD: 100,
  XAGUSD: 5000,
  US30: 1,
  NAS100: 1
}

// Leverage settings
export const LEVERAGE = {
  EURUSD: 30,
  GBPUSD: 30,
  XAUUSD: 10,
  XAGUSD: 10
}

// Account types
export const ACCOUNT_TYPES = {
  PHASE1: 'phase1',
  PHASE2: 'phase2',
  FUNDED: 'funded'
}

// Account statuses with display colors
export const ACCOUNT_STATUSES = {
  active: { label: 'Active', color: 'var(--accent)' },
  passed: { label: 'Passed', color: 'var(--green)' },
  failed: { label: 'Failed', color: 'var(--red)' },
  funded: { label: 'Funded', color: 'var(--cyan)' },
  pending: { label: 'Pending', color: 'var(--accent)' },
  approved: { label: 'Approved', color: 'var(--green)' },
  paid: { label: 'Paid', color: 'var(--green)' },
  rejected: { label: 'Rejected', color: 'var(--red)' },
  locked: { label: 'Locked', color: '#8a8a8a' },
  expired: { label: 'Expired', color: '#8a8a8a' }
}

// Drawdown warning thresholds (percentages)
export const DRAWDOWN_THRESHOLDS = {
  CRITICAL: 90,  // Red - account will fail soon
  HIGH: 75,      // Orange - serious warning
  MEDIUM: 50,    // Yellow - caution
  LOW: 25        // Blue - informational
}

// Trading limits
export const TRADING_LIMITS = {
  MIN_LOT_SIZE: 0.01,
  MAX_LOT_SIZE: 1000,
  LOT_STEP: 0.01,
  MIN_HOLD_SECONDS: 60,
  MAX_TRADES_PER_1K: 1
}

// Payout settings
export const PAYOUT_SETTINGS = {
  MIN_AMOUNT: 50,
  MIN_ACCOUNT_AGE_DAYS: 5,
  MIN_WINNING_TRADES: 5,
  MAX_PAYOUT_PERCENTAGE: 40, // 40% of account size
  MAX_SINGLE_TRADE_PERCENTAGE: 50 // 50% of total profit
}

// KYC settings
export const KYC_SETTINGS = {
  MAX_FILE_SIZE: 10 * 1024 * 1024, // 10MB
  ALLOWED_ID_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
  ALLOWED_SELFIE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
}

// Time intervals (milliseconds)
export const TIME_INTERVALS = {
  PRICE_POLLING: 30000,        // 30 seconds
  ACCOUNT_POLLING: 300000,     // 5 minutes
  NOTIFICATION_POLLING: 60000, // 1 minute
  SOCKET_RECONNECT: 5000       // 5 seconds
}

// Risk warning levels
export const RISK_LEVELS = {
  LOW: { threshold: 25, color: '#4CAF50', label: 'Low' },
  MEDIUM: { threshold: 50, color: '#FFC107', label: 'Medium' },
  HIGH: { threshold: 75, color: '#FF9800', label: 'High' },
  CRITICAL: { threshold: 90, color: '#F44336', label: 'Critical' }
}

// Instrument groups
export const INSTRUMENT_GROUPS = {
  FOREX: ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD'],
  COMMODITIES: ['XAUUSD', 'XAGUSD'],
  INDICES: ['US30', 'NAS100']
}

// Valid account sizes
// FIX (LOW #25): Synced with backend VALID_SIZES in accounts.js
// Backend supports: [1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000, 200000]
// Note: Frontend should rely on API response from /api/accounts/available-sizes
// instead of this hardcoded list, which is kept for reference only.
export const VALID_ACCOUNT_SIZES = [1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000, 200000]

// Default platform settings
export const DEFAULT_PLATFORM_SETTINGS = {
  phase1_profit_target_pct: 10,
  phase1_max_drawdown_pct: 10,
  phase1_day_limit: 30,
  phase2_profit_target_pct: 5,
  phase2_max_drawdown_pct: 5,
  phase2_day_limit: 60,
  funded_profit_split: 80,
  funded_max_drawdown_pct: 5
}

// Helper functions
export function getStatusColor(status) {
  return ACCOUNT_STATUSES[status]?.color || '#8a8a8a'
}

export function getStatusLabel(status) {
  return ACCOUNT_STATUSES[status]?.label || status
}

export function calculatePnL(direction, openPrice, currentPrice, lots, instrument) {
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  const priceDiff = direction === 'buy' 
    ? currentPrice - openPrice 
    : openPrice - currentPrice
  return parseFloat((priceDiff * lots * contractSize).toFixed(2))
}

export function calculateMargin(instrument, lots) {
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  const leverage = LEVERAGE[instrument] || 30
  return parseFloat(((lots * contractSize) / leverage).toFixed(2))
}

export function getRiskLevel(percentage) {
  if (percentage >= DRAWDOWN_THRESHOLDS.CRITICAL) return RISK_LEVELS.CRITICAL
  if (percentage >= DRAWDOWN_THRESHOLDS.HIGH) return RISK_LEVELS.HIGH
  if (percentage >= DRAWDOWN_THRESHOLDS.MEDIUM) return RISK_LEVELS.MEDIUM
  if (percentage >= DRAWDOWN_THRESHOLDS.LOW) return RISK_LEVELS.LOW
  return { threshold: 0, color: '#4CAF50', label: 'Safe' }
}
