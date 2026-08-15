/**
 * Seed platform_settings.admin_token_version (audit finding H-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * authenticateAdmin's legacy env-fallback branch revokes leaked admin tokens by
 * comparing the token's `atv` claim against this row. The check was written as:
 *
 *     if (result.rows.length > 0) { ...compare... }
 *
 * so when the row did not exist the check was skipped entirely and a leaked
 * super-admin token stayed valid to its 24-hour expiry with no kill switch. No
 * migration ever created the row — its INSERT existed only as a comment in
 * routes/middleware.js.
 *
 * Seeding it here lets that branch fail closed instead.
 *
 * To revoke every admin session immediately:
 *
 *     UPDATE platform_settings SET value = (value::int + 1)::text
 *      WHERE key = 'admin_token_version';
 */

exports.up = async function (knex) {
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('admin_token_version', '1')
    ON CONFLICT (key) DO NOTHING
  `)
  console.log('✓ admin_token_version seeded')
  return true
}

exports.down = async function (knex) {
  // Removing the row re-opens H-07 (the version check silently stops running),
  // so this deliberately leaves it in place.
  await knex.raw('SELECT 1')
  return true
}
