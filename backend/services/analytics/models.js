// Firm Intelligence → Models tab (metrics B26–B40).
//
// This is the tab that answers "are our challenges priced and ruled correctly".
// Every number is derived from account outcomes and the rule matrix on
// `challenge_models` — no assumed industry pass rates, no benchmark constants.
//
// A recurring pattern here is the "bind rate": of the accounts that failed, how
// many were killed by THIS rule specifically rather than by losing money. That
// is the difference between a rule that protects the firm and a rule that just
// harvests fees, and nothing in the product exposed it before.

const { readPool } = require('../../db')
const { num, int, round, pct, median } = require('./helpers')

// ── B26, B35: pass rates and the phase waterfall ─────────────────────────────
async function passRates (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            a.account_type,
            COUNT(*)::int                                     AS accounts,
            COUNT(*) FILTER (WHERE a.status = 'passed')::int  AS passed,
            COUNT(*) FILTER (WHERE a.status = 'failed')::int  AS failed,
            COUNT(*) FILTER (WHERE a.status = 'expired')::int AS expired,
            COUNT(*) FILTER (WHERE a.status = 'active')::int  AS active
       FROM accounts a
      WHERE a.created_at BETWEEN $1 AND $2
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [range.fromTs, range.toTs]
  )

  const byModel = new Map()
  for (const r of rows) {
    const key = r.model_slug
    if (!byModel.has(key)) byModel.set(key, { model_slug: key, phases: [], totals: { accounts: 0, passed: 0, failed: 0, expired: 0, active: 0 } })
    const entry = byModel.get(key)
    const phase = {
      account_type: r.account_type,
      accounts: int(r.accounts),
      passed: int(r.passed),
      failed: int(r.failed),
      expired: int(r.expired),
      active: int(r.active)
    }
    // Resolved = every account whose outcome is known. Pass rate against total
    // (including still-active accounts) would understate every young cohort.
    phase.resolved = phase.passed + phase.failed + phase.expired
    phase.pass_rate_pct = pct(phase.passed, phase.resolved)
    entry.phases.push(phase)
    entry.totals.accounts += phase.accounts
    entry.totals.passed += phase.passed
    entry.totals.failed += phase.failed
    entry.totals.expired += phase.expired
    entry.totals.active += phase.active
  }

  const models = [...byModel.values()].map((m) => ({
    ...m,
    totals: {
      ...m.totals,
      resolved: m.totals.passed + m.totals.failed + m.totals.expired,
      pass_rate_pct: pct(m.totals.passed, m.totals.passed + m.totals.failed + m.totals.expired)
    }
  })).sort((a, b) => b.totals.accounts - a.totals.accounts)

  // B35 — the waterfall across the whole book, phase by phase.
  const waterfall = ['phase1', 'phase2', 'funded'].map((phase) => {
    const totals = rows
      .filter((r) => r.account_type === phase)
      .reduce((acc, r) => {
        acc.accounts += int(r.accounts)
        acc.passed += int(r.passed)
        acc.failed += int(r.failed)
        acc.expired += int(r.expired)
        acc.active += int(r.active)
        return acc
      }, { accounts: 0, passed: 0, failed: 0, expired: 0, active: 0 })
    return {
      phase,
      ...totals,
      resolved: totals.passed + totals.failed + totals.expired,
      pass_rate_pct: pct(totals.passed, totals.passed + totals.failed + totals.expired)
    }
  })

  return { models, waterfall }
}

