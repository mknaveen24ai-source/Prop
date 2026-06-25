const pool = require('../db')
const { v4: uuidv4 } = require('uuid')
const logger = require('../utils/logger')
const { getTenantSettings } = require('./tenantPolicyService')
const {
  assertTenantMonthlyQuotaAvailable,
  createPromotionReview,
  markPromotionReviewApproved
} = require('./tenantMonthlyQuotaService')

let accountUidReady = false
let bbookPnlConflictTargetReady = false

async function ensureBbookPnlConflictTarget(db) {
  if (bbookPnlConflictTargetReady) return

  await db.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
    tenant_id         BIGINT NOT NULL DEFAULT 1,
    date              DATE NOT NULL,
    accounts_passed   INT NOT NULL DEFAULT 0,
    accounts_failed   INT NOT NULL DEFAULT 0,
    accounts_expired  INT NOT NULL DEFAULT 0,
    new_funded        INT NOT NULL DEFAULT 0
  )`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS date DATE NOT NULL DEFAULT CURRENT_DATE`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_passed INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_failed INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_expired INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS new_funded INT NOT NULL DEFAULT 0`)
  await db.query(`UPDATE bbook_pnl SET tenant_id = 1 WHERE tenant_id IS NULL`)
  await db.query(`UPDATE bbook_pnl SET date = CURRENT_DATE WHERE date IS NULL`)
  await db.query(`
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (PARTITION BY tenant_id, date ORDER BY ctid) AS rn,
             SUM(accounts_passed) OVER (PARTITION BY tenant_id, date) AS accounts_passed_sum,
             SUM(accounts_failed) OVER (PARTITION BY tenant_id, date) AS accounts_failed_sum,
             SUM(accounts_expired) OVER (PARTITION BY tenant_id, date) AS accounts_expired_sum,
             SUM(new_funded) OVER (PARTITION BY tenant_id, date) AS new_funded_sum
      FROM bbook_pnl
    )
    UPDATE bbook_pnl b
       SET accounts_passed = r.accounts_passed_sum,
           accounts_failed = r.accounts_failed_sum,
           accounts_expired = r.accounts_expired_sum,
           new_funded = r.new_funded_sum
      FROM ranked r
     WHERE b.ctid = r.ctid
       AND r.rn = 1
  `)
  await db.query(`
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (PARTITION BY tenant_id, date ORDER BY ctid) AS rn
      FROM bbook_pnl
    )
    DELETE FROM bbook_pnl b
      USING ranked r
     WHERE b.ctid = r.ctid
       AND r.rn > 1
  `)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS bbook_pnl_tenant_date_uq ON bbook_pnl(tenant_id, date)`)
  bbookPnlConflictTargetReady = true
}

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

  // BUG-26 FIX: Apply min/max bounds to every numeric setting.
  // Without bounds, an admin setting profit_target=0 would instantly promote
  // all active accounts; drawdown_pct=0 would instantly fail them all.
  return {
    phase2_profit_target_pct: Math.max(0.1, Math.min(100, parseFloat(settings.phase2_profit_target_pct || '5'))),
    phase2_max_drawdown_pct:  Math.max(0.1, Math.min(100, parseFloat(settings.phase2_max_drawdown_pct  || '10'))),
    phase2_day_limit:         Math.max(1,   Math.min(365, parseInt(settings.phase2_day_limit || '30', 10))),
    funded_max_drawdown_pct:  Math.max(0.1, Math.min(100, parseFloat(settings.funded_max_drawdown_pct || '5'))),
    phase1_drawdown_type: settings.phase1_drawdown_type || 'trailing',
    phase2_drawdown_type: settings.phase2_drawdown_type || 'trailing',
    funded_drawdown_type: settings.funded_drawdown_type || 'trailing'
  }
}

