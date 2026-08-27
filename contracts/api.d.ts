import type {
  AccountId,
  DecimalString,
  IsoTimestamp,
  TradeId,
  UserId,
  JsonValue
} from './primitives'

export interface AccountSummaryDto {
  id: AccountId
  user_id: UserId
  status: string
  balance: DecimalString
  equity: DecimalString
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

export interface TradeDto {
  id: TradeId
  account_id: AccountId
  user_id: UserId
  instrument: string
  direction: 'buy' | 'sell'
  status: string
  lot_size: DecimalString
  entry_price: DecimalString
  stop_loss: DecimalString | null
  take_profit: DecimalString | null
  pnl: DecimalString | null
  open_time: IsoTimestamp
  close_time: IsoTimestamp | null
}

/** Existing GET /trades/open, /pending and /history response shape. */
export interface TradeListItemDto {
  id: TradeId
  account_id: AccountId
  instrument: string
  direction: string
  lot_size: DecimalString
  open_price?: DecimalString | null
  close_price?: DecimalString | null
  pending_price?: DecimalString | null
  stop_loss: DecimalString | null
  take_profit: DecimalString | null
  status: string
  demo_pnl?: DecimalString | null
  open_time: IsoTimestamp | null
  close_time?: IsoTimestamp | null
  close_reason?: string | null
  order_type: string | null
  demo_trade_id?: string | null
  oco_group_id?: string | null
  open_screenshot_path: string | null
  close_screenshot_path: string | null
  r_multiple: number | null
  open_screenshot_url: string | null
  close_screenshot_url: string | null
}

export interface HealthResponseDto {
  status: string
  timestamp: IsoTimestamp
}

/** Existing chart wire format; prices remain numbers until a versioned API change. */
export interface CandleDto {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type BatchTradeAction = 'close_winning' | 'close_losing' | 'breakeven_winning'

export interface BatchTradeActionRequestDto {
  action: BatchTradeAction
  account_id: AccountId
}

export interface BatchTradeSkippedDto {
  min_hold: number
  price_unavailable: number
  no_match: number
  locked: number
  error: number
}

export interface BatchTradeActionResponseDto {
  message: string
  affected: number
  attempted?: number
  skipped?: BatchTradeSkippedDto
  minHoldSeconds?: number
}

export interface ModifyPendingTradeRequestDto {
  trade_id: TradeId
  pending_price?: DecimalString
  stop_loss?: DecimalString
  take_profit?: DecimalString
}

export interface ModifyTradeRequestDto {
  trade_id: TradeId
  stop_loss?: DecimalString | null
  take_profit?: DecimalString | null
  move_to_breakeven?: boolean
}

/** Transitional exact JSON representation of the existing RETURNING record. */
export interface TradeMutationRecordDto {
  readonly [column: string]: JsonValue
}

export interface ModifyPendingTradeResponseDto {
  message: string
  trade: TradeMutationRecordDto
}

export interface ModifyTradeResponseDto {
  message: string
}

export interface CloseTradeRequestDto {
  trade_id: TradeId
  close_lots?: DecimalString
  screenshot_data_url?: string | null
}

/** Existing close wire format; numeric fields are retained for compatibility. */
export interface CloseTradeResponseDto {
  message: string
  pnl: number
  close_price: number
  is_partial: boolean
  remaining_lots: number
}

export interface TradeConflictErrorResponseDto {
  error: string
  code: 'TRADE_BUSY' | 'TRADE_ALREADY_PROCESSED'
}

export interface CancelTradeRequestDto {
  trade_id: TradeId
}

export interface CancelTradeResponseDto {
  message: string
}

export type TradeDirection = 'buy' | 'sell'
export type PendingOrderType = 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop'
export type TradeOrderType = 'market' | PendingOrderType

export interface OcoSiblingRequestDto {
  order_type: PendingOrderType
  pending_price: DecimalString
}

export interface OpenTradeRequestDto {
  account_id: AccountId
  instrument: string
  direction: TradeDirection
  lots: DecimalString
  stop_loss?: DecimalString
  take_profit?: DecimalString
  order_type?: TradeOrderType
  pending_price?: DecimalString
  screenshot_data_url?: string | null
  oco_sibling?: OcoSiblingRequestDto
}

export interface OpenTradeResponseDto {
  message: string
  trade_id: TradeId
  account_id: AccountId
  trade: TradeMutationRecordDto
  oco_sibling_trade_id?: TradeId | null
}

export interface OpenTradeErrorResponseDto {
  error: string
  code?: 'KYC_REQUIRED_FOR_FUNDED' | 'NOTIONAL_CEILING'
  kyc_status?: string
}

export interface UserNotificationDto {
  id: string
  type: string
  title: string | null
  message: string
  read: boolean
  created_at: IsoTimestamp
}

export interface NotificationMutationResponseDto {
  success: true
}

export interface AdminTraderPickerResponseDto {
  generated_at: IsoTimestamp
  traders: JsonValue[]
}

/** Existing admin trade-table wire shape. Money columns remain decimal strings. */
export interface AdminTradeListItemDto {
  id: TradeId
  account_id: AccountId
  user_id: UserId
  symbol: string
  type: string
  lots: DecimalString
  open_price: DecimalString
  close_price: DecimalString | null
  sl: DecimalString | null
  tp: DecimalString | null
  status: string
  demo_pnl: DecimalString | null
  commission: DecimalString | null
  bid: DecimalString | null
  ask: DecimalString | null
  open_time: IsoTimestamp
  close_time: IsoTimestamp | null
  /** Legacy admin response field; retained as a number until a versioned API change. */
  pnl: number
  r_multiple: number | null
}

export interface AdminTradeSummaryDto {
  total: number
  open: number
  pending: number
  closed: number
}

export interface AdminTradeListResponseDto {
  rows: AdminTradeListItemDto[]
  summary: AdminTradeSummaryDto
  pagination: AdminListPaginationDto
}

/** Existing force-close response; numeric fields are retained for compatibility. */
export interface AdminTradeForceCloseResponseDto {
  message: 'Trade force-closed successfully'
  pnl: number
  close_price: number
}

export interface AdminNewsProtectionSettingsDto {
  enabled: boolean
  lookahead_minutes: number
  max_lots_multiplier: number
  block_new_orders: boolean
}

export interface AdminRolloverGuardSettingsDto {
  enabled: boolean
  start_utc: string
  end_utc: string
  block_new_orders: boolean
}

export interface AdminRiskSettingSavedDto {
  message: 'News protection settings saved' | 'Rollover guard settings saved'
}

/** Existing risk-monitor wire values are numeric and require a versioned API to change. */
export interface AdminSpreadMonitorItemDto {
  instrument: string
  spread_points: number
  threshold_points: number
  is_alert: boolean
  updated_at: IsoTimestamp | null
}

export interface AdminDriftMonitorItemDto {
  instrument: string
  trades: number
  avg_move_points: number
  suspicious_quick_moves: number
}

export interface AdminSlippageMonitorResponseDto {
  generated_at: IsoTimestamp
  spread_monitor: AdminSpreadMonitorItemDto[]
  drift_monitor: AdminDriftMonitorItemDto[]
  suspicious_quick_moves: number
  sample_count: number
}

export interface AdminFeedInstrumentHealthDto {
  instrument: string
  bid: number
  ask: number
  spread_points: number
  spread_threshold: number
  seconds_since_update: number
  stale: boolean
  wide_spread: boolean
}

export interface AdminFeedAnomaliesResponseDto {
  generated_at: IsoTimestamp
  stale_threshold_seconds: number
  stale_count: number
  wide_spread_count: number
  any_anomaly: boolean
  instruments: AdminFeedInstrumentHealthDto[]
  anomalies: AdminFeedInstrumentHealthDto[]
}

export interface AdminGiftVoucherListItemDto {
  id: string
  code: string
  status: string
  account_size: DecimalString
  challenge_model_slug: string
  amount_paid: DecimalString
  gift_message: string | null
  recipient_email: string
  recipient_user_id: UserId | null
  issued_at: IsoTimestamp
  expires_at: IsoTimestamp | null
  claimed_at: IsoTimestamp | null
  purchaser_email: string
  purchaser_name: string | null
}

export interface AdminGiftVoucherListResponseDto {
  gifts: AdminGiftVoucherListItemDto[]
  total: number
  page: number
  page_size: number
}

export interface AdminGiftVoucherDto {
  id: string
  code: string
  purchaser_user_id: UserId
  order_id: string | null
  recipient_email: string
  recipient_user_id: UserId | null
  account_size: DecimalString
  challenge_model_slug: string
  amount_paid: DecimalString
  gift_message: string | null
  status: string
  issued_at: IsoTimestamp
  expires_at: IsoTimestamp | null
  claimed_at: IsoTimestamp | null
  claimed_order_id: string | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
}

export type ReferralSeasonStatus = 'upcoming' | 'active' | 'completed' | 'cancelled'

export interface ReferralSeasonDto {
  id: string
  slug: string
  title: string
  description: string | null
  status: ReferralSeasonStatus
  start_at: IsoTimestamp
  end_at: IsoTimestamp
  ranking_metric: string
  prize_pool: JsonValue
}

export interface ReferralSeasonEntryDto {
  new_paying_referrals: number
  final_rank: number | null
}

export interface ReferralSeasonDetailDto extends ReferralSeasonDto {
  my_entry: ReferralSeasonEntryDto | null
}

export interface ReferralSeasonLiveStandingDto {
  referrer_user_id: UserId
  full_name: string | null
  email: string
  new_paying_referrals: number
  rank: number
}

export interface ReferralSeasonFinalStandingDto {
  rank: number | null
  referrer_user_id: UserId
  new_paying_referrals: number
  full_name: string | null
  trader_uid: string | null
}

export interface ReferralSeasonVoucherDto {
  id: string
  code: string
  account_size: DecimalString
  challenge_model_slug: string
  status: string
  issued_at: IsoTimestamp
  expires_at: IsoTimestamp | null
  redeemed_at: IsoTimestamp | null
  season_title: string
  season_slug: string
  final_rank: number | null
}

export type AdminEmailJobDeliveryType = 'transactional' | 'automation'
export type AdminEmailJobAction = 'preview_email_job' | 'retry_email_job' | 'copy_preview_path'

export interface AdminEmailJobDto {
  id: string
  user_id: UserId | null
  to_email: string
  template_key: string
  payload_json: JsonValue
  status: string
  attempt_count: number
  last_error: string | null
  provider_message_id: string | null
  preview_url: string | null
  unique_key: string | null
  scheduled_for: IsoTimestamp
  last_attempt_at: IsoTimestamp | null
  sent_at: IsoTimestamp | null
  created_at: IsoTimestamp
  updated_at: IsoTimestamp
  full_name_hint: string
  delivery_type: AdminEmailJobDeliveryType
  allowed_actions: AdminEmailJobAction[]
}

export interface AdminEmailJobSummaryDto {
  total: number
  pending: number
  sending: number
  retry: number
  sent: number
  dead: number
}

export interface AdminListPaginationDto {
  current: number
  total: number
  total_items: number
  page_size: number
}

export interface AdminSavedViewCapabilitiesDto {
  resource: string
  can_save: true
  can_update: true
  can_delete: true
}

export interface AdminEmailJobListResultDto {
  summary: AdminEmailJobSummaryDto
  rows: AdminEmailJobDto[]
  pagination: AdminListPaginationDto
  facets: {
    status: Record<string, number>
    template_key: Record<string, number>
    delivery_type: Record<string, number>
  }
  default_sort: { key: 'created_at'; direction: 'desc' }
  saved_view_capabilities: AdminSavedViewCapabilitiesDto
  allRows: AdminEmailJobDto[]
}

export type AdminAccountLinkAction =
  | 'view_evidence'
  | 'view_graph'
  | 'confirm_sharing'
  | 'mark_false_positive'
  | 'mark_monitoring'
  | 'reopen_cluster'

export interface AdminAccountLinkClusterDto {
  id: string
  cluster_key: string
  score: number
  confidence: string
  member_user_ids: UserId[]
  member_count: number
  signal_types: string[]
  signal_summary: JsonValue
  status: string
  first_detected_at: IsoTimestamp
  last_detected_at: IsoTimestamp
  resolved_at: IsoTimestamp | null
  resolved_by: string | null
  resolution_note: string | null
  member_emails: string[]
  member_names: string[]
  evidence_count: number
  allowed_actions: AdminAccountLinkAction[]
}

export interface AdminAccountLinkSummaryDto {
  total: number
  open: number
  high_confidence: number
  confirmed: number
  false_positive: number
  users_involved: number
}

export interface AdminAccountLinkListResultDto {
  summary: AdminAccountLinkSummaryDto
  rows: AdminAccountLinkClusterDto[]
  pagination: AdminListPaginationDto
  facets: {
    confidence: Record<string, number>
    status: Record<string, number>
  }
  default_sort: { key: 'score'; direction: 'desc' }
  saved_view_capabilities: AdminSavedViewCapabilitiesDto
  allRows: AdminAccountLinkClusterDto[]
}

export type AdminKycSlaStatus = 'within_sla' | 'warning' | 'overdue' | 'breach'

export interface AdminKycSlaQueueItemDto {
  user_id: UserId
  full_name: string | null
  email: string
  country: string
  submitted_at: IsoTimestamp
  wait_hours: number
  wait_minutes: number
  accounts_total: number
  funded_accounts: number
  sla_status: AdminKycSlaStatus
}

export interface AdminKycSlaResponseDto {
  generated_at: IsoTimestamp
  sla_hours: number
  summary: {
    pending_total: number
    overdue_total: number
    breach_total: number
    avg_wait_hours: number
  }
  queue: AdminKycSlaQueueItemDto[]
}

export type AdminKycQualityRiskLevel = 'low' | 'medium' | 'high'

export interface AdminKycQualityFlagDto {
  user_id: UserId
  full_name: string | null
  email: string
  kyc_status: string
  submitted_at: IsoTimestamp
  id_document_path: string | null
  id_document_back_path: string | null
  selfie_path: string | null
  id_file_exists: boolean
  id_file_size: number
  back_file_exists: boolean
  back_file_size: number
  selfie_file_exists: boolean
  selfie_file_size: number
  quality_score: number
  risk_level: AdminKycQualityRiskLevel
  flags: string[]
}

export interface AdminKycQualityFlagsResponseDto {
  generated_at: IsoTimestamp
  summary: {
    total_profiles: number
    high_risk_count: number
    medium_risk_count: number
    missing_file_count: number
  }
  rows: AdminKycQualityFlagDto[]
}

export interface TraderAnalyticsAccountDto {
  id: AccountId
  user_id: UserId
  account_type: string
  account_size: DecimalString
  current_balance: DecimalString
  starting_balance: DecimalString
  peak_balance: DecimalString
  status: string
  profit_target: DecimalString | null
  max_drawdown_pct: DecimalString | null
  phase_start_date: IsoTimestamp | null
  phase_end_date: IsoTimestamp | null
  created_at: IsoTimestamp
  review_flag_reason: string | null
}

/** Existing analytics wire format; calculated monetary metrics remain numbers. */
export interface TraderAnalyticsPayloadDto {
  total_trades: number
  winning_trades: number
  losing_trades: number
  breakeven_trades: number
  win_rate: number
  total_pnl: number
  avg_win: number
  avg_loss: number
  profit_factor: number
  avg_rr: number
  avg_r_multiple: number | null
  r_distribution: number[]
  expectancy: number
  best_win_streak: number
  sharpe_30d: number | null
  best_trade: number
  worst_trade: number
  avg_trade_duration_mins: number
  drawdown_curve: JsonValue[]
  equity_curve_ranges: JsonValue
  heatmap: { [hour: string]: number }
  activity_heatmap: JsonValue
  breakdowns: {
    symbol: JsonValue[]
    weekday: JsonValue[]
    session: JsonValue[]
  }
  hold_time: JsonValue
  setup_report: JsonValue
  discipline_score: JsonValue
  risk_consistency_score: JsonValue
  breach_analysis: JsonValue
  payout_forecast: JsonValue
  improvement_suggestions: JsonValue
}

export interface TraderAnalyticsResponseDto {
  account: TraderAnalyticsAccountDto
  analytics: TraderAnalyticsPayloadDto
}
