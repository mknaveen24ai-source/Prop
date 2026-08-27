import type {
  AdminClaimsV1,
  AdminPreTwoFactorClaimsV1,
  DeviceSignatureV1,
  PreTwoFactorClaimsV1,
  UserClaimsV1
} from '@propfirm/contracts'

declare global {
  namespace Express {
    interface AuthenticatedUser extends UserClaimsV1 {
      full_name?: string
      role?: string
      isAdmin?: boolean
    }

    interface AuthenticatedAdmin extends AdminClaimsV1 {
      auth_source: string
      totp_enabled: boolean
      permissions: string[]
      enrolment_only?: boolean
    }

    interface UploadedFileMetadata {
      fieldname: string
      originalname: string
      mimetype: string
      size: number
      filename?: string
      path?: string
    }

    interface Request {
      requestId?: string
      requestCount?: number
      country?: string
      user?: AuthenticatedUser
      admin?: AuthenticatedAdmin
      pre2fa?: PreTwoFactorClaimsV1
      adminPre2fa?: AdminPreTwoFactorClaimsV1
      deviceSignature?: DeviceSignatureV1
      uploadedFileMetadata?: UploadedFileMetadata
    }

    interface Locals {
      validatedBody?: unknown
      validatedQuery?: unknown
      validatedParams?: unknown
    }
  }
}

export type {}
