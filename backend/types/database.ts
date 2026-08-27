import type { QueryResultRow } from 'pg'

/**
 * Private PostgreSQL representations. These types describe values returned by
 * `pg`; they are never public API contracts and must be mapped before a row is
 * sent over HTTP or Socket.IO.
 */
export type DatabaseNumeric = string
export type DatabaseBigInt = string
export type DatabaseJson = unknown
export type DatabaseTimestamp = Date

export interface UserRow extends QueryResultRow {
  id: string
  email: string
  password_hash: string
  full_name: string
  country: string
  phone: string | null
  kyc_status: string | null
  kyc_document_url: string | null
  device_fingerprint: string | null
  is_banned: boolean | null
  affiliate_code: string | null
  referred_by: string | null
  created_at: DatabaseTimestamp | null
  id_document_path: string | null
  selfie_path: string | null
  kyc_submitted_at: DatabaseTimestamp | null
  kyc_rejection_reason: string | null
  id_document_hash: string | null
  theme_preference: string | null
  token_version: number | null
  trader_uid: string | null
  totp_secret: string | null
  totp_enabled: boolean | null
  totp_temp_secret: string | null
  totp_backup_codes: string | null
  leaderboard_visible: boolean
  reset_token: string | null
  reset_token_expires: DatabaseTimestamp | null
  kyc_document_country: string | null
  kyc_document_type: string | null
  kyc_document_number: string | null
  id_document_back_path: string | null
  phone_verified: boolean
  signup_source: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state_province: string | null
  postal_code: string | null
  updated_at: DatabaseTimestamp | null
  is_bot: boolean
}

export interface UserTokenStateRow extends QueryResultRow {
  token_version: number | null
  is_banned: boolean | null
}

export interface AccountRow extends QueryResultRow {
  id: string
  user_id: string | null
  account_type: string
  account_size: DatabaseNumeric
  current_balance: DatabaseNumeric
  starting_balance: DatabaseNumeric
  peak_balance: DatabaseNumeric
  profit_target: DatabaseNumeric
  max_drawdown_pct: DatabaseNumeric
  status: string | null
  phase_start_date: DatabaseTimestamp | null
  phase_end_date: DatabaseTimestamp | null
  demo_account_id: string | null
  bridge_mode: string | null
  flagged: boolean | null
  flag_reason: string | null
  bot_score: number | null
  bridge_active: boolean | null
  created_at: DatabaseTimestamp | null
  review_flagged: boolean
  review_flag_reason: string | null
  account_uid: string | null
  updated_at: DatabaseTimestamp | null
  challenge_model_id: number | null
  challenge_model_slug: string | null
  step_number: number | null
  daily_drawdown_pct: DatabaseNumeric | null
  drawdown_type: string | null
  eod_trailing_floor: DatabaseNumeric | null
  eod_peak_equity: DatabaseNumeric | null
  consistency_max_day_pct: DatabaseNumeric | null
  min_trading_days: number | null
  min_daily_profit_pct: DatabaseNumeric | null
  qualifying_days_count: number | null
  free_retries_remaining: number | null
  parent_account_id: string | null
  scaling_multiplier: DatabaseNumeric
  scaling_milestones_claimed: number
}

export interface TradeRow extends QueryResultRow {
  id: string
  account_id: string | null
  demo_trade_id: string | null
  broker_trade_id: string | null
  instrument: string
  direction: string
  broker_direction: string | null
  lot_size: DatabaseNumeric
  open_price: DatabaseNumeric | null
  close_price: DatabaseNumeric | null
  open_time: DatabaseTimestamp | null
  close_time: DatabaseTimestamp | null
  demo_pnl: DatabaseNumeric | null
  broker_pnl: DatabaseNumeric | null
  status: string | null
  stop_loss: DatabaseNumeric | null
  take_profit: DatabaseNumeric | null
  order_type: string | null
  pending_price: DatabaseNumeric | null
  close_reason: string | null
  trader_note: string | null
  parent_trade_id: number | null
  is_partial: boolean | null
  commission: DatabaseNumeric | null
  notes: string | null
  tags: DatabaseJson
  trailing_activation_price: DatabaseNumeric | null
  trailing_step_pips: number | null
  slippage_pips: DatabaseNumeric | null
  original_commission: DatabaseNumeric | null
  strategy_tag: string | null
  open_screenshot_path: string | null
  close_screenshot_path: string | null
  breakeven_trigger_pips: DatabaseNumeric | null
  oco_group_id: string | null
}

export interface PayoutRow extends QueryResultRow {
  id: string
  user_id: string | null
  account_id: string | null
  amount_requested: DatabaseNumeric | null
  firm_cut: DatabaseNumeric | null
  amount_payable: DatabaseNumeric | null
  payment_method: string | null
  payment_details: string | null
  status: string | null
  requested_at: DatabaseTimestamp | null
  paid_at: DatabaseTimestamp | null
  transaction_id: string | null
  is_flagged: boolean | null
  flag_reason: string | null
  admin_notes: string | null
}

export interface PlatformAdminRow extends QueryResultRow {
  id: DatabaseBigInt
  email: string
  full_name: string | null
  password_hash: string
  role: string
  status: string
  token_version: number
  totp_secret: string | null
  totp_temp_secret: string | null
  totp_backup_codes: string | null
  totp_enabled: boolean
  last_login_at: DatabaseTimestamp | null
  created_at: DatabaseTimestamp
  updated_at: DatabaseTimestamp
}
