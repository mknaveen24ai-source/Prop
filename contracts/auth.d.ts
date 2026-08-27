import type { AdminId, IsoTimestamp, UserId } from './primitives'

export interface UserClaimsV1 {
  userId: UserId
  email: string
  tv: number
  iat: number
  exp: number
}

export interface AdminClaimsV1 {
  adminId: AdminId | null
  role: string
  atv: number
  email: string | null
  full_name: string | null
  src: string
  iat: number
  exp: number
}

export interface PreTwoFactorClaimsV1 {
  userId: UserId
  email: string
  type: 'pre_2fa'
  tv: number
  iat: number
  exp: number
}

export interface AdminPreTwoFactorClaimsV1 extends AdminClaimsV1 {
  type: 'pre_2fa_admin'
  enrol?: boolean
}

export interface RefreshSessionClaimsV1 {
  sub: UserId
  session_id: string
  token_version: number
  issued_at: IsoTimestamp
  expires_at: IsoTimestamp
}

export interface DeviceSignatureV1 {
  version: number
  hash: string
  components: Record<string, string>
}
