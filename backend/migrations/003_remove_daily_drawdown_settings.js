exports.up = async function(knex) {
  await knex('platform_settings')
    .whereIn('key', [
      'phase1_daily_drawdown_pct',
      'phase2_daily_drawdown_pct',
      'funded_daily_drawdown_pct'
    ])
    .del()
  return true
}

exports.down = async function(knex) {
  const defaults = [
    ['phase1_daily_drawdown_pct', '5'],
    ['phase2_daily_drawdown_pct', '5'],
    ['funded_daily_drawdown_pct', '5']
  ]

  for (const [key, value] of defaults) {
    await knex('platform_settings')
      .insert({ key, value })
      .onConflict('key')
      .ignore()
  }

  return true
}
