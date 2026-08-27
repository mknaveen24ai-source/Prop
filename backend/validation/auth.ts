import type {
  AdminClaimsV1,
  AdminPreTwoFactorClaimsV1,
  PreTwoFactorClaimsV1,
  UserClaimsV1
} from '@propfirm/contracts'
import { z } from 'zod'

const jwtTimes = {
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive()
}

const adminClaimsObject = z.object({
  adminId: z.string().min(1).nullable(),
  role: z.string().min(1),
  atv: z.number().int().positive(),
  email: z.email().nullable(),
  full_name: z.string().nullable(),
  src: z.string().min(1),
  type: z.never().optional(),
  ...jwtTimes
})

export const userClaimsSchema: z.ZodType<UserClaimsV1> = z.object({
  userId: z.string().uuid(),
  email: z.email(),
  tv: z.number().int().positive(),
  type: z.never().optional(),
  ...jwtTimes
}).passthrough()

export const adminClaimsSchema: z.ZodType<AdminClaimsV1> = adminClaimsObject.passthrough()

export const preTwoFactorClaimsSchema: z.ZodType<PreTwoFactorClaimsV1> = z.object({
  userId: z.string().uuid(),
  email: z.email(),
  type: z.literal('pre_2fa'),
  tv: z.number().int().positive(),
  ...jwtTimes
}).passthrough()

export const adminPreTwoFactorClaimsSchema: z.ZodType<AdminPreTwoFactorClaimsV1> = adminClaimsObject.extend({
    type: z.literal('pre_2fa_admin'),
    enrol: z.boolean().optional()
  })
  .passthrough()
  .transform((value) => {
    if (value.enrol !== undefined) return value
    const { enrol: _enrol, ...withoutUndefined } = value
    return withoutUndefined
  })

export function isUserClaims(value: unknown): value is UserClaimsV1 {
  return userClaimsSchema.safeParse(value).success
}

export function isAdminClaims(value: unknown): value is AdminClaimsV1 {
  return adminClaimsSchema.safeParse(value).success
}

export function isPreTwoFactorClaims(value: unknown): value is PreTwoFactorClaimsV1 {
  return preTwoFactorClaimsSchema.safeParse(value).success
}

export function isAdminPreTwoFactorClaims(value: unknown): value is AdminPreTwoFactorClaimsV1 {
  return adminPreTwoFactorClaimsSchema.safeParse(value).success
}