// ── B27: fail-cause decomposition ────────────────────────────────────────────
// Assigning ONE cause per failed account, in a fixed precedence order, so the
// buckets sum to the failure count rather than double-counting an account that
// tripped two rules on its way out.
async function failCauses (range) {
  const { rows } = await readPool.query(
    `WITH failed AS (
       SELECT a.id, a.challenge_model_slug, a.status, a.phase_end_date,
              a.updated_at, a.current_balance, a.starting_balance,
              a.qualifying_days_count, a.min_trading_days
         FROM accounts a
        WHERE a.status IN ('failed', 'expired')
          AND a.created_at BETWEEN $1 AND $2
     ),
     violation AS (
       SELECT DISTINCT ON (v.account_id) v.account_id, v.violation_type
         FROM admin_rule_violations v
        WHERE v.account_id IS NOT NULL
        ORDER BY v.account_id, v.severity DESC, v.last_detected_at DESC
     )
     SELECT COALESCE(f.challenge_model_slug, 'unknown') AS model_slug,
            CASE
              -- Precedence: an explicit rule violation is always the cause of
              -- record. Only when none was raised do we fall back to inferring
              -- from the account's own terminal state.
              WHEN v.violation_type IS NOT NULL                              THEN v.violation_type
              WHEN f.status = 'expired'                                      THEN 'time_expired'
              WHEN f.current_balance >= f.starting_balance
                   AND f.qualifying_days_count < COALESCE(f.min_trading_days, 0) THEN 'min_trading_days'
              WHEN f.current_balance <  f.starting_balance                   THEN 'drawdown_or_loss'
              ELSE 'unclassified'
            END AS cause,
            COUNT(*)::int AS accounts
       FROM failed f
       LEFT JOIN violation v ON v.account_id = f.id::text
      GROUP BY 1, 2
      ORDER BY accounts DESC`,
    [range.fromTs, range.toTs]
  )

  const byCause = new Map()
  const byModel = new Map()
  for (const r of rows) {
    const count = int(r.accounts)
    byCause.set(r.cause, (byCause.get(r.cause) || 0) + count)
    if (!byModel.has(r.model_slug)) byModel.set(r.model_slug, {})
    byModel.get(r.model_slug)[r.cause] = count
  }

  const total = [...byCause.values()].reduce((s, v) => s + v, 0)

  return {
    total_failed: total,
    causes: [...byCause.entries()]
      .map(([cause, accounts]) => ({ cause, accounts, share_pct: pct(accounts, total) }))
      .sort((a, b) => b.accounts - a.accounts),
    by_model: [...byModel.entries()].map(([model_slug, causes]) => ({ model_slug, causes }))
  }
}

// ── B28: days to pass / days to fail ─────────────────────────────────────────
async function timeToOutcome (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            a.account_type,
            a.status,
            EXTRACT(EPOCH FROM (COALESCE(a.updated_at, a.phase_end_date) - a.phase_start_date)) / 86400.0 AS days
       FROM accounts a
      WHERE a.status IN ('passed', 'failed', 'expired')
        AND a.phase_start_date IS NOT NULL
        AND a.created_at BETWEEN $1 AND $2
        AND COALESCE(a.updated_at, a.phase_end_date) >= a.phase_start_date`,
    [range.fromTs, range.toTs]
  )

  const grouped = new Map()
  for (const r of rows) {
    const key = `${r.model_slug}|${r.account_type}`
    if (!grouped.has(key)) {
      grouped.set(key, { model_slug: r.model_slug, account_type: r.account_type, pass: [], fail: [] })
    }
    const days = num(r.days, NaN)
    if (!Number.isFinite(days) || days < 0) continue
    grouped.get(key)[r.status === 'passed' ? 'pass' : 'fail'].push(days)
  }

  return [...grouped.values()].map((g) => ({
    model_slug: g.model_slug,
    account_type: g.account_type,
    passed_samples: g.pass.length,
    failed_samples: g.fail.length,
    median_days_to_pass: g.pass.length ? round(median(g.pass), 1) : null,
    median_days_to_fail: g.fail.length ? round(median(g.fail), 1) : null
  })).sort((a, b) => (b.passed_samples + b.failed_samples) - (a.passed_samples + a.failed_samples))
}

// ── B29: survival curve ──────────────────────────────────────────────────────
// Share of each model's accounts still un-failed at day N. Not a full
// Kaplan–Meier estimator: accounts younger than day N are excluded from that
// day's denominator (right-censoring handled by exclusion), which is the
// standard simplification and is stated as such in the UI.
async function survivalCurves (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 86400.0 AS age_days,
            CASE WHEN a.status IN ('failed', 'expired')
                 THEN EXTRACT(EPOCH FROM (COALESCE(a.updated_at, NOW()) - a.created_at)) / 86400.0
            END AS died_at_days
       FROM accounts a
      WHERE a.created_at BETWEEN $1 AND $2`,
    [range.fromTs, range.toTs]
  )

  const DAYS = [1, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90]
  const byModel = new Map()

  for (const r of rows) {
    const slug = r.model_slug
    if (!byModel.has(slug)) byModel.set(slug, [])
    byModel.get(slug).push({
      age: num(r.age_days, 0),
      died: r.died_at_days === null ? null : num(r.died_at_days, null)
    })
  }

  return [...byModel.entries()].map(([model_slug, accounts]) => ({
    model_slug,
    accounts: accounts.length,
    points: DAYS.map((day) => {
      const atRisk = accounts.filter((a) => a.age >= day || (a.died !== null && a.died <= day))
      if (atRisk.length === 0) return { day, at_risk: 0, alive_pct: null }
      const alive = atRisk.filter((a) => a.died === null || a.died > day).length
      return { day, at_risk: atRisk.length, alive_pct: pct(alive, atRisk.length) }
    })
  })).sort((a, b) => b.accounts - a.accounts)
}

