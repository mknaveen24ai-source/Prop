/**
 * Migration 007: Add phone OTP verification support
 *
 * Adds a standalone `phone_otp_pending` table that stores OTP codes for
 * phone numbers that have NOT yet created an account.  This lets us verify
 * a phone number before the user row exists.
 *
 * Also adds `phone_verified` flag to the `users` table so we can track it
 * after account creation.
 */

exports.up = async function (knex) {
  // Standalone table for pre-registration phone OTP verification
  const exists = await knex.schema.hasTable('phone_otp_pending')
  if (!exists) {
    await knex.schema.createTable('phone_otp_pending', (table) => {
      table.bigIncrements('id').primary()
      table.string('phone', 30).notNullable()
      table.integer('tenant_id').nullable()
      table.string('otp_code', 6).notNullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
    await knex.raw(`CREATE INDEX IF NOT EXISTS phone_otp_pending_phone_idx ON phone_otp_pending(phone, tenant_id)`)
  }

  // Mark users as phone-verified after account creation
  await knex.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT FALSE`)
}

exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE users DROP COLUMN IF EXISTS phone_verified`)
  await knex.raw(`DROP INDEX IF EXISTS phone_otp_pending_phone_idx`)
  await knex.schema.dropTableIfExists('phone_otp_pending')
}
