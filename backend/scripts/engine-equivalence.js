#!/usr/bin/env node
'use strict'
/**
 * Engine equivalence harness
 * ─────────────────────────────────────────────────────────────────────────────
 * Answers one question: **does ENGINE_MODE=event decide the same things as
 * ENGINE_MODE=interval?**
 *
 * This is the gate that has been owed since the event engine was written. The
 * unit tests in test/eventEngine.test.js check that the event path behaves
 * sensibly in isolation; nothing has ever compared the two paths' *outcomes* on
 * the same data. Since the interval path is what has been deciding real money
 * outcomes in production, it is the reference — any divergence is the event
 * path being wrong until proven otherwise.
 *
 * ── How it works ──
 *
 *   1. Seed a fixed scenario set with DETERMINISTIC ids (see makeId).
 *   2. Replay a scripted price walk through the interval path
 *      (checkSLTP / checkPendingOrders / checkFloatingDrawdown).
 *   3. Snapshot every table the engine writes.
 *   4. Tear down, re-seed byte-identically, reset all in-memory state.
 *   5. Replay the SAME price walk through the event path (onPriceTick).
 *   6. Snapshot again and diff.
 *
 * Deterministic ids are what make step 6 a row-by-row comparison rather than a
 * fuzzy set match.
 *
 * ── What is compared, and what is deliberately not ──
 *
 * Columns come from information_schema, not a hand-written list, so a column
 * added later is compared automatically instead of being silently missed.
 *
 * Excluded everywhere: timestamp/date columns. Two runs happen at different
 * wall-clock times and always differ; that is not a divergence.
 *
 * Excluded on DERIVED tables only (bbook_pnl, admin_rule_violations,
 * admin_enforcement_events): uuid columns. Rows the engine creates get
 * randomUUID()s that cannot match across runs. Seeded tables (trades, accounts)
 * keep their uuid columns, because those ids ARE deterministic and a trade
 * ending up on the wrong account is exactly the kind of bug worth catching.
 *
 * ── Usage ──
 *
 *   node scripts/engine-equivalence.js
 *   node scripts/engine-equivalence.js --ticks=120 --verbose
 *   node scripts/engine-equivalence.js --keep        # leave run 2's data behind
 *
 * Options:
 *   --ticks=N       price steps to replay        (default 80)
 *   --tolerance=N   absolute numeric tolerance   (default 0 — exact match)
 *   --verbose       print every differing column, not just the first few
 *   --keep          skip the final teardown
 *   --force         run despite pre-existing active accounts (see Safety)
 *
 * ── Safety ──
 *
 * Identical to scripts/seed-load-test.js, and for the same reason: both engines
 * evaluate EVERY active account, not just the seeded ones. There is no way to
 * fence them off. Replaying synthetic prices over somebody else's open
 * positions closes them and fails or passes their accounts for real. So this
 * refuses to start when such accounts exist unless --force is passed, and
 * refuses a DATABASE_URL that does not look local/test unless
 * LOAD_TEST_ALLOW_NONLOCAL=1.
 *
 * Exit code is 1 on any divergence, so this can gate a deploy.
 */

require('../loadEnv')

const pool = require('../db')
const logger = require('../utils/logger')
const priceCache = require('../utils/priceCache')
const tradeIndex = require('../utils/tradeIndex')
const tradeEngine = require('../services/tradeEngine')

// ─── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { keep: false, force: false, verbose: false }
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    if (value === undefined) args[key] = true
    else args[key] = /^-?\d+(\.\d+)?$/.test(value) ? parseFloat(value) : value
  }
  return args
}

const args = parseArgs(process.argv)
const TICK_COUNT = args.ticks || 80
const TOLERANCE = args.tolerance || 0
const RUN_TAG = 'equivalence-run'

// Tables the engine and everything it calls can write. Derived tables get their
// uuid columns dropped from the comparison (see the header).
const SEEDED_TABLES = ['accounts', 'trades']
const DERIVED_TABLES = ['bbook_pnl', 'admin_rule_violations', 'admin_enforcement_events']