// ── B30: daily-drawdown rule sensitivity ─────────────────────────────────────
// A real counterfactual, not a guess: for every account, find its single worst
// day as a percentage of that day's starting equity, then count how many
// accounts sit between the current threshold and a threshold one point looser
// or tighter. Those are exactly the accounts whose fate the rule change would
// have flipped.
async function ruleSensitivity (range) {
  const { rows } = await readPool.query(
    `WITH worst AS (
       SELECT d.account_id,
              MIN(CASE WHEN d.starting_equity > 0
                       THEN (d.realized_pnl / d.starting_equity) * 100 END) AS worst_day_pct
         FROM daily_pnl_records d
        WHERE d.trading_date BETWEEN $1::date AND $2::date
        GROUP BY d.account_id
     )
     SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            COALESCE(a.daily_drawdown_pct, m.daily_drawdown_pct) AS threshold_pct,
            COUNT(*)::int AS accounts,
            COUNT(*) FILTER (
              WHERE ABS(w.worst_day_pct) >= COALESCE(a.daily_drawdown_pct, m.daily_drawdown_pct)
            )::int AS breached_now,
            COUNT(*) FILTER (
              WHERE ABS(w.worst_day_pct) >= COALESCE(a.daily_drawdown_pct, m.daily_drawdown_pct) + 1
            )::int AS breached_if_looser,
            COUNT(*) FILTER (
              WHERE ABS(w.worst_day_pct) >= GREATEST(COALESCE(a.daily_drawdown_pct, m.daily_drawdown_pct) - 1, 0.1)
            )::int AS breached_if_tighter
       FROM worst w
       JOIN accounts a ON a.id::text = w.account_id
       LEFT JOIN challenge_models m ON m.slug = a.challenge_model_slug
      WHERE w.worst_day_pct IS NOT NULL
      GROUP BY 1, 2
      ORDER BY accounts DESC`,
    [range.from, range.to]
  )

  return rows.map((r) => {
    const accounts = int(r.accounts)
    const now = int(r.breached_now)
    return {
      model_slug: r.model_slug,
      threshold_pct: num(r.threshold_pct, null),
      accounts,
      breached_now: now,
      breach_rate_pct: pct(now, accounts),
      // Negative = fewer accounts breach. Signed so the direction of the effect
      // is readable without comparing two other columns.
      delta_if_1pct_looser: int(r.breached_if_looser) - now,
      delta_if_1pct_tighter: int(r.breached_if_tighter) - now
    }
  })
}

