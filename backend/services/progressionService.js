const pool = require('../db')
const logger = require('../utils/logger')
const { getTenantSettings } = require('./tenantPolicyService')
const { fetchStepModelBySlug } = require('../utils/stepModels')
const { generateAccountUid } = require('../utils/accountIds')
const {
  createPromotionReview,
  markPromotionReviewApproved
} = require('./tenantMonthlyQuotaService')

let accountUidReady = false
let bbookPnlConflictTargetReady = false

async function ensureBbookPnlConflictTarget(db) {
  if (bbookPnlConflictTargetReady) return

  await db.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
    date              DATE NOT NULL,
    accounts_passed   INT NOT NULL DEFAULT 0,
    accounts_failed   INT NOT NULL DEFAULT 0,
    accounts_expired  INT NOT NULL DEFAULT 0,
    new_funded        INT NOT NULL DEFAULT 0
  )`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS date DATE NOT NULL DEFAULT CURRENT_DATE`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_passed INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_failed INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS accounts_expired INT NOT NULL DEFAULT 0`)
  await db.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS new_funded INT NOT NULL DEFAULT 0`)
  await db.query(`UPDATE bbook_pnl SET date = CURRENT_DATE WHERE date IS NULL`)
  await db.query(`
    WITH ranked AS (
      SELECT ctid,
             ROW_NUMBER() OVER (PARTITION BY date ORDER BY ctid) AS rn,
             SUM(accounts_passed) OVER (PARTITION BY date) AS accounts_passed_sum,
             SUM(accounts_failed) OVER (PARTITION BY date) AS accounts_failed_sum,
             SUM(accounts_expired) OVER (PARTITION BY date) AS accounts_expired_sum,
             SUM(new_funded) OVER (PARTITION BY date) AS new_funded_sum
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
             ROW_NUMBER() OVER (PARTITION BY date ORDER BY ctid) AS rn
      FROM bbook_pnl
    )
    DELETE FROM bbook_pnl b
      USING ranked r
     WHERE b.ctid = r.ctid
       AND r.rn > 1
  `)
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS bbook_pnl_date_uq ON bbook_pnl(date)`)
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

async function fetchProgressionSettings() {
  const settings = await getTenantSettings([
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

// Legacy fallback path — used only if an account somehow has no `challenge_model_slug`
// (e.g. created before the step-model system existed). New accounts always carry
// a step_model, so buildNextPhaseStepModelPlan below is the normal path.
async function buildPhase2InsertArgs(acc, settings, db) {
  // BUG FIX 15: use UTC date for phase_end_date to avoid timezone off-by-one
  const phaseEndDate = new Date()
  phaseEndDate.setUTCDate(phaseEndDate.getUTCDate() + settings.phase2_day_limit)
  phaseEndDate.setUTCHours(23, 59, 59, 999)

  const profitTarget = parseFloat(
    (parseFloat(acc.account_size) * (settings.phase2_profit_target_pct / 100)).toFixed(2)
  )
  const accountUid = await generateAccountUid(db, { accountType: 'phase2', challengeModelSlug: null })

  return {
    sql: `INSERT INTO accounts
          (user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status,
           phase_start_date, phase_end_date, account_uid)
          VALUES ($1, 'phase2', $2, $2, $2, $2, $3, $4, 'active', NOW(), $5, $6)
          RETURNING id`,
    values: [acc.user_id, acc.account_size, profitTarget, settings.phase2_max_drawdown_pct, phaseEndDate, accountUid],
    bbookSql: `INSERT INTO bbook_pnl (date, accounts_passed)
               VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE
               SET accounts_passed = bbook_pnl.accounts_passed + 1`,
    bbookValues: [],
    socketEvent: 'phase1_passed',
    socketMessage: `Phase 1 PASSED! Your Phase 2 challenge is now active. Target: ${settings.phase2_profit_target_pct}%`
  }
}

async function buildFundedInsertArgs(acc, settings, db) {
  const accountUid = await generateAccountUid(db, { accountType: 'funded', challengeModelSlug: null })
  return {
    sql: `INSERT INTO accounts
          (user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, account_uid)
          VALUES ($1, 'funded', $2, $2, $2, $2, 0, $3, 'active', NOW(), $4)
          RETURNING id`,
    values: [acc.user_id, acc.account_size, settings.funded_max_drawdown_pct, accountUid],
    bbookSql: `INSERT INTO bbook_pnl (date, new_funded)
               VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE
               SET new_funded = bbook_pnl.new_funded + 1`,
    bbookValues: [],
    socketEvent: 'phase2_passed',
    socketMessage: 'Phase 2 PASSED! You are now a Funded Trader. Welcome to the team!'
  }
}

// Step-model-aware promotion — every account created since the 1/2/3-step
// system shipped carries `challenge_model_slug`/`step_number`, so the next
// phase (or funded promotion) is resolved from `challenge_models` instead of
// hardcoded phase1/phase2 settings.
async function buildNextPhaseStepModelPlan(acc, stepModel, db) {
  const currentStep = parseInt(acc.step_number || 1, 10)
  const nextStep = currentStep + 1
  const accountUid = await generateAccountUid(db, {
    accountType: nextStep <= stepModel.steps ? `phase${nextStep}` : 'funded',
    challengeModelSlug: stepModel.slug
  })
  const currentPhaseName = Array.isArray(stepModel.profit_targets_pct) && stepModel.profit_targets_pct.length > 1
    ? `Phase ${currentStep}`
    : stepModel.name

  logger.info(
    `[progression] Promoting ${stepModel.slug} account for user ${acc.user_id}: ` +
    `step ${currentStep} -> ${nextStep <= stepModel.steps ? `phase${nextStep}` : 'funded'} (size=$${acc.account_size})`
  )

  if (nextStep <= stepModel.steps) {
    const phaseIdx0 = nextStep - 1
    const profitTargetPct = parseFloat(stepModel.profit_targets_pct[phaseIdx0])
    const dayLimit = parseInt(stepModel.time_limits_days[phaseIdx0], 10)
    const consistencyPct = Array.isArray(stepModel.consistency_max_day_pct_by_phase)
      ? parseFloat(stepModel.consistency_max_day_pct_by_phase[phaseIdx0])
      : parseFloat(stepModel.consistency_max_day_pct)
    const profitTarget = parseFloat((parseFloat(acc.account_size) * (profitTargetPct / 100)).toFixed(2))

    const phaseEndDate = new Date()
    phaseEndDate.setUTCDate(phaseEndDate.getUTCDate() + dayLimit)
    phaseEndDate.setUTCHours(23, 59, 59, 999)

    return {
      sql: `INSERT INTO accounts
            (user_id, account_type, account_size, current_balance, starting_balance,
             peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, phase_end_date, account_uid,
             challenge_model_id, challenge_model_slug, step_number, daily_drawdown_pct, drawdown_type,
             consistency_max_day_pct, min_trading_days, min_daily_profit_pct, eod_peak_equity, qualifying_days_count,
             parent_account_id)
            VALUES ($1, $2, $3, $3, $3, $3, $4, $5, 'active', NOW(), $6, $7,
                    $8, $9, $10, $11, $12,
                    $13, $14, $15, $3, 0,
                    $16)
            RETURNING id`,
      values: [
        acc.user_id, `phase${nextStep}`, acc.account_size,
        profitTarget, stepModel.max_drawdown_pct, phaseEndDate, accountUid,
        stepModel.id, stepModel.slug, nextStep, stepModel.daily_drawdown_pct, stepModel.drawdown_type,
        consistencyPct, stepModel.min_trading_days, stepModel.min_daily_profit_pct,
        acc.id
      ],
      bbookSql: `INSERT INTO bbook_pnl (date, accounts_passed)
                 VALUES (CURRENT_DATE, 1)
                 ON CONFLICT (date) DO UPDATE
                 SET accounts_passed = bbook_pnl.accounts_passed + 1`,
      bbookValues: [],
      socketEvent: `phase${currentStep}_passed`,
      socketMessage: `${currentPhaseName} PASSED! Your Phase ${nextStep} challenge is now active. Target: ${profitTargetPct}%`
    }
  }

  // Final phase passed — promote to funded.
  return {
    sql: `INSERT INTO accounts
          (user_id, account_type, account_size, current_balance, starting_balance,
           peak_balance, profit_target, max_drawdown_pct, status, phase_start_date, account_uid,
           challenge_model_id, challenge_model_slug, step_number, daily_drawdown_pct, drawdown_type,
           consistency_max_day_pct, min_trading_days, min_daily_profit_pct, eod_peak_equity, qualifying_days_count,
           parent_account_id)
          VALUES ($1, 'funded', $2, $2, $2, $2, 0, $3, 'active', NOW(), $4,
                  $5, $6, NULL, $7, $8,
                  $9, $10, $11, $2, 0,
                  $12)
          RETURNING id`,
    values: [
      acc.user_id, acc.account_size, stepModel.funded_max_drawdown_pct, accountUid,
      stepModel.id, stepModel.slug, stepModel.funded_daily_drawdown_pct, stepModel.drawdown_type,
      stepModel.funded_consistency_max_day_pct, stepModel.funded_min_trading_days_for_payout, stepModel.min_daily_profit_pct,
      acc.id
    ],
    bbookSql: `INSERT INTO bbook_pnl (date, new_funded)
               VALUES (CURRENT_DATE, 1)
               ON CONFLICT (date) DO UPDATE
               SET new_funded = bbook_pnl.new_funded + 1`,
    bbookValues: [],
    socketEvent: `phase${currentStep}_passed`,
    socketMessage: `${currentPhaseName} PASSED! You are now a Funded Trader. Welcome to the team!`
  }
}

async function buildPromotionPlan(acc, settings, db = pool) {
  if (acc.challenge_model_slug) {
    const stepModel = await fetchStepModelBySlug(acc.challenge_model_slug)
    if (stepModel) return buildNextPhaseStepModelPlan(acc, stepModel, db)
    logger.error(`[progression] Account ${acc.id} references unknown step model "${acc.challenge_model_slug}" — falling back to legacy settings.`)
  }
  if (acc.account_type === 'phase1') return buildPhase2InsertArgs(acc, settings, db)
  if (acc.account_type === 'phase2') return buildFundedInsertArgs(acc, settings, db)
  return null
}

async function promotePassedAccount(db, acc, settings) {
  const plan = await buildPromotionPlan(acc, settings, db)
  if (!plan) return null

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
      FOR UPDATE`,
    [String(review.source_account_id)]
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
