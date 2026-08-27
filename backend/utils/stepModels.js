const pool = require('../db')
const logger = require('./logger')

// Authoritative rule/pricing data for the paid 1-step / 2-step / 3-step challenge system.
// Source: business-supplied "Challenge Models — Updated" rules sheet, reviewed 2026-07-26.
const STEP_MODEL_SEED = [
  {
    slug: '1-step',
    name: '1-Step',
    description: 'Single-phase evaluation: hit a 16% profit target within 45 days while staying inside a 4% trailing drawdown.',
    steps: 1,
    display_order: 1,
    profit_targets_pct: [16],
    daily_drawdown_pct: 2,
    max_drawdown_pct: 4,
    time_limits_days: [45],
    consistency_max_day_pct_by_phase: [15],
    consistency_max_day_pct: 15,
    min_trading_days: 5,
    min_daily_profit_pct: 0.75,
    news_restriction_minutes: 2,
    scaling_target_pct: 6,
    scaling_multiplier: 2,
    scaling_max_account_size: 30000000,
    scaling_increase_per_milestone_pct: 25
  },
  {
    slug: '2-step',
    name: '2-Step',
    description: 'Two-phase evaluation: 10% then 8% profit targets, 45 days per phase, 4% trailing drawdown.',
    steps: 2,
    display_order: 2,
    profit_targets_pct: [10, 8],
    daily_drawdown_pct: 2,
    max_drawdown_pct: 4,
    time_limits_days: [45, 45],
    consistency_max_day_pct_by_phase: [15, 15],
    consistency_max_day_pct: 15,
    min_trading_days: 5,
    min_daily_profit_pct: 0.75,
    news_restriction_minutes: 2,
    scaling_target_pct: 6,
    scaling_multiplier: 2,
    scaling_max_account_size: 30000000,
    scaling_increase_per_milestone_pct: 25
  },
  {
    slug: '3-step',
    name: '3-Step',
    description: 'Three-phase evaluation: 8%/6%/6% profit targets, 45 days per phase, 4% trailing drawdown.',
    steps: 3,
    display_order: 3,
    profit_targets_pct: [8, 6, 6],
    daily_drawdown_pct: 2,
    max_drawdown_pct: 4,
    time_limits_days: [45, 45, 45],
    consistency_max_day_pct_by_phase: [15, 15, 15],
    consistency_max_day_pct: 15,
    min_trading_days: 5,
    min_daily_profit_pct: 0.75,
    news_restriction_minutes: 2,
    scaling_target_pct: 6,
    scaling_multiplier: 2,
    scaling_max_account_size: 30000000,
    scaling_increase_per_milestone_pct: 25
  }
]

// funded_stage rules apply the same way to every model
const FUNDED_STAGE = {
  funded_max_drawdown_pct: 4,
  funded_daily_drawdown_pct: 2,
  funded_drawdown_locks_at_pct: 2,
  funded_min_trading_days_for_payout: 10,
  funded_payout_min_net_profit_pct: 6,
  funded_consistency_max_day_pct: 15,
  // 'weekly' was marketing, not mechanism: nothing read this field, no cycle
  // ran, and the hero advertised "Weekly Payout Cycles" over an on-demand
  // queue. On-demand is the better offer — see PAYOUT_SLA in constants.js for
  // the commitment that replaced the cadence.
  payout_frequency: 'on_demand',
  profit_split_pct: 100
}

const PRICING_SEED = {
  '1-step': { 5000: 7, 10000: 12, 25000: 22, 50000: 34, 100000: 49, 200000: 79, 400000: 99 },
  '2-step': { 5000: 5, 10000: 9, 25000: 17, 50000: 27, 100000: 39, 200000: 64, 400000: 79 },
  '3-step': { 5000: 4, 10000: 7, 25000: 13, 50000: 20, 100000: 29, 200000: 48, 400000: 59 }
}

const ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]

let stepModelInfrastructurePromise = null