// ─── Deterministic ids ────────────────────────────────────────────────────────
/**
 * A stable, valid UUID for slot `n`. Both runs seed the same slots, so run 1's
 * account 3 and run 2's account 3 are literally the same id and diff directly.
 * 'feed' is coincidentally valid hex, which is the only reason it reads nicely.
 */
function makeId(n) {
  return `feed0000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

const USER_ID = makeId(1)

// ─── Instruments ──────────────────────────────────────────────────────────────
// USD-quoted on purpose: getUsdRateForInstrument returns 1 for these without
// consulting a rate feed. A non-USD instrument would make both paths skip the
// instrument when no rate is loaded — they would agree, but agree about doing
// nothing, which tests nothing. Three different contract sizes (100000 / 100 / 1)
// so a contract-size mistake in either path shows up.
const FX = 'EURUSD'      // contract size 100000
const METAL = 'XAUUSD'   // contract size 100
const INDEX = 'US500'    // contract size 1
const SCENARIO_INSTRUMENTS = [FX, METAL, INDEX]

const BASE = { [FX]: 1.10000, [METAL]: 2000.00, [INDEX]: 5000.00 }

/**
 * The price script.
 *
 * A single monotone walk would only ever test one direction, and a random walk
 * would not be reproducible. This ramps down to 0.4% below base by the midpoint,
 * then back up to 0.4% above — so every scenario below gets approached from one
 * side and then crossed, and levels that should NOT trigger get genuinely close
 * to triggering before turning back.
 */
function priceAt(tick) {
  const half = TICK_COUNT / 2
  const phase = tick <= half ? -(tick / half) : -1 + 2 * ((tick - half) / half)
  const drift = phase * 0.004
  const prices = Object.create(null)
  for (const instrument of SCENARIO_INSTRUMENTS) {
    const mid = BASE[instrument] * (1 + drift)
    prices[instrument] = {
      bid: mid,
      ask: mid * 1.00005,
      updated_at: new Date(),
      age_ms: 0,
      stale: false
    }
  }
  return prices
}

// ─── Scenarios ────────────────────────────────────────────────────────────────
/**
 * Each scenario is one account so outcomes stay isolated — an account that fails
 * on drawdown closes all its trades, which would mask a second scenario sharing
 * it.
 *
 * Levels are placed against the walk in priceAt(): the walk reaches -0.4% at the
 * midpoint and +0.4% at the end, so a level at -0.2% triggers on the way down and
 * a level at -0.6% never does.
 */
const SCENARIOS = [
  {
    key: 'sl-hit-buy',
    note: 'buy stopped out on the way down',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    trades: [{ instrument: FX, direction: 'buy', lots: 0.5, openAt: 0, sl: -0.002, tp: +0.010 }]
  },
  {
    key: 'tp-hit-sell',
    note: 'sell take-profit on the way down',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    trades: [{ instrument: METAL, direction: 'sell', lots: 1, openAt: 0, sl: +0.010, tp: -0.002 }]
  },
  {
    key: 'sl-tp-untouched',
    note: 'control — levels approached but never crossed, must not close',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    trades: [{ instrument: FX, direction: 'buy', lots: 0.1, openAt: 0, sl: -0.006, tp: +0.006 }]
  },
  {
    key: 'trailing-breach',
    note: 'equity falls through the trailing drawdown floor',
    // 0.5% of 100k = $500. A 1-lot EURUSD position loses $1000 per 0.1% adverse
    // move at contract size 100000, so the walk's -0.4% takes this well through.
    account: { accountType: 'phase1', maxDrawdownPct: 0.5, dailyDrawdownPct: null, profitTarget: 1e9 },
    trades: [{ instrument: FX, direction: 'buy', lots: 1, openAt: 0, sl: null, tp: null }]
  },
  {
    key: 'daily-breach',
    note: 'daily loss limit hit before the trailing floor',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: 0.5, profitTarget: 1e9 },
    trades: [{ instrument: FX, direction: 'buy', lots: 1, openAt: 0, sl: null, tp: null }]
  },
  {
    key: 'profit-target',
    note: 'profit target reached on the way back up',
    // Target $1500; a 1-lot short at -0.4% then long recovery clears it.
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1500 },
    trades: [{ instrument: FX, direction: 'sell', lots: 1, openAt: 0, sl: null, tp: null }]
  },
  {
    key: 'funded-no-target',
    note: 'funded accounts must never auto-pass on profit, only breach',
    account: { accountType: 'funded', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 100 },
    trades: [{ instrument: METAL, direction: 'sell', lots: 1, openAt: 0, sl: null, tp: null }]
  },
  {
    key: 'pending-buy-stop',
    note: 'buy stop above market, filled on the way back up',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    pending: [{ instrument: INDEX, orderType: 'buy_stop', direction: 'buy', lots: 0.1, triggerAt: +0.002 }]
  },
  {
    key: 'pending-sell-stop',
    note: 'sell stop below market, filled on the way down',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    pending: [{ instrument: INDEX, orderType: 'sell_stop', direction: 'sell', lots: 0.1, triggerAt: -0.002 }]
  },
  {
    key: 'pending-untouched',
    note: 'control — pending level never reached, must stay pending',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    pending: [{ instrument: INDEX, orderType: 'buy_stop', direction: 'buy', lots: 0.1, triggerAt: +0.020 }]
  },
  {
    key: 'multi-instrument',
    note: 'one account holding positions on three instruments at once',
    account: { accountType: 'phase1', maxDrawdownPct: 90, dailyDrawdownPct: null, profitTarget: 1e9 },
    trades: [
      { instrument: FX, direction: 'buy', lots: 0.2, openAt: 0, sl: null, tp: null },
      { instrument: METAL, direction: 'sell', lots: 0.5, openAt: 0, sl: null, tp: null },
      { instrument: INDEX, direction: 'buy', lots: 0.3, openAt: 0, sl: null, tp: null }
    ]
  }
]

// ─── Guards ───────────────────────────────────────────────────────────────────
function assertSafeTarget() {
  const url = String(process.env.DATABASE_URL || '')
  if (!url) throw new Error('DATABASE_URL is not set')
  if (process.env.LOAD_TEST_ALLOW_NONLOCAL === '1') return

  const looksLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url)
  const looksTest = /(test|staging|load)/i.test(url)
  if (!looksLocal && !looksTest) {
    throw new Error(
      'Refusing to run: DATABASE_URL does not look like a local or test database.\n' +
      'This script writes and deletes real rows, and both engines act on every active\n' +
      'account in the database. Set LOAD_TEST_ALLOW_NONLOCAL=1 only if you are certain.'
    )
  }
}

async function assertNoBystanderAccounts() {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT a.id) AS accounts, COUNT(t.id) AS trades
       FROM accounts a
       JOIN trades t ON t.account_id = a.id AND t.status IN ('open', 'pending')
      WHERE a.status = 'active'
        AND (a.challenge_model_slug IS NULL OR a.challenge_model_slug <> $1)`,
    [RUN_TAG]
  )
  const accounts = parseInt(result.rows[0].accounts, 10) || 0
  const trades = parseInt(result.rows[0].trades, 10) || 0
  if (accounts === 0) return

  if (!args.force) {
    throw new Error(
      `Refusing to run: ${accounts} active account(s) with ${trades} open/pending trade(s) exist that this script did not create.\n` +
      'Both engines evaluate every active account, so replaying prices would close their trades\n' +
      'and could fail or pass them for real. Use a scratch database, or pass --force if disposable.'
    )
  }
  process.stdout.write(
    `WARNING: --force given. ${accounts} pre-existing account(s) with ${trades} open/pending trade(s)\n` +
    'will be traded against and may be closed, failed or passed. They will also pollute the diff.\n\n'
  )
}