// ── B31, B32, B33: which rule actually bound ─────────────────────────────────
async function bindRates (range) {
  const { rows } = await readPool.query(
    `WITH acct AS (
       SELECT a.id, a.challenge_model_slug, a.status, a.account_type,
              a.starting_balance, a.current_balance, a.profit_target,
              a.qualifying_days_count,
              COALESCE(a.min_trading_days, m.min_trading_days, 0) AS min_days,
              COALESCE(a.consistency_max_day_pct, m.consistency_max_day_pct) AS consistency_cap,
              a.phase_end_date, a.updated_at
         FROM accounts a
         LEFT JOIN challenge_models m ON m.slug = a.challenge_model_slug
        WHERE a.created_at BETWEEN $1 AND $2
     ),
     best_day AS (
       SELECT d.account_id,
              MAX(d.realized_pnl) AS best_day_pnl,
              SUM(d.realized_pnl) AS total_realized
         FROM daily_pnl_records d
        GROUP BY d.account_id
     )
     SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            COUNT(*)::int AS accounts,
            -- Hit the money target at some point, whatever the final status.
            COUNT(*) FILTER (
              WHERE a.current_balance - a.starting_balance >= a.profit_target
            )::int AS reached_target,
            -- B32: reached target but short of the minimum trading days.
            COUNT(*) FILTER (
              WHERE a.current_balance - a.starting_balance >= a.profit_target
                AND a.qualifying_days_count < a.min_days
            )::int AS blocked_by_min_days,
            -- B31: reached target but one day carried more than the cap allows.
            COUNT(*) FILTER (
              WHERE a.current_balance - a.starting_balance >= a.profit_target
                AND a.consistency_cap IS NOT NULL
                AND b.total_realized > 0
                AND (b.best_day_pnl / NULLIF(b.total_realized, 0)) * 100 > a.consistency_cap
            )::int AS blocked_by_consistency,
            -- B33: ran out of time while still in profit.
            COUNT(*) FILTER (
              WHERE a.status = 'expired'
                AND a.current_balance > a.starting_balance
            )::int AS expired_in_profit
       FROM acct a
       LEFT JOIN best_day b ON b.account_id = a.id::text
      GROUP BY 1
      ORDER BY accounts DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    model_slug: r.model_slug,
    accounts: int(r.accounts),
    reached_target: int(r.reached_target),
    blocked_by_min_days: int(r.blocked_by_min_days),
    blocked_by_consistency: int(r.blocked_by_consistency),
    expired_in_profit: int(r.expired_in_profit),
    min_days_bind_pct: pct(r.blocked_by_min_days, r.reached_target),
    consistency_bind_pct: pct(r.blocked_by_consistency, r.reached_target),
    time_limit_bind_pct: pct(r.expired_in_profit, r.accounts)
  }))
}

// ── B34: difficulty vs price ─────────────────────────────────────────────────
// Difficulty is a composite of the rule matrix, scaled so a higher score means
// a harder challenge. The weights are the platform's own judgement, exposed in
// the response so the UI can show what went into the number rather than
// presenting it as an objective constant.
const DIFFICULTY_WEIGHTS = {
  profit_target_pct: 3.0,
  inverse_max_drawdown: 40.0,
  inverse_daily_drawdown: 20.0,
  min_trading_days: 0.8,
  consistency_strictness: 0.6,
  time_pressure: 1.2
}

function computeDifficulty (model) {
  const targets = Array.isArray(model.profit_targets_pct) ? model.profit_targets_pct : []
  const firstTarget = num(targets[0], 10)
  const timeLimits = Array.isArray(model.time_limits_days) ? model.time_limits_days : []
  const firstLimit = num(timeLimits[0], 0)

  const maxDd = num(model.max_drawdown_pct, 0)
  const dailyDd = num(model.daily_drawdown_pct, 0)
  const consistency = num(model.consistency_max_day_pct, 100)

  let score = 0
  score += firstTarget * DIFFICULTY_WEIGHTS.profit_target_pct
  score += maxDd > 0 ? DIFFICULTY_WEIGHTS.inverse_max_drawdown / maxDd : 0
  score += dailyDd > 0 ? DIFFICULTY_WEIGHTS.inverse_daily_drawdown / dailyDd : 0
  score += num(model.min_trading_days, 0) * DIFFICULTY_WEIGHTS.min_trading_days
  score += consistency > 0 ? (100 - consistency) * DIFFICULTY_WEIGHTS.consistency_strictness / 10 : 0
  // Shorter windows are harder; a model with no time limit adds nothing.
  score += firstLimit > 0 ? (DIFFICULTY_WEIGHTS.time_pressure * 30) / firstLimit : 0

  return round(score, 1)
}

async function difficultyVsPrice (range) {
  const [models, outcomes] = await Promise.all([
    readPool.query(
      `SELECT m.id, m.slug, m.name, m.steps, m.is_active,
              m.profit_targets_pct, m.time_limits_days,
              m.daily_drawdown_pct, m.max_drawdown_pct,
              m.consistency_max_day_pct, m.min_trading_days,
              m.profit_split_pct,
              (SELECT AVG(p.price) FROM challenge_model_pricing p
                WHERE p.challenge_model_id = m.id AND p.is_active = true) AS avg_price
         FROM challenge_models m`
    ),
    readPool.query(
      `SELECT COALESCE(challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*)::int                                    AS accounts,
              COUNT(*) FILTER (WHERE status = 'passed')::int   AS passed,
              COUNT(*) FILTER (WHERE status IN ('failed','expired'))::int AS resolved_fail
         FROM accounts
        WHERE created_at BETWEEN $1 AND $2
        GROUP BY 1`,
      [range.fromTs, range.toTs]
    )
  ])

  const outcomeBySlug = new Map(outcomes.rows.map((r) => [r.model_slug, r]))

  return {
    weights: DIFFICULTY_WEIGHTS,
    models: models.rows.map((m) => {
      const o = outcomeBySlug.get(m.slug) || {}
      const passed = int(o.passed)
      const resolved = passed + int(o.resolved_fail)
      return {
        model_slug: m.slug,
        model_name: m.name,
        steps: int(m.steps),
        is_active: m.is_active,
        avg_price: num(m.avg_price, null),
        difficulty_score: computeDifficulty(m),
        accounts: int(o.accounts),
        passed,
        pass_rate_pct: pct(passed, resolved),
        profit_split_pct: num(m.profit_split_pct, null),
        rules: {
          profit_targets_pct: m.profit_targets_pct,
          time_limits_days: m.time_limits_days,
          daily_drawdown_pct: num(m.daily_drawdown_pct, null),
          max_drawdown_pct: num(m.max_drawdown_pct, null),
          consistency_max_day_pct: num(m.consistency_max_day_pct, null),
          min_trading_days: int(m.min_trading_days)
        }
      }
    }).sort((a, b) => b.accounts - a.accounts)
  }
}

// ── B36: funded survival and time to first payout ────────────────────────────
async function fundedLifecycle (range) {
  const { rows } = await readPool.query(
    `WITH funded AS (
       SELECT a.id, a.user_id, a.challenge_model_slug, a.status, a.created_at
         FROM accounts a
        WHERE a.account_type = 'funded'
          AND a.created_at BETWEEN $1 AND $2
     ),
     first_payout AS (
       SELECT p.account_id,
              MIN(p.paid_at) AS first_paid_at
         FROM payouts p
        WHERE p.status = 'paid' AND p.paid_at IS NOT NULL
        GROUP BY p.account_id
     )
     SELECT COALESCE(f.challenge_model_slug, 'unknown') AS model_slug,
            COUNT(*)::int                                    AS funded_accounts,
            COUNT(*) FILTER (WHERE f.status = 'active')::int AS still_active,
            COUNT(fp.account_id)::int                        AS reached_payout,
            AVG(EXTRACT(EPOCH FROM (fp.first_paid_at - f.created_at)) / 86400.0) AS avg_days_to_first_payout
       FROM funded f
       LEFT JOIN first_payout fp ON fp.account_id = f.id
      GROUP BY 1
      ORDER BY funded_accounts DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    model_slug: r.model_slug,
    funded_accounts: int(r.funded_accounts),
    still_active: int(r.still_active),
    survival_pct: pct(r.still_active, r.funded_accounts),
    reached_payout: int(r.reached_payout),
    payout_conversion_pct: pct(r.reached_payout, r.funded_accounts),
    avg_days_to_first_payout: num(r.avg_days_to_first_payout, null) === null
      ? null
      : round(r.avg_days_to_first_payout, 1)
  }))
}

