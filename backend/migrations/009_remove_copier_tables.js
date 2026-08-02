/**
 * Migration 009: Remove trade copier system
 *
 * The MT5 trade-copier subsystem (watcher process, admin UI, API surface) has
 * been removed from the application. This drops the 10 copier_* tables and
 * clears any copier_* keys left in platform_settings.
 */

const COPIER_TABLES_TO_DROP = [
  'copier_job_attempts',
  'copier_jobs',
  'copier_events',
  'copier_position_links',
  'copier_master_followers',
  'copier_symbol_mappings',
  'copier_followers',
  'copier_masters',
  'copier_alert_endpoints',
  'copier_runtime_status',
  'copier_signal_logs'
]

exports.up = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${COPIER_TABLES_TO_DROP.join(', ')} CASCADE`)
  await knex.raw(`DELETE FROM platform_settings WHERE key LIKE 'copier_%'`)
}

exports.down = async function () {
  throw new Error('Migration 009 is not reversible — the trade copier system has been permanently removed. Restore from a pre-migration backup if needed.')
}