/**
 * A running backend is fatal here, not merely noisy as it is in the load test.
 * Its interval engine would act on the seeded rows during BOTH runs but at
 * different points in each, producing a divergence that looks like an engine bug
 * and is not. There is no way to distinguish that from a real finding after the
 * fact, so refuse rather than report a result nobody can trust.
 */
async function assertNoConcurrentBackend() {
  const result = await pool.query(
    `SELECT COUNT(*) AS others
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`
  )
  const others = parseInt(result.rows[0].others, 10) || 0
  if (others <= 4) return
  if (args.force) {
    process.stdout.write(`WARNING: ${others} other client connections — results may be contaminated.\n\n`)
    return
  }
  throw new Error(
    `Refusing to run: ${others} other client connections to this database.\n` +
    'A running backend acts on the seeded rows at different moments in each run, which produces\n' +
    'divergence that is indistinguishable from a real engine bug. Stop it (`npm start` / `npm run dev`),\n' +
    'or pass --force to accept an untrustworthy result.'
  )
}

// ─── Seeding ──────────────────────────────────────────────────────────────────
function levelPrice(instrument, offset) {
  return offset == null ? null : BASE[instrument] * (1 + offset)
}

async function seed() {
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name, country, created_at)
     VALUES ($1, $2, 'equivalence-no-login', $3, 'XX', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, `${RUN_TAG}@equivalence.invalid`, RUN_TAG]
  )

  let slot = 100
  const seededScenarios = []

  for (const scenario of SCENARIOS) {
    const accountId = makeId(slot++)
    const spec = scenario.account

    await pool.query(
      `INSERT INTO accounts
         (id, user_id, account_size, current_balance, starting_balance, peak_balance,
          status, account_type, max_drawdown_pct, daily_drawdown_pct, profit_target,
          challenge_model_slug, eod_peak_equity, eod_trailing_floor, created_at)
       VALUES ($1, $2, 100000, 100000, 100000, 100000,
               'active', $3, $4, $5, $6, $7, NULL, NULL, NOW())`,
      [accountId, USER_ID, spec.accountType, spec.maxDrawdownPct,
        spec.dailyDrawdownPct, spec.profitTarget, RUN_TAG]
    )

    for (const trade of scenario.trades || []) {
      const tradeId = makeId(slot++)
      await pool.query(
        // demo_trade_id is passed as its own parameter rather than reusing $1.
        // `VALUES ($1, $2, $1::text, ...)` asks Postgres to deduce $1 as both
        // uuid (the id column) and text, which it refuses with `inconsistent
        // types deduced for parameter $1` — so seeding failed before a single
        // tick was replayed, which is why this harness had never produced a
        // result.
        `INSERT INTO trades
           (id, account_id, demo_trade_id, instrument, direction, lot_size, open_price,
            open_time, status, stop_loss, take_profit, order_type, commission, original_commission)
         VALUES ($1, $2, $9, $3, $4, $5, $6,
                 NOW() - interval '1 hour', 'open', $7, $8, 'market', 0, 0)`,
        [tradeId, accountId, trade.instrument, trade.direction, trade.lots,
          levelPrice(trade.instrument, trade.openAt),
          levelPrice(trade.instrument, trade.sl),
          levelPrice(trade.instrument, trade.tp),
          String(tradeId)]
      )
    }

    for (const order of scenario.pending || []) {
      const orderId = makeId(slot++)
      await pool.query(
        // Same as above: demo_trade_id gets its own parameter.
        `INSERT INTO trades
           (id, account_id, demo_trade_id, instrument, direction, lot_size, open_price,
            open_time, status, order_type, pending_price, commission, original_commission)
         VALUES ($1, $2, $8, $3, $4, $5, $6,
                 NOW() - interval '1 hour', 'pending', $7, $6, 0, 0)`,
        [orderId, accountId, order.instrument, order.direction, order.lots,
          levelPrice(order.instrument, order.triggerAt), order.orderType,
          String(orderId)]
      )
    }

    seededScenarios.push({ key: scenario.key, accountId, note: scenario.note })
  }

  return seededScenarios
}

