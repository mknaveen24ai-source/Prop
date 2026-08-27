import type {
  AccountId,
  DecimalString,
  IsoTimestamp,
  JsonValue,
  UserId
} from './primitives'

export type EnforcementAction =
  | 'lock_account'
  | 'force_close_open_trades'
  | 'flag_for_review'

export type EnforcementEventStatus = 'applied' | 'failed'

export interface ApplyEnforcementRequestDto {
  account_id: AccountId
  action: EnforcementAction | string
  reason?: string
  rule_id?: number | string | null
  payload?: JsonValue
}

export interface EnforcementEventDto {
  id: string
  rule_id: string | null
  account_id: AccountId | null
  user_id: UserId | null
  action: string
  payload_json: JsonValue
  status: string
  message: string | null
  created_at: IsoTimestamp
}

export interface ApplyEnforcementResponseDto {
  message: string
  event: EnforcementEventDto
}

export type FraudRiskLevel = 'low' | 'medium' | 'high'

export interface PayoutFraudScoreDto {
  id: string
  user_id: UserId
  account_id: AccountId
  amount_requested: DecimalString
  status: string
  requested_at: IsoTimestamp
  full_name: string
  email: string
  kyc_status: string | null
  account_size: DecimalString
  account_created_at: IsoTimestamp
  score: number
  risk_level: FraudRiskLevel
  account_age_days: number
  shared_ip_users: number
  reasons: string[]
}

export type DeviceGraphNodeType = 'user' | 'account' | 'ip'
export type DeviceGraphEdgeType = 'login_ip' | 'trade_ip' | 'account_ip' | 'owns'

export interface DeviceGraphNodeDto {
  id: string
  type: DeviceGraphNodeType
  label: string
}

export interface DeviceGraphEdgeDto {
  id: string
  from: string
  to: string
  type: DeviceGraphEdgeType
  weight: number
}

export interface DeviceGraphResponseDto {
  generated_at: IsoTimestamp
  nodes: DeviceGraphNodeDto[]
  edges: DeviceGraphEdgeDto[]
}