async function ensureStepModelInfrastructure() {
  if (stepModelInfrastructurePromise) return stepModelInfrastructurePromise

  stepModelInfrastructurePromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_models (
        id BIGSERIAL PRIMARY KEY,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        steps INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        display_order INTEGER NOT NULL DEFAULT 0,
        profit_targets_pct JSONB NOT NULL DEFAULT '[10]'::jsonb,
        daily_drawdown_pct NUMERIC NOT NULL DEFAULT 3.0,
        max_drawdown_pct NUMERIC NOT NULL DEFAULT 4.0,
        drawdown_type TEXT NOT NULL DEFAULT 'trailing',
        drawdown_locks_at_breakeven BOOLEAN NOT NULL DEFAULT FALSE,
        funded_max_drawdown_pct NUMERIC NOT NULL DEFAULT 4.0,
        funded_daily_drawdown_pct NUMERIC NOT NULL DEFAULT 3.0,
        time_limits_days JSONB NOT NULL DEFAULT '[30]'::jsonb,
        consistency_rule_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        consistency_max_day_pct NUMERIC NOT NULL DEFAULT 24.0,
        min_trading_days INTEGER NOT NULL DEFAULT 5,
        min_daily_profit_pct NUMERIC NOT NULL DEFAULT 0.5,
        no_martingale BOOLEAN NOT NULL DEFAULT TRUE,
        no_grid_trading BOOLEAN NOT NULL DEFAULT TRUE,
        no_ea_bots BOOLEAN NOT NULL DEFAULT TRUE,
        no_hedging BOOLEAN NOT NULL DEFAULT FALSE,
        news_restriction_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        news_restriction_minutes INTEGER NOT NULL DEFAULT 5,
        allow_overnight BOOLEAN NOT NULL DEFAULT TRUE,
        allow_weekend_holding BOOLEAN NOT NULL DEFAULT TRUE,
        profit_split_pct NUMERIC NOT NULL DEFAULT 100.0,
        scaling_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        scaling_target_pct NUMERIC NOT NULL DEFAULT 10.0,
        -- LEGACY / DISPLAY ONLY. Nothing reads this to size a scaling grant.
        --
        -- The rows here carry BOTH this column and
        -- scaling_increase_per_milestone_pct (added below), which are two
        -- incompatible scaling semantics — doubling vs a linear step — sitting
        -- on the same row. Only the LINEAR one governs: routes/accounts.js and
        -- challengeEngine.js's evaluateScalingPlan both grant
        --   starting_balance * scaling_increase_per_milestone_pct / 100
        --
        -- services/analytics/traderEdge.js used to surface this one to traders
        -- as "next tier multiplier", so the admin panel promised a doubling the
        -- engine was never going to grant. That display now reads the linear
        -- figure. Do not reintroduce a reader for this column without deleting
        -- the other semantic first — whichever the code happens to read is the
        -- one that governs real money.
        --
        -- accounts.scaling_multiplier is unrelated and still live: it is the
        -- per-account "how many times has this grown" tracker, default 1.
        scaling_multiplier NUMERIC NOT NULL DEFAULT 2.0,
        scaling_max_account_size INTEGER NOT NULL DEFAULT 200000,
        free_retries INTEGER NOT NULL DEFAULT 1,
        max_leverage INTEGER NOT NULL DEFAULT 20,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_challenge_models_slug ON challenge_models(slug)`)

    // Columns added on top of the original hand-seeded schema, for fields the
    // rules file specifies but the original table didn't have room for yet.
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS consistency_max_day_pct_by_phase JSONB`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS funded_drawdown_locks_at_pct NUMERIC`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS funded_min_trading_days_for_payout INTEGER`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS funded_payout_min_net_profit_pct NUMERIC`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS funded_consistency_max_day_pct NUMERIC`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS payout_frequency TEXT`)
    await pool.query(`ALTER TABLE challenge_models ADD COLUMN IF NOT EXISTS scaling_increase_per_milestone_pct NUMERIC`)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS challenge_model_pricing (
        id BIGSERIAL PRIMARY KEY,
        challenge_model_id BIGINT NOT NULL REFERENCES challenge_models(id) ON DELETE CASCADE,
        account_size INTEGER NOT NULL,
        price NUMERIC NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_unlimited BOOLEAN NOT NULL DEFAULT TRUE,
        slot_limit INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_model_pricing ON challenge_model_pricing(challenge_model_id, account_size)`)

    // Snapshot columns on `accounts` — populated at account-creation time so an
    // account keeps the rules it was created under even if the model config
    // changes later.
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS challenge_model_id INTEGER`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS challenge_model_slug TEXT`)

    // Backs countUsedSlotsForModel/countUsedSlotsForModels — every account ever
    // created for a (model, size) pair counts against that pair's slot_limit,
    // regardless of the account's current status (fixed lifetime pool, not a
    // "currently active" count).
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_accounts_challenge_model_size ON accounts(challenge_model_id, account_size)`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS step_number INTEGER`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_drawdown_pct NUMERIC`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS drawdown_type TEXT`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS eod_trailing_floor NUMERIC`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS eod_peak_equity NUMERIC`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS consistency_max_day_pct NUMERIC`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS min_trading_days INTEGER`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS min_daily_profit_pct NUMERIC`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS qualifying_days_count INTEGER NOT NULL DEFAULT 0`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS free_retries_remaining INTEGER`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS parent_account_id TEXT`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS scaling_multiplier NUMERIC NOT NULL DEFAULT 1`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS scaling_milestones_claimed INTEGER NOT NULL DEFAULT 0`)

    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS challenge_model_id INTEGER`)
    await pool.query(`ALTER TABLE challenge_orders ADD COLUMN IF NOT EXISTS challenge_model_slug TEXT`)

    // One-time rename: earlier seed data used branded slugs (stellar/fusion/quantum).
    // Business direction is plain 1-step/2-step/3-step naming — this is a no-op once renamed.
    await pool.query(`
      UPDATE challenge_models
         SET slug = CASE steps WHEN 1 THEN '1-step' WHEN 2 THEN '2-step' WHEN 3 THEN '3-step' ELSE slug END
       WHERE slug IN ('stellar', 'fusion', 'quantum')
    `)

    for (const model of STEP_MODEL_SEED) {
      const result = await pool.query(
        `INSERT INTO challenge_models (
           slug, name, description, steps, is_active, display_order,
           profit_targets_pct, daily_drawdown_pct, max_drawdown_pct, drawdown_type,
           time_limits_days, consistency_max_day_pct_by_phase, consistency_max_day_pct,
           min_trading_days, min_daily_profit_pct, news_restriction_minutes, allow_overnight, allow_weekend_holding,
           profit_split_pct, scaling_target_pct, scaling_multiplier, scaling_increase_per_milestone_pct, scaling_max_account_size,
           funded_max_drawdown_pct, funded_daily_drawdown_pct, funded_drawdown_locks_at_pct,
           funded_min_trading_days_for_payout, funded_payout_min_net_profit_pct,
           funded_consistency_max_day_pct, payout_frequency,
           no_martingale, no_grid_trading, no_ea_bots, no_hedging
         ) VALUES (
           $1, $2, $3, $4, TRUE, $5,
           $6::jsonb, $7, $8, 'trailing',
           $9::jsonb, $10::jsonb, $11,
           $12, $13, $14, FALSE, FALSE,
           $15, $16, $17, $18, $19,
           $20, $21, $22,
           $23, $24,
           $25, $26,
           TRUE, TRUE, TRUE, TRUE
         )
         ON CONFLICT (slug) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           steps = EXCLUDED.steps,
           display_order = EXCLUDED.display_order,
           profit_targets_pct = EXCLUDED.profit_targets_pct,
           daily_drawdown_pct = EXCLUDED.daily_drawdown_pct,
           max_drawdown_pct = EXCLUDED.max_drawdown_pct,
           drawdown_type = EXCLUDED.drawdown_type,
           time_limits_days = EXCLUDED.time_limits_days,
           consistency_max_day_pct_by_phase = EXCLUDED.consistency_max_day_pct_by_phase,
           consistency_max_day_pct = EXCLUDED.consistency_max_day_pct,
           min_trading_days = EXCLUDED.min_trading_days,
           min_daily_profit_pct = EXCLUDED.min_daily_profit_pct,
           news_restriction_minutes = EXCLUDED.news_restriction_minutes,
           allow_overnight = EXCLUDED.allow_overnight,
           allow_weekend_holding = EXCLUDED.allow_weekend_holding,
           profit_split_pct = EXCLUDED.profit_split_pct,
           scaling_target_pct = EXCLUDED.scaling_target_pct,
           scaling_multiplier = EXCLUDED.scaling_multiplier,
           scaling_increase_per_milestone_pct = EXCLUDED.scaling_increase_per_milestone_pct,
           scaling_max_account_size = EXCLUDED.scaling_max_account_size,
           funded_max_drawdown_pct = EXCLUDED.funded_max_drawdown_pct,
           funded_daily_drawdown_pct = EXCLUDED.funded_daily_drawdown_pct,
           funded_drawdown_locks_at_pct = EXCLUDED.funded_drawdown_locks_at_pct,
           funded_min_trading_days_for_payout = EXCLUDED.funded_min_trading_days_for_payout,
           funded_payout_min_net_profit_pct = EXCLUDED.funded_payout_min_net_profit_pct,
           funded_consistency_max_day_pct = EXCLUDED.funded_consistency_max_day_pct,
           payout_frequency = EXCLUDED.payout_frequency,
           no_martingale = EXCLUDED.no_martingale,
           no_grid_trading = EXCLUDED.no_grid_trading,
           no_ea_bots = EXCLUDED.no_ea_bots,
           no_hedging = EXCLUDED.no_hedging,
           updated_at = NOW()
         RETURNING id`,
        [
          model.slug, model.name, model.description, model.steps, model.display_order,
          JSON.stringify(model.profit_targets_pct), model.daily_drawdown_pct, model.max_drawdown_pct,
          JSON.stringify(model.time_limits_days), JSON.stringify(model.consistency_max_day_pct_by_phase), model.consistency_max_day_pct,
          model.min_trading_days, model.min_daily_profit_pct, model.news_restriction_minutes,
          FUNDED_STAGE.profit_split_pct, model.scaling_target_pct, model.scaling_multiplier, model.scaling_increase_per_milestone_pct, model.scaling_max_account_size,
          FUNDED_STAGE.funded_max_drawdown_pct, FUNDED_STAGE.funded_daily_drawdown_pct, FUNDED_STAGE.funded_drawdown_locks_at_pct,
          FUNDED_STAGE.funded_min_trading_days_for_payout, FUNDED_STAGE.funded_payout_min_net_profit_pct,
          FUNDED_STAGE.funded_consistency_max_day_pct, FUNDED_STAGE.payout_frequency
        ]
      )

      const modelId = result.rows[0].id
      const pricing = PRICING_SEED[model.slug]
      for (const size of ACCOUNT_SIZES) {
        await pool.query(
          `INSERT INTO challenge_model_pricing (challenge_model_id, account_size, price, currency, is_active, is_unlimited)
           VALUES ($1, $2, $3, 'USD', TRUE, TRUE)
           ON CONFLICT (challenge_model_id, account_size) DO UPDATE SET
             price = EXCLUDED.price,
             is_active = TRUE`,
          [modelId, size, pricing[size]]
        )
      }
    }

    logger.info('[stepModels] Step-model infrastructure ensured and seeded (1-step/2-step/3-step)')
  })().catch((error) => {
    stepModelInfrastructurePromise = null
    logger.error('[stepModels] Failed to ensure infrastructure:', { error: error.message })
    throw error
  })

  return stepModelInfrastructurePromise
}

// Fixed lifetime pool: every account ever created for a (model, size) pair
// counts as "used", regardless of its current status (pass/fail/funded all
// still count) — the pool only grows back when an admin raises slot_limit.
async function countUsedSlotsForModel(db, challengeModelId, accountSize) {
  const result = await db.query(
    `SELECT COUNT(*) AS count FROM accounts WHERE challenge_model_id = $1 AND account_size = $2`,
    [challengeModelId, accountSize]
  )
  return parseInt(result.rows[0]?.count || 0, 10)
}

// Batched form of countUsedSlotsForModel for fetchStepModels(), which needs
// usage for every (model, size) pair at once — avoids N+1 queries.
async function countUsedSlotsForModels(db, challengeModelIds) {
  const map = new Map()
  if (!challengeModelIds.length) return map
  const result = await db.query(
    `SELECT challenge_model_id, account_size, COUNT(*) AS count
       FROM accounts
      WHERE challenge_model_id = ANY($1::int[])
      GROUP BY challenge_model_id, account_size`,
    [challengeModelIds]
  )
  for (const row of result.rows) {
    map.set(`${row.challenge_model_id}:${row.account_size}`, parseInt(row.count, 10))
  }
  return map
}

function deriveAvailability({ isActive, isUnlimited, slotLimit, used }) {
  const remaining = isUnlimited ? null : Math.max(0, (slotLimit || 0) - used)
  return {
    is_unlimited: isUnlimited,
    slot_limit: slotLimit,
    used,
    remaining,
    locked: !isActive || (!isUnlimited && remaining <= 0)
  }
}

// Authoritative, race-safe slot check — call inside a transaction (client),
// after the caller has already loaded the target challenge model. Takes a
// GLOBAL advisory lock (not per-user) keyed on (challengeModelId, accountSize)
// so two different users racing for the last slot are correctly serialized.
async function assertSlotAvailable(client, challengeModelId, accountSize) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('step_model_slot'), hashtext($1))`,
    [`${challengeModelId}:${accountSize}`]
  )
  const result = await client.query(
    `SELECT is_active, is_unlimited, slot_limit
       FROM challenge_model_pricing
      WHERE challenge_model_id = $1 AND account_size = $2`,
    [challengeModelId, accountSize]
  )
  const row = result.rows[0]
  if (!row) return { ok: false, reason: 'not_offered' }
  if (!row.is_active) return { ok: false, reason: 'inactive' }
  if (row.is_unlimited) return { ok: true, is_unlimited: true }

  const slotLimit = row.slot_limit != null ? parseInt(row.slot_limit, 10) : 0
  const used = await countUsedSlotsForModel(client, challengeModelId, accountSize)
  if (used >= slotLimit) return { ok: false, reason: 'full', used, limit: slotLimit }
  return { ok: true, is_unlimited: false, used, limit: slotLimit }
}