async function teardown() {
  // Promotion creates NEW accounts for the same user, so delete by user rather
  // than by tag — a promoted phase2 account carries the model slug of its plan,
  // not RUN_TAG, and would otherwise be left behind to poison the next run.
  await pool.query(
    `DELETE FROM trades WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)`,
    [USER_ID]
  )
  await pool.query(
    `DELETE FROM bbook_pnl WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)`,
    [USER_ID]
  ).catch(() => {})
  for (const table of ['admin_rule_violations', 'admin_enforcement_events']) {
    await pool.query(
      `DELETE FROM ${table} WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)`,
      [USER_ID]
    ).catch(() => {})
  }
  await pool.query(`DELETE FROM accounts WHERE user_id = $1`, [USER_ID])
  await pool.query(`DELETE FROM users WHERE id = $1`, [USER_ID])
}

// ─── Snapshotting ─────────────────────────────────────────────────────────────
const VOLATILE_TYPES = new Set([
  'timestamp with time zone',
  'timestamp without time zone',
  'date',
  'time without time zone'
])

async function comparableColumns(table, { dropUuids }) {
  const result = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table]
  )
  if (result.rows.length === 0) return null

  return result.rows
    .filter((row) => !VOLATILE_TYPES.has(row.data_type))
    .filter((row) => !(dropUuids && row.data_type === 'uuid'))
    .map((row) => row.column_name)
}