async function fetchProgressionSettings(db, tenantId = null) {
  const normalizedTenantId = parseInt(tenantId, 10)
  if (Number.isFinite(normalizedTenantId) && normalizedTenantId > 0) {
    const settings = await getTenantSettings(normalizedTenantId, [
      'phase2_profit_target_pct',
      'phase2_max_drawdown_pct',
      'phase2_day_limit',
      'funded_max_drawdown_pct',
      'phase1_drawdown_type',
      'phase2_drawdown_type',
      'funded_drawdown_type'
    ])
    return normalizeProgressionSettings(settings)
  }

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
          (tenant_id, user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status,
           phase_start_date, phase_end_date, account_uid)
          VALUES ($1, $2, 'phase2', $3, $3, $3, $3, $4, $5, 'active', NOW(), $6, $7)
          RETURNING id`,
    values: [acc.tenant_id || 1, acc.user_id, acc.account_size, profitTarget, settings.phase2_max_drawdown_pct, phaseEndDate, uuidv4()],
    bbookSql: `INSERT INTO bbook_pnl (tenant_id, date, accounts_passed)
               VALUES ($1, CURRENT_DATE, 1)
               ON CONFLICT (tenant_id, date) DO UPDATE
               SET accounts_passed = bbook_pnl.accounts_passed + 1`,
    bbookValues: [acc.tenant_id || 1],
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
          (tenant_id, user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, account_uid)
          VALUES ($1, $2, 'funded', $3, $3, $3, $3, 0, $4, 'active', NOW(), $5)
          RETURNING id`,
    values: [acc.tenant_id || 1, acc.user_id, acc.account_size, settings.funded_max_drawdown_pct, uuidv4()],
    bbookSql: `INSERT INTO bbook_pnl (tenant_id, date, new_funded)
               VALUES ($1, CURRENT_DATE, 1)
               ON CONFLICT (tenant_id, date) DO UPDATE
               SET new_funded = bbook_pnl.new_funded + 1`,
    bbookValues: [acc.tenant_id || 1],
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

  // BUG-13 FIX: Reject promotions where tenant_id is missing instead of
  // silently defaulting to tenant 1. Defaulting causes the new funded account
  // to appear under the wrong tenant's dashboard permanently.
  if (!acc.tenant_id) {
    logger.error('[progression] Cannot promote account — tenant_id is missing', {
      accountId: acc.id,
      userId: acc.user_id,
      accountType: acc.account_type
    })
    throw new Error(`Cannot promote account ${acc.id}: tenant_id is null. Verify user tenant assignment.`)
  }

  await ensureBbookPnlConflictTarget(db)

  // BUG-02 FIX: Wrap both writes in a transaction so that a crash between
  // the account insert and the bbook_pnl upsert cannot leave the P&L
  // dashboard counts permanently wrong.
  const client = db.connect ? await db.connect() : null
  const executor = client || db

  try {
    if (client) await client.query('BEGIN')

    const newAccount = await executor.query(plan.sql, plan.values)
    await executor.query(plan.bbookSql, plan.bbookValues || [])

    if (client) await client.query('COMMIT')

    return {
      new_account_id: newAccount.rows[0].id,
      event: plan.socketEvent,
      message: plan.socketMessage
    }
  } catch (err) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    if (client) client.release()
  }
}

async function createPendingPromotionReview(db, acc, options = {}) {
  if (!['phase1', 'phase2'].includes(String(acc?.account_type || '').toLowerCase())) return null
  return createPromotionReview(db, acc, options)
}

async function approvePromotionReview(db, review, settings, options = {}) {
  if (!review || String(review.status || '').toLowerCase() !== 'pending') {
    const error = new Error('Promotion review is not pending')
    error.statusCode = 400
    throw error
  }

  const sourceResult = await db.query(
    `SELECT *
       FROM accounts
      WHERE id::text = $1
        AND COALESCE(tenant_id, $2) = $2
      FOR UPDATE`,
    [String(review.source_account_id), review.tenant_id || 1]
  )
  const sourceAccount = sourceResult.rows[0]
  if (!sourceAccount) {
    const error = new Error('Source account not found')
    error.statusCode = 404
    throw error
  }
  if (String(sourceAccount.status || '').toLowerCase() !== 'passed') {
    const error = new Error('Source account must be passed before approval')
    error.statusCode = 400
    throw error
  }

  await assertTenantMonthlyQuotaAvailable(
    db,
    sourceAccount.tenant_id || review.tenant_id || 1,
    undefined,
    sourceAccount.account_size || review.account_size
  )
  const promoted = await promotePassedAccount(db, sourceAccount, settings)
  if (!promoted) {
    const error = new Error('No promotion path exists for this account')
    error.statusCode = 400
    throw error
  }

  const approvedReview = await markPromotionReviewApproved(db, review.id, {
    adminId: options.adminId || null,
    decisionNote: options.decisionNote || null,
    createdAccountId: promoted.new_account_id
  })

  return {
    ...promoted,
    review: approvedReview,
    source_account: sourceAccount
  }
}

module.exports = {
  ensureBbookPnlConflictTarget,
  normalizeProgressionSettings,
  fetchProgressionSettings,
  buildPromotionPlan,
  approvePromotionReview,
  createPendingPromotionReview,
  promotePassedAccount,
  __test__: {
    resetBbookPnlConflictTargetReady() {
      bbookPnlConflictTargetReady = false
    }
  }
}