async function fetchStepModels({ onlyEnabled = false } = {}) {
  await ensureStepModelInfrastructure()
  const modelsResult = await pool.query(
    `SELECT * FROM challenge_models ${onlyEnabled ? 'WHERE is_active = TRUE' : ''} ORDER BY display_order ASC`
  )
  const pricingResult = await pool.query(
    `SELECT p.* FROM challenge_model_pricing p
     JOIN challenge_models m ON m.id = p.challenge_model_id
     ORDER BY p.account_size ASC`
  )
  const usageMap = await countUsedSlotsForModels(pool, modelsResult.rows.map((m) => m.id))

  return modelsResult.rows.map((model) => ({
    ...model,
    pricing: pricingResult.rows
      .filter((p) => p.challenge_model_id === model.id)
      .map((p) => {
        const isUnlimited = p.is_unlimited
        const used = isUnlimited ? 0 : (usageMap.get(`${p.challenge_model_id}:${p.account_size}`) || 0)
        return {
          account_size: p.account_size,
          price: parseFloat(p.price),
          is_active: p.is_active,
          ...deriveAvailability({
            isActive: p.is_active,
            isUnlimited,
            slotLimit: p.slot_limit != null ? parseInt(p.slot_limit, 10) : null,
            used
          })
        }
      })
  }))
}

