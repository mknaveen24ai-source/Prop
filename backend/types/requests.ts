import type { Request as ExpressRequest } from 'express'

export type AuthenticatedRequest = ExpressRequest & {
  user: Express.AuthenticatedUser
}

export type AdminRequest = ExpressRequest & {
  admin: Express.AuthenticatedAdmin
}

export type PreTwoFactorRequest = ExpressRequest & {
  pre2fa: NonNullable<ExpressRequest['pre2fa']>
}

export type AdminPreTwoFactorRequest = ExpressRequest & {
  adminPre2fa: NonNullable<ExpressRequest['adminPre2fa']>
}

export function hasAuthenticatedUser(request: ExpressRequest): request is AuthenticatedRequest {
  return request.user !== undefined
}

export function hasAuthenticatedAdmin(request: ExpressRequest): request is AdminRequest {
  return request.admin !== undefined
}
