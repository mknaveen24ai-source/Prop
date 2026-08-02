'use strict'
/**
 * Competition Bot Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Periodically moves demo-labeled bot participants on active competition
 * leaderboards via a small randomized ledger P&L injection — no real trade
 * execution. Every balance change goes through applyBalanceAdjustment(),
 * never a raw `UPDATE accounts SET current_balance = ...`, so each tick is
 * fully audited in balance_adjustments and composes with
 * utils/competitions.js's existing profit_usd/profit_pct leaderboard
 * calculation (current_balance - starting_balance) with zero query changes.
 *
 * Deliberately a simple symmetric random walk sized as a percentage of the
 * bot's current balance — not a trading simulator. Ticks at a slower cadence
 * than the 30s challenge/competition engines so movement reads as gradual.
 */

const pool = require('../db')
const logger = require('../utils/logger')
const { getTenantSettingsMap, parseBooleanSetting } = require('../utils/tenantSettings')
const { applyBalanceAdjustment } = require('../utils/balanceAdjustments')

async function tickCompetitionBots() {
  const settings = await getTenantSettingsMap(['competition_bot_tick_enabled', 'competition_bot_volatility_pct_per_tick'])
  if (!parseBooleanSetting(settings.competition_bot_tick_enabled, false)) return

  const volatilityPct = (parseFloat(settings.competition_bot_volatility_pct_per_tick) || 0.3) / 100

  const entriesResult = await pool.query(
    `SELECT ce.id AS entry_id, ce.competition_id, a.id AS account_id, a.current_balance
       FROM competition_entries ce
       JOIN accounts a ON a.id = ce.account_id
       JOIN competitions c ON c.id = ce.competition_id
       JOIN users u ON u.id = ce.user_id
      WHERE ce.status = 'active' AND c.status = 'active' AND u.is_bot = TRUE`
  )

  for (const row of entriesResult.rows) {
    const client = await pool.connect()
    try {
      const currentBalance = parseFloat(row.current_balance || 0)
      let deltaAmount = Math.round(currentBalance * volatilityPct * (Math.random() * 2 - 1) * 100) / 100
      // Safety clamp — never let a single tick wipe out more than half the
      // account, so a bot can't be driven to (or past) zero balance.
      if (currentBalance + deltaAmount < currentBalance * 0.5) {
        deltaAmount = Math.round(-currentBalance * 0.5 * 100) / 100
      }
      if (deltaAmount === 0) continue

      await client.query('BEGIN')
      await applyBalanceAdjustment(client, {
        accountId: row.account_id,
        amount: deltaAmount,
        source: 'competition_bot_tick',
        reason: 'Automated bot P&L simulation tick',
        createdBy: 'system',
        competitionId: row.competition_id,
        competitionEntryId: row.entry_id
      })
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      logger.error(`Competition bot service: tick failed for entry ${row.entry_id}:`, { error: err.message })
    } finally {
      client.release()
    }
  }
}

module.exports = { tickCompetitionBots }
