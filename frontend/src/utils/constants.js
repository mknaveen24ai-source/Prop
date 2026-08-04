/**
 * Shared constants for PropFirm Frontend
 * Centralizes configuration to avoid duplication across components
 */

import {
  CONTRACT_SIZES,
  LEVERAGE,
  INSTRUMENT_GROUPS,
  calculatePnL,
  calculateMargin,
} from './instruments.js'
import { getStatusToneColor } from './statusTone.js'

export { CONTRACT_SIZES, LEVERAGE, INSTRUMENT_GROUPS }

export const ACCOUNT_TYPES = {
  PHASE1: 'phase1',
  PHASE2: 'phase2',
  FUNDED: 'funded'
}

// Single lookup table driving every trader-facing status pill, dot and
// colored figure (Modern Gazette handoff spec: "one map, every
// representation"). Colors are sourced from utils/statusTone.js, the one
// 5-tone (gain/accent/warn/muted/loss) map shared with the admin side
// (components/admin/AdminBadge.jsx) — only the label wording differs here.
export const ACCOUNT_STATUSES = {
  active: { label: 'Active', color: getStatusToneColor('active') },
  passed: { label: 'Passed', color: getStatusToneColor('passed') },
  failed: { label: 'Failed', color: getStatusToneColor('failed') },
  funded: { label: 'Funded', color: getStatusToneColor('funded') },
  pending: { label: 'Pending', color: getStatusToneColor('pending') },
  processing: { label: 'Processing', color: getStatusToneColor('processing') },
  approved: { label: 'Approved', color: getStatusToneColor('approved') },
  paid: { label: 'Paid', color: getStatusToneColor('paid') },
  available: { label: 'Available', color: getStatusToneColor('available') },
  adjusted: { label: 'Adjusted', color: getStatusToneColor('adjusted') },
  rejected: { label: 'Rejected', color: getStatusToneColor('rejected') },
  locked: { label: 'Locked', color: getStatusToneColor('locked') },
  expired: { label: 'Expired', color: getStatusToneColor('expired') }
}

export const DRAWDOWN_THRESHOLDS = {
  CRITICAL: 90,
  HIGH: 75,
  MEDIUM: 50,
  LOW: 25
}

export const TRADING_LIMITS = {
  MIN_LOT_SIZE: 0.01,
  MAX_LOT_SIZE: 1000,
  LOT_STEP: 0.01,
  MIN_HOLD_SECONDS: 60,
  MAX_TRADES_PER_1K: 1
}

export const PAYOUT_SETTINGS = {
  MIN_AMOUNT: 50,
  MIN_ACCOUNT_AGE_DAYS: 5,
  MIN_WINNING_TRADES: 5,
  MAX_PAYOUT_PERCENTAGE: 40,
  MAX_SINGLE_TRADE_PERCENTAGE: 50
}

export const KYC_SETTINGS = {
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  ALLOWED_ID_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'],
  ALLOWED_SELFIE_TYPES: ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
}

export const TIME_INTERVALS = {
  PRICE_POLLING: 30000,
  ACCOUNT_POLLING: 300000,
  NOTIFICATION_POLLING: 60000,
  SOCKET_RECONNECT: 5000
}

export const RISK_LEVELS = {
  LOW: { threshold: 25, color: '#4CAF50', label: 'Low' },
  MEDIUM: { threshold: 50, color: '#FFC107', label: 'Medium' },
  HIGH: { threshold: 75, color: '#FF9800', label: 'High' },
  CRITICAL: { threshold: 90, color: '#F44336', label: 'Critical' }
}

export const VALID_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]

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

export function getStatusColor(status) {
  return ACCOUNT_STATUSES[status]?.color || 'var(--muted)'
}

export function getStatusLabel(status) {
  return ACCOUNT_STATUSES[status]?.label || status
}

export { calculatePnL, calculateMargin }

export function getRiskLevel(percentage) {
  if (percentage >= DRAWDOWN_THRESHOLDS.CRITICAL) return RISK_LEVELS.CRITICAL
  if (percentage >= DRAWDOWN_THRESHOLDS.HIGH) return RISK_LEVELS.HIGH
  if (percentage >= DRAWDOWN_THRESHOLDS.MEDIUM) return RISK_LEVELS.MEDIUM
  if (percentage >= DRAWDOWN_THRESHOLDS.LOW) return RISK_LEVELS.LOW
  return { threshold: 0, color: '#4CAF50', label: 'Safe' }
}