/**
 * Read every engine-written table for this run's user, as plain comparable rows.
 *
 * Ordering has to be deterministic and independent of insertion order, or two
 * runs that did the same thing in a different sequence would diff. Seeded tables
 * order by their deterministic id; derived tables order by every compared column,
 * which is stable for any fixed row multiset.
 */
async function snapshot() {
  const tables = {}

  for (const table of SEEDED_TABLES) {
    const columns = await comparableColumns(table, { dropUuids: false })
    if (!columns) { tables[table] = null; continue }

    const scope = table === 'accounts'
      ? 'WHERE user_id = $1'
      : 'WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)'

    const result = await pool.query(
      `SELECT ${columns.map((c) => `"${c}"`).join(', ')} FROM ${table} ${scope} ORDER BY id`,
      [USER_ID]
    )
    tables[table] = result.rows
  }

  for (const table of DERIVED_TABLES) {
    const columns = await comparableColumns(table, { dropUuids: true })
    if (!columns) { tables[table] = null; continue }
    if (columns.length === 0) { tables[table] = []; continue }

    const quoted = columns.map((c) => `"${c}"`)
    const result = await pool.query(
      `SELECT ${quoted.join(', ')} FROM ${table}
        WHERE account_id IN (SELECT id FROM accounts WHERE user_id = $1)
        ORDER BY ${quoted.map((c) => `${c} NULLS FIRST`).join(', ')}`,
      [USER_ID]
    ).catch(() => null)
    tables[table] = result ? result.rows : null
  }

  return tables
}