async function fetchStepModelBySlug(slug) {
  await ensureStepModelInfrastructure()
  const result = await pool.query(
    `SELECT * FROM challenge_models WHERE slug = $1`,
    [slug]
  )
  return result.rows[0] || null
}

async function fetchStepModelPrice(slug, accountSize) {
  await ensureStepModelInfrastructure()
  const result = await pool.query(
    `SELECT p.challenge_model_id, p.price, p.is_active, p.is_unlimited, p.slot_limit
       FROM challenge_model_pricing p
       JOIN challenge_models m ON m.id = p.challenge_model_id
      WHERE m.slug = $1 AND p.account_size = $2`,
    [slug, accountSize]
  )
  const row = result.rows[0]
  if (!row) return null

  const isUnlimited = row.is_unlimited
  const used = isUnlimited ? 0 : await countUsedSlotsForModel(pool, row.challenge_model_id, accountSize)
  return {
    price: row.price,
    is_active: row.is_active,
    ...deriveAvailability({
      isActive: row.is_active,
      isUnlimited,
      slotLimit: row.slot_limit != null ? parseInt(row.slot_limit, 10) : null,
      used
    })
  }
}

async function toggleStepModel(slug, enabled) {
  await ensureStepModelInfrastructure()
  const result = await pool.query(
    `UPDATE challenge_models SET is_active = $2, updated_at = NOW()
      WHERE slug = $1
      RETURNING *`,
    [slug, enabled]
  )
  return result.rows[0] || null
}

module.exports = {
  ACCOUNT_SIZES,
  ensureStepModelInfrastructure,
  countUsedSlotsForModel,
  countUsedSlotsForModels,
  assertSlotAvailable,
  fetchStepModels,
  fetchStepModelBySlug,
  fetchStepModelPrice,
  toggleStepModel
}
