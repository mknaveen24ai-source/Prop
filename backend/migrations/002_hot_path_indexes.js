exports.up = async function(knex) {
  await knex.raw('CREATE INDEX IF NOT EXISTS trades_account_status_idx ON trades(account_id, status)')
  await knex.raw('CREATE INDEX IF NOT EXISTS trades_status_open_time_idx ON trades(status, open_time)')
  await knex.raw('CREATE INDEX IF NOT EXISTS accounts_user_status_idx ON accounts(user_id, status)')
  await knex.raw('CREATE INDEX IF NOT EXISTS payouts_account_status_idx ON payouts(account_id, status)')
  await knex.raw('CREATE INDEX IF NOT EXISTS trade_logs_logged_at_idx ON trade_logs(logged_at)')
  return true
}

exports.down = async function(knex) {
  await knex.raw('DROP INDEX IF EXISTS trade_logs_logged_at_idx')
  await knex.raw('DROP INDEX IF EXISTS payouts_account_status_idx')
  await knex.raw('DROP INDEX IF EXISTS accounts_user_status_idx')
  await knex.raw('DROP INDEX IF EXISTS trades_status_open_time_idx')
  await knex.raw('DROP INDEX IF EXISTS trades_account_status_idx')
  return true
}