// ─── Diffing ──────────────────────────────────────────────────────────────────
function normalise(value) {
  if (value == null) return null
  // Postgres numerics come back as strings; compare them as numbers so
  // '100.00' and '100' are the same balance rather than a false positive.
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return parseFloat(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}

function valuesDiffer(a, b) {
  const left = normalise(a)
  const right = normalise(b)
  if (typeof left === 'number' && typeof right === 'number') {
    return Math.abs(left - right) > TOLERANCE
  }
  return left !== right
}

function diffTable(table, intervalRows, eventRows) {
  const findings = []

  if (intervalRows === null || eventRows === null) {
    if (intervalRows !== eventRows) {
      findings.push({ table, kind: 'table-missing', detail: 'table present in one run only' })
    }
    return findings
  }

  if (intervalRows.length !== eventRows.length) {
    findings.push({
      table,
      kind: 'row-count',
      detail: `interval produced ${intervalRows.length} row(s), event produced ${eventRows.length}`
    })
  }

  const shared = Math.min(intervalRows.length, eventRows.length)
  for (let i = 0; i < shared; i++) {
    const left = intervalRows[i]
    const right = eventRows[i]
    for (const column of Object.keys(left)) {
      if (!valuesDiffer(left[column], right[column])) continue
      findings.push({
        table,
        kind: 'value',
        row: i,
        rowId: left.id || left.account_id || `#${i}`,
        column,
        interval: left[column],
        event: right[column]
      })
    }
  }

  return findings
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function replayInterval() {
  for (let tick = 0; tick <= TICK_COUNT; tick++) {
    priceCache.__setPricesForTest(priceAt(tick))
    // Same order the scheduler registers them in. All three take `io` and every
    // emit inside is guarded by `if (io)`, so null is safe.
    await tradeEngine.checkSLTP(null)
    await tradeEngine.checkPendingOrders(null)
    await tradeEngine.checkFloatingDrawdown(null)
  }
}

async function replayEvent() {
  await tradeEngine.initializeEngine()

  for (let tick = 0; tick <= TICK_COUNT; tick++) {
    const changed = priceCache.__setPricesForTest(priceAt(tick))
    if (changed.length > 0) await tradeEngine.onPriceTick(null, changed)
  }

  // Peak equity and locked floors are accumulated in memory and written by a
  // 1s timer in production (PEAK_EQUITY_FLUSH_MS). Without this flush the event
  // run would show unwritten peaks and diff against the interval run, which
  // persists them inline — a reporting artefact, not a real divergence.
  await tradeEngine.flushDirtyPeaks()
}

function resetInMemoryState() {
  tradeIndex.__reset()
  priceCache.__reset()
}

// ─── Accepted divergences ─────────────────────────────────────────────────────
/**
 * Differences that are known, understood, and deliberately accepted.
 *
 * There is exactly one, and it is not cosmetic. `accounts.eod_peak_equity` comes
 * out HIGHER under the event path, because that path evaluates on every tick
 * while the interval path samples once a second and misses intermediate highs.
 *
 * The event figure is the truer high-water mark — but eod_peak_equity feeds the
 * trailing drawdown floor, so a higher peak means a HIGHER FLOOR and traders
 * breach marginally earlier. That fairness trade was taken deliberately on
 * 2026-08-17 when `event` became the default (see .env.template): the gap is
 * ~0.2% of a 10% drawdown allowance, and the interval path was under-measuring
 * a peak its own rule is defined in terms of.
 *
 * Recording it here rather than leaving it in the failure list is the point.
 * Before, this harness reported DIVERGENT and printed "Do NOT flip
 * ENGINE_MODE=event" against a codebase where event IS the default — a gate that
 * contradicts the shipped configuration is a gate everybody learns to ignore,
 * and the next real divergence would have been ignored with it.
 *
 * ONLY the direction below is accepted. An event value LOWER than interval is a
 * genuine divergence and still fails.
 */
const ACCEPTED_DIVERGENCES = [
  {
    table: 'accounts',
    column: 'eod_peak_equity',
    reason: 'event evaluates every tick and catches intermediate highs; documented 2026-08-17',
    accepts: (finding) => {
      const interval = Number(finding.interval)
      const event = Number(finding.event)
      if (!Number.isFinite(interval) || !Number.isFinite(event)) return false
      return event >= interval
    }
  }
]

function partitionFindings(findings) {
  const real = []
  const accepted = []
  for (const finding of findings) {
    const rule = ACCEPTED_DIVERGENCES.find((candidate) =>
      candidate.table === finding.table &&
      candidate.column === finding.column &&
      finding.kind === 'value' &&
      candidate.accepts(finding)
    )
    if (rule) accepted.push({ ...finding, reason: rule.reason })
    else real.push(finding)
  }
  return { real, accepted }
}

function reportAccepted(accepted) {
  if (accepted.length === 0) return
  process.stdout.write(`\nAccepted divergences (${accepted.length}) — known and deliberate:\n`)
  const seen = new Set()
  for (const finding of accepted) {
    const key = `${finding.table}.${finding.column}`
    if (seen.has(key)) continue
    seen.add(key)
    process.stdout.write(`  ${key}\n    ${finding.reason}\n`)
  }
  process.stdout.write('  (event >= interval only; a lower event value would still fail)\n')
}

// ─── Reporting ────────────────────────────────────────────────────────────────
function report(findings, scenarios) {
  if (findings.length === 0) {
    process.stdout.write(`
╭──────────────────────────────────────────────────────────────╮
│  EQUIVALENT — the event path matched the interval path on    │
│  every compared column of every engine-written table.        │
╰──────────────────────────────────────────────────────────────╯

Scenarios exercised (${scenarios.length}):
${scenarios.map((s) => `  ${s.key.padEnd(20)} ${s.note}`).join('\n')}

This is the gate for ENGINE_MODE=event. It does not measure speed —
run scripts/seed-load-test.js for that.
`)
    return
  }

  const byTable = new Map()
  for (const finding of findings) {
    if (!byTable.has(finding.table)) byTable.set(finding.table, [])
    byTable.get(finding.table).push(finding)
  }

  process.stdout.write(`
╭──────────────────────────────────────────────────────────────╮
│  DIVERGENT — ${String(findings.length).padEnd(4)} difference(s) between the two paths.      │
│  The interval path is the reference. Treat every row below   │
│  as the event path being wrong until proven otherwise.       │
╰──────────────────────────────────────────────────────────────╯
`)

  for (const [table, tableFindings] of byTable) {
    process.stdout.write(`\n${table} — ${tableFindings.length} difference(s)\n`)
    const shown = args.verbose ? tableFindings : tableFindings.slice(0, 10)
    for (const finding of shown) {
      if (finding.kind !== 'value') {
        process.stdout.write(`  [${finding.kind}] ${finding.detail}\n`)
        continue
      }
      process.stdout.write(
        `  ${String(finding.rowId).slice(0, 36)} . ${finding.column}\n` +
        `      interval: ${JSON.stringify(finding.interval)}\n` +
        `      event:    ${JSON.stringify(finding.event)}\n`
      )
    }
    if (!args.verbose && tableFindings.length > shown.length) {
      process.stdout.write(`  ... ${tableFindings.length - shown.length} more (use --verbose)\n`)
    }
  }

  process.stdout.write('\nDo NOT flip ENGINE_MODE=event until this is empty.\n')
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  assertSafeTarget()
  await assertNoConcurrentBackend()
  await assertNoBystanderAccounts()

  // Leftovers from an aborted previous run would be picked up by the index and
  // diffed as if this run had produced them.
  await teardown()

  const originalLevel = logger.level
  logger.level = 'error'

  let seeded = false
  try {
    process.stdout.write(`Replaying ${TICK_COUNT} ticks through the INTERVAL path...\n`)
    const scenarios = await seed()
    seeded = true
    resetInMemoryState()
    await replayInterval()
    const intervalSnapshot = await snapshot()

    process.stdout.write(`Replaying ${TICK_COUNT} ticks through the EVENT path...\n`)
    await teardown()
    await seed()
    resetInMemoryState()
    await replayEvent()
    const eventSnapshot = await snapshot()

    const allFindings = []
    for (const table of [...SEEDED_TABLES, ...DERIVED_TABLES]) {
      allFindings.push(...diffTable(table, intervalSnapshot[table], eventSnapshot[table]))
    }

    const { real, accepted } = partitionFindings(allFindings)

    report(real, scenarios)
    reportAccepted(accepted)
    process.exitCode = real.length === 0 ? 0 : 1
  } finally {
    logger.level = originalLevel
    if (seeded && !args.keep) {
      await teardown().catch((error) => {
        process.stderr.write(
          `Teardown failed — clean up manually with: DELETE FROM accounts WHERE user_id = '${USER_ID}';\n` +
          `${error.message}\n`
        )
      })
    } else if (args.keep) {
      process.stdout.write(`\nData left in place (user_id = '${USER_ID}').\n`)
    }
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(`\nEquivalence run failed: ${error.message}\n${error.stack}\n`)
  process.exitCode = 1
})
