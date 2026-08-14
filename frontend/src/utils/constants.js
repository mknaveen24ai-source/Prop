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
import { getStatusToneColor, getStatusToneLabel } from './statusTone.js'

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

// Falls through to the full statusTone.js keyword map for any status not in
// the curated table above, instead of a hardcoded muted gray — otherwise a
// status this table doesn't happen to list (e.g. "cancelled", "resolved")
// would silently render gray here while getStatusToneColor() elsewhere
// resolves it to its correct tone, splitting the "one map" invariant.
export function getStatusColor(status) {
  return ACCOUNT_STATUSES[status]?.color || getStatusToneColor(status)
}

export function getStatusLabel(status) {
  return ACCOUNT_STATUSES[status]?.label || getStatusToneLabel(status)
}

export { calculatePnL, calculateMargin }
