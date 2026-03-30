const pool = require('../db')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')

let accountUidReady = false
async function ensureAccountUidColumn(db) {
  if (accountUidReady) return
  try {
    await db.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_uid TEXT`)
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_uid_uq ON accounts(account_uid)`)
    accountUidReady = true
  } catch (_) {
    // Best-effort: if schema check fails, allow caller to handle DB error.
  }
}

function normalizeProgressionSettings(input) {
  const settings = {}

  if (Array.isArray(input)) {
    input.forEach((row) => { settings[row.key] = row.value })
  } else if (input && typeof input === 'object') {
    Object.assign(settings, input)
  }

  return {
    phase2_profit_target_pct: parseFloat(settings.phase2_profit_target_pct || '5'),
    phase2_max_drawdown_pct:  parseFloat(settings.phase2_max_drawdown_pct  || '10'),
    phase2_day_limit:         parseInt(settings.phase2_day_limit || '30', 10),
    funded_max_drawdown_pct:  parseFloat(settings.funded_max_drawdown_pct || '5'),
    phase1_drawdown_type: settings.phase1_drawdown_type || 'trailing',
    phase2_drawdown_type: settings.phase2_drawdown_type || 'trailing',
    funded_drawdown_type: settings.funded_drawdown_type || 'trailing'
  }
}

async function fetchProgressionSettings(db) {
  const result = await db.query(
    `SELECT key, value FROM platform_settings
     WHERE key IN (
       'phase2_profit_target_pct', 'phase2_max_drawdown_pct', 'phase2_day_limit',
       'funded_max_drawdown_pct',
       'phase1_drawdown_type', 'phase2_drawdown_type', 'funded_drawdown_type'
     )`
  )
  return normalizeProgressionSettings(result.rows)
}

function buildPhase2InsertArgs(acc, settings) {
  // BUG FIX 15: use UTC date for phase_end_date to avoid timezone off-by-one
  const phaseEndDate = new Date()
  phaseEndDate.setUTCDate(phaseEndDate.getUTCDate() + settings.phase2_day_limit)
  phaseEndDate.setUTCHours(23, 59, 59, 999)

  const profitTarget = parseFloat(
    (parseFloat(acc.account_size) * (settings.phase2_profit_target_pct / 100)).toFixed(2)
  )

  logger.info(
    `[progression] Creating Phase 2 for user ${acc.user_id}: ` +
    `size=$${acc.account_size} target=${settings.phase2_profit_target_pct}% ($${profitTarget}) ` +
    `maxDD=${settings.phase2_max_drawdown_pct}% days=${settings.phase2_day_limit}`
  )

  return {
    sql: `INSERT INTO accounts
          (user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status,
           phase_start_date, phase_end_date, account_uid)
          VALUES ($1, 'phase2', $2, $2, $2, $2, $3, $4, 'active', NOW(), $5, $6)
          RETURNING id`,
    values: [acc.user_id, acc.account_size, profitTarget, settings.phase2_max_drawdown_pct, phaseEndDate, uuidv4()],
    bbookSql: `INSERT INTO bbook_pnl (date, accounts_passed)
               VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE
               SET accounts_passed = bbook_pnl.accounts_passed + 1`,
    socketEvent: 'phase1_passed',
    socketMessage: `Phase 1 PASSED! Your Phase 2 challenge is now active. Target: ${settings.phase2_profit_target_pct}%`
  }
}

function buildFundedInsertArgs(acc, settings) {
  logger.info(
    `[progression] Creating Funded account for user ${acc.user_id}: ` +
    `size=$${acc.account_size} maxDD=${settings.funded_max_drawdown_pct}%`
  )

  return {
    sql: `INSERT INTO accounts
          (user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, account_uid)
          VALUES ($1, 'funded', $2, $2, $2, $2, 0, $3, 'active', NOW(), $4)
          RETURNING id`,
    values: [acc.user_id, acc.account_size, settings.funded_max_drawdown_pct, uuidv4()],
    bbookSql: `INSERT INTO bbook_pnl (date, new_funded)
               VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE
               SET new_funded = bbook_pnl.new_funded + 1`,
    socketEvent: 'phase2_passed',
    socketMessage: 'Phase 2 PASSED! You are now a Funded Trader. Welcome to the team!'
  }
}

function buildPromotionPlan(acc, settings) {
  if (acc.account_type === 'phase1') return buildPhase2InsertArgs(acc, settings)
  if (acc.account_type === 'phase2') return buildFundedInsertArgs(acc, settings)
  return null
}

async function promotePassedAccount(db, acc, settings) {
  const plan = buildPromotionPlan(acc, settings)
  if (!plan) return null

  // FIX (Bug 16): Removed ensureAccountUidColumn(db) call.
  // The account_uid column is already created by server.js ensureUniqueIds()
  // at startup. Running DDL inside a transaction can cause issues with
  // concurrent transactions and added unnecessary overhead on every promotion.

  const newAccount = await db.query(plan.sql, plan.values)
  await db.query(plan.bbookSql)

  return {
    new_account_id: newAccount.rows[0].id,
    event: plan.socketEvent,
    message: plan.socketMessage
  }
}

module.exports = {
  normalizeProgressionSettings,
  fetchProgressionSettings,
  buildPromotionPlan,
  promotePassedAccount
}