// ── B37: expected value per sold account ─────────────────────────────────────
async function expectedValue (range) {
  const { rows } = await readPool.query(
    `WITH sold AS (
       SELECT COALESCE(o.challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*)::int              AS orders,
              COALESCE(AVG(o.amount), 0) AS avg_fee
         FROM challenge_orders o
        WHERE o.status = 'paid' AND o.paid_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     outcome AS (
       SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
              COUNT(*) FILTER (WHERE a.status IN ('passed','failed','expired'))::int AS resolved,
              COUNT(*) FILTER (WHERE a.status = 'passed')::int AS passed
         FROM accounts a
        WHERE a.created_at BETWEEN $1 AND $2
        GROUP BY 1
     ),
     payout AS (
       SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
              COALESCE(AVG(p.amount_payable), 0) AS avg_payout,
              COUNT(DISTINCT p.account_id)::int  AS paying_accounts
         FROM payouts p
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status = 'paid'
        GROUP BY 1
     )
     SELECT s.model_slug, s.orders, s.avg_fee,
            COALESCE(o.resolved, 0)::int AS resolved,
            COALESCE(o.passed, 0)::int   AS passed,
            COALESCE(p.avg_payout, 0)    AS avg_payout,
            COALESCE(p.paying_accounts, 0)::int AS paying_accounts
       FROM sold s
       LEFT JOIN outcome o ON o.model_slug = s.model_slug
       LEFT JOIN payout  p ON p.model_slug = s.model_slug
      ORDER BY s.orders DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => {
    const avgFee = num(r.avg_fee)
    const resolved = int(r.resolved)
    const passed = int(r.passed)
    const avgPayout = num(r.avg_payout)
    const passProbability = resolved > 0 ? passed / resolved : null

    return {
      model_slug: r.model_slug,
      orders: int(r.orders),
      avg_fee: round(avgFee),
      resolved,
      passed,
      pass_probability_pct: passProbability === null ? null : round(passProbability * 100),
      avg_payout: round(avgPayout),
      paying_accounts: int(r.paying_accounts),
      // EV = fee − P(pass) × average realised payout. Null when the model has
      // no resolved accounts yet: an EV computed off zero observations would be
      // the fee itself, which reads as a wildly profitable model.
      expected_value: passProbability === null
        ? null
        : round(avgFee - (passProbability * avgPayout))
    }
  })
}

// ── B38: scaling programme uptake ────────────────────────────────────────────
async function scalingUptake (range) {
  const { rows } = await readPool.query(
    `SELECT COALESCE(a.challenge_model_slug, 'unknown') AS model_slug,
            COUNT(*)::int                                              AS funded_accounts,
            COUNT(*) FILTER (WHERE a.scaling_milestones_claimed > 0)::int AS scaled_accounts,
            COALESCE(SUM(a.scaling_milestones_claimed), 0)::int        AS milestones_claimed,
            COALESCE(AVG(a.scaling_multiplier), 1)                     AS avg_multiplier,
            COALESCE(SUM(a.account_size * (a.scaling_multiplier - 1)), 0) AS added_notional
       FROM accounts a
      WHERE a.account_type = 'funded'
        AND a.created_at BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY funded_accounts DESC`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    model_slug: r.model_slug,
    funded_accounts: int(r.funded_accounts),
    scaled_accounts: int(r.scaled_accounts),
    uptake_pct: pct(r.scaled_accounts, r.funded_accounts),
    milestones_claimed: int(r.milestones_claimed),
    avg_multiplier: round(r.avg_multiplier, 2),
    // Extra funded notional the scaling programme has put on the book — the
    // firm's added exposure, not a cost.
    added_notional: round(r.added_notional)
  }))
}

// ── B39: free-retry impact ───────────────────────────────────────────────────
async function retryImpact (range) {
  const { rows } = await readPool.query(
    `SELECT (a.free_retries_remaining IS NOT NULL AND a.free_retries_remaining > 0) AS had_retry_left,
            COUNT(*)::int                                    AS accounts,
            COUNT(*) FILTER (WHERE a.status = 'passed')::int AS passed,
            COUNT(*) FILTER (WHERE a.status IN ('failed','expired'))::int AS failed
       FROM accounts a
      WHERE a.created_at BETWEEN $1 AND $2
        AND a.status IN ('passed', 'failed', 'expired')
      GROUP BY 1`,
    [range.fromTs, range.toTs]
  )

  const withRetry = rows.find((r) => r.had_retry_left === true) || {}
  const withoutRetry = rows.find((r) => r.had_retry_left === false) || {}

  return {
    with_retry_remaining: {
      accounts: int(withRetry.accounts),
      passed: int(withRetry.passed),
      pass_rate_pct: pct(withRetry.passed, withRetry.accounts)
    },
    retry_exhausted: {
      accounts: int(withoutRetry.accounts),
      passed: int(withoutRetry.passed),
      pass_rate_pct: pct(withoutRetry.passed, withoutRetry.accounts)
    },
    note: 'Descriptive, not causal: an account that has already consumed its free retry is by definition a second attempt, so the two groups differ in more than the retry itself.'
  }
}

// ── B40: rule-change impact ──────────────────────────────────────────────────
async function ruleChanges (range) {
  const { rows } = await readPool.query(
    `SELECT s.id, s.key, s.old_value, s.new_value, s.changed_at,
            (SELECT COUNT(*) FROM accounts a
              WHERE a.created_at >= s.changed_at - INTERVAL '14 days'
                AND a.created_at <  s.changed_at)::int AS accounts_before,
            (SELECT COUNT(*) FROM accounts a
              WHERE a.created_at >= s.changed_at
                AND a.created_at <  s.changed_at + INTERVAL '14 days')::int AS accounts_after,
            (SELECT COUNT(*) FROM accounts a
              WHERE a.status = 'passed'
                AND a.created_at >= s.changed_at - INTERVAL '14 days'
                AND a.created_at <  s.changed_at)::int AS passed_before,
            (SELECT COUNT(*) FROM accounts a
              WHERE a.status = 'passed'
                AND a.created_at >= s.changed_at
                AND a.created_at <  s.changed_at + INTERVAL '14 days')::int AS passed_after
       FROM settings_change_log s
      WHERE s.changed_at BETWEEN $1 AND $2
      ORDER BY s.changed_at DESC
      LIMIT 50`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    id: int(r.id),
    key: r.key,
    old_value: r.old_value,
    new_value: r.new_value,
    changed_at: r.changed_at,
    window_days: 14,
    accounts_before: int(r.accounts_before),
    accounts_after: int(r.accounts_after),
    pass_rate_before_pct: pct(r.passed_before, r.accounts_before),
    pass_rate_after_pct: pct(r.passed_after, r.accounts_after)
  }))
}

async function build (range) {
  const [
    rates, causes, timing, survival, sensitivity,
    binds, difficulty, funded, ev, scaling, retries, changes
  ] = await Promise.all([
    passRates(range),
    failCauses(range),
    timeToOutcome(range),
    survivalCurves(range),
    ruleSensitivity(range),
    bindRates(range),
    difficultyVsPrice(range),
    fundedLifecycle(range),
    expectedValue(range),
    scalingUptake(range),
    retryImpact(range),
    ruleChanges(range)
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    pass_rates: rates,        // B26, B35
    fail_causes: causes,      // B27
    time_to_outcome: timing,  // B28
    survival,                 // B29
    rule_sensitivity: sensitivity, // B30
    bind_rates: binds,        // B31, B32, B33
    difficulty,               // B34
    funded_lifecycle: funded, // B36
    expected_value: ev,       // B37
    scaling,                  // B38
    retry_impact: retries,    // B39
    rule_changes: changes     // B40
  }
}

module.exports = { build, computeDifficulty, DIFFICULTY_WEIGHTS }
