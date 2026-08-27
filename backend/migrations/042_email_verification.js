/**
 * Migration 042: replace phone OTP with email verification.
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY: registration was completely broken.
 *
 * frontend/src/pages/Register.jsx posted to /api/auth/phone-otp/send as step 1
 * of a two-step signup, then /api/auth/phone-otp/verify, and only then to
 * /api/auth/register. Neither OTP endpoint has ever existed — routes/auth.js
 * registers /register, /login, /me, /forgot-password, /reset-password, /logout,
 * /logout-all, /profile/:userId and five 2FA routes, and nothing else. Every
 * signup 404'd on the first submit, so no account could be created through the
 * UI at all. Migration 007 created the phone_otp_pending table for a feature
 * whose server half was never written.
 *
 * Registration is now a single step straight to /api/auth/register, and the
 * identity signal moves to email: a verification token is issued at signup and
 * confirmed by /api/auth/verify-email.
 *
 * ── Existing users are grandfathered ──
 *
 * email_verified defaults FALSE for new rows, but every row that exists when
 * this migration runs is set TRUE. Those accounts were created before the
 * requirement existed; flipping them to unverified would lock out live traders
 * — including anyone mid-challenge — for a rule they were never given a chance
 * to satisfy.
 *
 * ── Dropped ──
 *
 * phone_otp_pending: no code reads or writes it (the only references anywhere
 * are migrations 007 and 008's tenant-column list).
 * users.phone_verified: written by nothing, read by nothing.
 * users.phone itself is KEPT — it is collected at registration, shown in the
 * admin trader view, and used as a support contact.
 */

exports.up = async function (knex) {
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token TEXT`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_sent_at TIMESTAMPTZ`)

  // Grandfather everyone who already has an account.
  await knex.raw(`UPDATE users SET email_verified = TRUE WHERE email_verified = FALSE`)

  // Token is stored as a SHA-256 hash, so this index is over the hash, not the
  // secret. Partial so it only covers rows with a pending token.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_users_email_verification_token
      ON users (email_verification_token)
     WHERE email_verification_token IS NOT NULL
  `)

  await knex.raw(`DROP TABLE IF EXISTS phone_otp_pending`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS phone_verified`)

  return true
}

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS idx_users_email_verification_token`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS email_verification_sent_at`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS email_verification_token`)
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS email_verified`)
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`)
  // phone_otp_pending is intentionally NOT recreated: nothing has ever read it.
  return true
}
