import type {
  AccountId,
  CertificateId,
  DecimalString,
  IsoTimestamp,
  JsonValue,
  TradeId,
  UserId
} from './primitives'
import type { SocketErrorV1 } from './errors'

export interface PriceQuoteDto {
  instrument?: string
  bid: number
  ask: number
  timestamp?: number | IsoTimestamp
}

export type PriceMapDto = Record<string, PriceQuoteDto>
export type PriceUpdateDto =
  | PriceMapDto
  | PriceQuoteDto
  | { t: number; p: PriceMapDto }

/**
 * Legacy realtime equity frame. These fields are numbers in the current
 * Socket.IO protocol; the TypeScript migration models that wire behavior and
 * does not silently convert it. A future protocol version may replace them
 * with DecimalString values as an explicit API change.
 */
export interface EquityUpdateDto {
  account_id: AccountId
  equity?: number
  floating_pnl?: number
  current_balance?: number
  drawdown_floor?: number
  drawdown_used_pct?: number
  daily_drawdown_used_pct?: number
  daily_drawdown_limit_pct?: number | null
  profit_remaining?: number
}

export interface AccountUpdateDto {
  event?: string
  message?: string
  account_id?: AccountId
  account_ids?: AccountId[]
  new_account_id?: AccountId
  /** Legacy engine frames currently emit numeric or null PnL values. */
  pnl?: DecimalString | number | null
  review_id?: string
  target_account_type?: string
}

export interface TradeClosedDto {
  trade_id?: TradeId
  tradeId?: TradeId
  instrument?: string
  pnl?: DecimalString
  demo_pnl?: DecimalString
  reason?: string
}

export interface PlatformNotificationDto {
  id?: string
  title?: string
  message: string
  type?: 'info' | 'success' | 'warning' | 'error' | string
  created_at?: IsoTimestamp
}

export interface UserTypingDto {
  conversationId: number
  isTyping: boolean
  isAdmin?: boolean
  userId?: UserId
}

export interface InstrumentSubscriptionResultDto {
  subscribed: number
}

export interface FeedHealthChangedDto {
  healthy: boolean
  reason: string | null
  age_ms: number | null
  suspended_since?: IsoTimestamp
  outage_ms?: number | null
}

export interface SocketAcknowledgementV1<T> {
  ok: boolean
  data?: T
  error?: SocketErrorV1
}

export interface ServerToClientEvents {
  price_update: (payload: PriceUpdateDto) => void
  subscribed_instruments: (payload: InstrumentSubscriptionResultDto) => void
  auth_error: (payload: { error: string }) => void
  position_update: (payload: { tradeId?: TradeId; trade_id?: TradeId; floatingPnL?: DecimalString; floating_pnl?: DecimalString }) => void
  trade_opened: (payload: { position: JsonValue }) => void
  trade_closed: (payload: TradeClosedDto) => void
  sl_triggered: (payload: TradeClosedDto & { slippage_pips?: number }) => void
  tp_triggered: (payload: TradeClosedDto) => void
  equity_update: (payload: EquityUpdateDto) => void
  account_update: (payload: AccountUpdateDto) => void
  drawdown_warning: (payload: {
    message: string
    account_id?: AccountId
    percentage?: number
    warning_level?: number
    realised_drawdown_pct?: number
    max_drawdown_pct?: number
  }) => void
  account_passed: (payload: { phase?: string }) => void
  payout_approved: (payload: { amount: DecimalString }) => void
  certificate_awarded: (payload: { public_id: CertificateId; title?: string }) => void
  kyc_status_changed: (payload: { status: string; reason?: string }) => void
  platform_notification: (payload: PlatformNotificationDto) => void
  chat_new_message: (payload: JsonValue) => void
  chat_message_received: (payload: JsonValue) => void
  user_typing: (payload: UserTypingDto) => void
  force_logout: (payload: { reason?: string }) => void
  admin_violation_updated: (payload: JsonValue) => void
  admin_enforcement_event: (payload: JsonValue) => void
  admin_command_center_updated: (payload: JsonValue) => void
  admin_alert: (payload: JsonValue) => void
  opposing_trade_detected: (payload: JsonValue) => void
  competition_ended: (payload: { competition_id: string; slug: string }) => void
  referral_season_ended: (payload: { season_id: string; slug: string }) => void
  feed_health_changed: (payload: FeedHealthChangedDto) => void
  payout_sla_breached: (payload: JsonValue) => void
  admin_promotion_review_updated: (payload: JsonValue) => void
  payout_awaiting_second_approval: (payload: JsonValue) => void
  payout_approved_alert: (payload: JsonValue) => void
}

export interface ClientToServerEvents {
  subscribe_instruments: (instruments: string[]) => void
  join_account: (userId: UserId | 'admin') => void
  join_chat: (conversationId: number | string) => void
  leave_chat: (conversationId: number | string) => void
  typing_start: (payload: { conversationId: number | string; isTyping: boolean }) => void
}

export interface InterServerEvents {
  trade_index_sync: (payload: JsonValue) => void
}

export interface SocketData {
  userId?: UserId
  adminId?: string | null
  isAdmin?: boolean
  sessionId?: string
  tokenVersion?: number
  adminTokenVersion?: number
}
