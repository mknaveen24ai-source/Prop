/**
 * Migration 010: Apply "Challenge Models — Updated" business rules (2026-07-26)
 *
 * challenge_models / challenge_model_pricing pick up the new rule/pricing
 * values automatically via the upsert in backend/utils/stepModels.js on next
 * server boot — no migration needed for those tables. This migration handles
 * the two things that upsert can't reach: platform_settings rows that already
 * exist (INSERT ... ON CONFLICT DO NOTHING won't update an existing row), and
 * rule values already snapshotted onto in-progress accounts at creation time.
 *
 * Funded accounts need no snapshot recompute here — challengeEngine.js and
 * routes/payouts.js already read funded drawdown/consistency/payout rules
 * live from challenge_models by challenge_model_slug, so the new FUNDED_STAGE
 * values in stepModels.js take effect immediately on next boot. Only the
 * scaling multiplier/milestone count (stored, not re-derived on read) needs
 * recomputing here.
 */

const PHASE_RULES = {
  '1-step': {
    profitTargetPct: [16],
    consistencyPct: [15],
    timeLimitDays: [45],
    dailyDrawdownPct: 2,
    maxDrawdownPct: 4,
    minTradingDays: 5
  },
  '2-step': {
    profitTargetPct: [10, 8],
    consistencyPct: [15, 15],
    timeLimitDays: [45, 45],
    dailyDrawdownPct: 2,
    maxDrawdownPct: 4,
    minTradingDays: 5
  },
  '3-step': {
    profitTargetPct: [8, 6, 6],
    consistencyPct: [15, 15, 15],
    timeLimitDays: [45, 45, 45],
    dailyDrawdownPct: 2,
    maxDrawdownPct: 4,
    minTradingDays: 5
  }
}
const MIN_DAILY_PROFIT_PCT = 0.75
const SCALING_MILESTONE_PCT = 6
const SCALING_DOUBLING_FACTOR = 2
const SCALING_MAX_ACCOUNT_SIZE = 30000000

exports.up = async function (knex) {
  // ── platform_settings: the real payout-split / forex-lot-cap drivers ──
  await knex.raw(`UPDATE platform_settings SET value = '75' WHERE key = 'profit_share_pct'`)
  await knex.raw(`UPDATE platform_settings SET value = '0.10' WHERE key = 'forex_lots_per_1k'`)
  await knex.raw(`
    INSERT INTO platform_settings (key, value)
    VALUES ('max_open_positions', '10')
    ON CONFLICT (key) DO NOTHING
  `)

  // ── Active, in-progress challenge accounts: recompute snapshotted rules ──
  for (const [slug, rules] of Object.entries(PHASE_RULES)) {
    const accounts = await knex('accounts')
      .where({ challenge_model_slug: slug, status: 'active' })
      .whereIn('account_type', ['phase1', 'phase2', 'phase3'])
      .select('id', 'starting_balance', 'step_number', 'phase_start_date', 'phase_end_date')

    for (const acc of accounts) {
      const stepIdx = Math.max(0, (parseInt(acc.step_number, 10) || 1) - 1)
      const profitTargetPct = rules.profitTargetPct[stepIdx] ?? rules.profitTargetPct[rules.profitTargetPct.length - 1]
      const consistencyPct = rules.consistencyPct[stepIdx] ?? rules.consistencyPct[rules.consistencyPct.length - 1]
      const timeLimitDays = rules.timeLimitDays[stepIdx] ?? rules.timeLimitDays[rules.timeLimitDays.length - 1]
      const startingBalance = parseFloat(acc.starting_balance)
      const newProfitTarget = parseFloat((startingBalance * (profitTargetPct / 100)).toFixed(2))

      const phaseStart = acc.phase_start_date ? new Date(acc.phase_start_date) : new Date()
      const newEnd = new Date(phaseStart)
      newEnd.setUTCDate(newEnd.getUTCDate() + timeLimitDays)
      newEnd.setUTCHours(23, 59, 59, 999)
      const currentEnd = acc.phase_end_date ? new Date(acc.phase_end_date) : newEnd
      const extendedEnd = newEnd > currentEnd ? newEnd : currentEnd // never shorten an in-progress deadline

      await knex('accounts').where({ id: acc.id }).update({
        profit_target: newProfitTarget,
        max_drawdown_pct: rules.maxDrawdownPct,
        daily_drawdown_pct: rules.dailyDrawdownPct,
        consistency_max_day_pct: consistencyPct,
        min_trading_days: rules.minTradingDays,
        min_daily_profit_pct: MIN_DAILY_PROFIT_PCT,
        phase_end_date: extendedEnd
      })
    }
  }

  // ── Active funded accounts: recompute scaling under the new doubling/$30M model ──
  const fundedAccounts = await knex('accounts')
    .where({ account_type: 'funded', status: 'active' })
    .whereIn('challenge_model_slug', Object.keys(PHASE_RULES))
    .select('id', 'starting_balance', 'current_balance')

  for (const acc of fundedAccounts) {
    const startingBalance = parseFloat(acc.starting_balance)
    const currentBalance = parseFloat(acc.current_balance)
    if (!(startingBalance > 0)) continue

    const netProfitPct = ((currentBalance - startingBalance) / startingBalance) * 100
    const milestonesEarned = netProfitPct > 0 ? Math.floor(netProfitPct / SCALING_MILESTONE_PCT) : 0
    const rawMultiplier = Math.pow(SCALING_DOUBLING_FACTOR, milestonesEarned)
    const capMultiplier = SCALING_MAX_ACCOUNT_SIZE / startingBalance
    const nextMultiplier = Math.min(rawMultiplier, capMultiplier)

    await knex('accounts').where({ id: acc.id }).update({
      scaling_multiplier: nextMultiplier,
      scaling_milestones_claimed: milestonesEarned
    })
  }
}

exports.down = async function () {
  throw new Error('Migration 010 is not reversible — it recomputes rule values on live account rows. Restore from a pre-migration backup if needed.')
}
