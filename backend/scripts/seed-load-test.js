#!/usr/bin/env node
'use strict'
/**
 * Trade engine load harness
 * ─────────────────────────────────────────────────────────────────────────────
 * Measures what the event-driven engine actually costs per price tick at a given
 * number of open trades.
 *
 * This exists because the "~3-8ms per tick at 100K trades" figure behind the
 * design is a projection, not a measurement. The platform's real ceiling to date
 * is a few hundred concurrent trades, so nothing in production has ever
 * exercised the paths this rewrote. Run it before flipping ENGINE_MODE=event,
 * and treat p99 — not p50 — as the number that matters: a tick that occasionally
 * takes 200ms is a tick that occasionally delays a stop-loss by 200ms.
 *
 * If p99 comes back above ~20ms at the target trade count, that is the signal to
 * revisit the deferred worker-thread design rather than shipping on the estimate.
 *
 * ── Usage ──
 *
 *   node scripts/seed-load-test.js --trades=100000
 *   node scripts/seed-load-test.js --trades=10000 --ticks=500 --instruments=40
 *   node scripts/seed-load-test.js --trades=1000 --keep     # leave the data behind
 *
 * Options:
 *   --trades=N        open trades to seed              (default 10000)
 *   --accounts=N      accounts to spread them over     (default trades/50)
 *   --instruments=N   instruments to spread them over  (default all)
 *   --ticks=N         price ticks to replay            (default 200)
 *   --moved=N         instruments changed per tick     (default 3)
 *   --keep            skip teardown (inspect the data yourself)
 *   --force           run even when accounts this script did not create would be
 *                     traded against (see Safety below)
 *
 * ── Safety ──
 *
 * This writes real rows to whatever DATABASE_URL points at. Everything it
 * creates is tagged with a single run id and removed on teardown, and it refuses
 * to run against a database that isn't obviously a test target unless
 * LOAD_TEST_ALLOW_NONLOCAL=1 is set. Do not point it at production.
 *
 * More importantly: the engine's index is built from the WHOLE database, not
 * just the rows seeded here. There is no way for this script to fence the engine
 * off from accounts it did not create — replaying prices will evaluate every
 * active account with open trades, and can close their trades or fail/pass them
 * for real. So it refuses to start when any such account exists unless --force
 * is passed. That check is the actual safety mechanism; the run-id tagging only
 * covers cleanup of what this script created.
 */

require('../loadEnv')

const { randomUUID } = require('crypto')
const pool = require('../db')
const logger = require('../utils/logger')
const priceCache = require('../utils/priceCache')
const tradeIndex = require('../utils/tradeIndex')
const tradeEngine = require('../services/tradeEngine')
const { INSTRUMENTS, CONTRACT_SIZES } = require('../constants')

// ─── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { keep: false, force: false }
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    if (value === undefined) args[key] = true
    else args[key] = /^\d+$/.test(value) ? parseInt(value, 10) : value
  }
  return args
}

const args = parseArgs(process.argv)
const TRADE_COUNT = args.trades || 10000
const ACCOUNT_COUNT = args.accounts || Math.max(1, Math.ceil(TRADE_COUNT / 50))
const INSTRUMENT_COUNT = Math.min(args.instruments || INSTRUMENTS.length, INSTRUMENTS.length)
const TICK_COUNT = args.ticks || 200
const MOVED_PER_TICK = args.moved || 3
const RUN_ID = `loadtest-${randomUUID().slice(0, 8)}`
const INSTRUMENT_SET = INSTRUMENTS.slice(0, INSTRUMENT_COUNT)

// ─── Guards ───────────────────────────────────────────────────────────────────
function assertSafeTarget() {
  const url = String(process.env.DATABASE_URL || '')
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  if (process.env.LOAD_TEST_ALLOW_NONLOCAL === '1') return

  const looksLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url)
  const looksTest = /(test|staging|load)/i.test(url)
  if (!looksLocal && !looksTest) {
    throw new Error(
      'Refusing to run: DATABASE_URL does not look like a local or test database.\n' +
      'This script writes and deletes real rows. Set LOAD_TEST_ALLOW_NONLOCAL=1 only if you are certain.'
    )
  }
}

/**
 * Refuse to run if the database holds accounts this script did not create that
 * the engine would act on.
 *
 * fullReconcileFromDB() has no notion of "only my rows" — it loads every active
 * account and every open trade, which is correct for the engine and unavoidable
 * here. Replaying synthetic prices over someone else's open positions would
 * close them, and fail or pass their accounts, with no way to undo it.
 */
async function assertNoBystanderAccounts() {
  const result = await pool.query(
    `SELECT COUNT(DISTINCT a.id) AS accounts, COUNT(t.id) AS trades
       FROM accounts a
       JOIN trades t ON t.account_id = a.id AND t.status IN ('open', 'pending')
      WHERE a.status = 'active'
        AND (a.challenge_model_slug IS NULL OR a.challenge_model_slug NOT LIKE 'loadtest-%')`
  )
  const accounts = parseInt(result.rows[0].accounts, 10) || 0
  const trades = parseInt(result.rows[0].trades, 10) || 0
  if (accounts === 0) return

  if (!args.force) {
    throw new Error(
      `Refusing to run: ${accounts} active account(s) with ${trades} open/pending trade(s) exist that this script did not create.\n` +
      'The engine evaluates every active account, so replaying prices would close their trades and could fail or pass them for real.\n' +
      'Close or archive them first, use a scratch database, or pass --force if this data is disposable.'
    )
  }
  process.stdout.write(
    `WARNING: --force given. ${accounts} pre-existing account(s) with ${trades} open/pending trade(s) will be traded against and may be closed, failed or passed.\n`
  )
}

/**
 * Detect another backend running against the same database.
 *
 * A live `node server.js` runs its own interval engine on the same tables, so it
 * will close the trades seeded here out from under the replay and compete for
 * row locks. That shows up as trades vanishing between seed and index build, as
 * closures that the seeded thresholds make impossible, and as latency outliers
 * that are lock contention rather than engine cost. The resulting numbers are an
 * upper bound at best, so it is worth saying so loudly rather than quietly
 * reporting a contaminated p99.
 */
async function warnAboutConcurrentBackends() {
  const result = await pool.query(
    `SELECT COUNT(*) AS others
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND backend_type = 'client backend'`
  )
  const others = parseInt(result.rows[0].others, 10) || 0
  // The pool itself opens more than one connection, so a couple of peers is
  // normal; a running server shows up well above that.
  if (others <= 4) return false

  process.stdout.write(
    `\nWARNING: ${others} other client connections to this database.\n` +
    'If a backend (`npm start` / `npm run dev`) is running, its interval engine is closing these\n' +
    'seeded trades and competing for locks — the timings below will be inflated and closure counts\n' +
    'will be non-zero. Stop it for a clean measurement.\n\n'
  )
  return true
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function summarise(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    label,
    count: sorted.length,
    mean: +(sum / (sorted.length || 1)).toFixed(3),
    p50: +percentile(sorted, 50).toFixed(3),
    p95: +percentile(sorted, 95).toFixed(3),
    p99: +percentile(sorted, 99).toFixed(3),
    max: +(sorted[sorted.length - 1] || 0).toFixed(3)
  }
}

/**
 * Event-loop lag sampler.
 *
 * Tick duration alone understates the impact: what a trader feels is the delay
 * before *anything else* — an HTTP request, a socket write — gets served. A
 * synchronous scan that blocks for 200ms shows up here even if the tick's own
 * timer looks fine.
 */
function startLagSampler(intervalMs = 20) {
  const samples = []
  let last = process.hrtime.bigint()
  const handle = setInterval(() => {
    const now = process.hrtime.bigint()
    const elapsedMs = Number(now - last) / 1e6
    samples.push(Math.max(0, elapsedMs - intervalMs))
    last = now
  }, intervalMs)
  handle.unref()
  return { samples, stop: () => clearInterval(handle) }
}

// ─── Seeding ──────────────────────────────────────────────────────────────────
function basePriceFor(instrument) {
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  // Rough but stable: FX-sized contracts sit near 1, metals near 1000-2000.
  if (contractSize >= 100000) return 1.1
  if (contractSize >= 5000) return 25
  return 2000
}

function buildPriceMap(drift = 0) {
  const prices = {}
  for (const instrument of INSTRUMENT_SET) {
    const base = basePriceFor(instrument) * (1 + drift)
    prices[instrument] = { bid: base, ask: base * 1.0001, updated_at: new Date(), age_ms: 0, stale: false }
  }
  return prices
}

async function seed() {
  process.stdout.write(`Seeding ${ACCOUNT_COUNT} accounts and ${TRADE_COUNT} trades (run ${RUN_ID})...\n`)

  const userId = randomUUID()
  // password_hash is a literal, not a hash — this user can never authenticate,
  // which is the point. It exists only to satisfy accounts.user_id.
  await pool.query(
    `INSERT INTO users (id, email, password_hash, full_name, country, created_at)
     VALUES ($1, $2, 'loadtest-no-login', $3, 'XX', NOW())
     ON CONFLICT (email) DO NOTHING`,
    [userId, `${RUN_ID}@loadtest.invalid`, RUN_ID]
  )

  const accountIds = []
  const ACCOUNT_BATCH = 500
  for (let start = 0; start < ACCOUNT_COUNT; start += ACCOUNT_BATCH) {
    const batch = Math.min(ACCOUNT_BATCH, ACCOUNT_COUNT - start)
    const ids = Array.from({ length: batch }, () => randomUUID())
    accountIds.push(...ids)
    // Thresholds are set deliberately out of reach: a 99% drawdown allowance
    // puts the floor near zero, and a $1e9 profit target cannot be hit by the
    // small price drift the replay applies. That keeps the measurement about the
    // *scan* — which is what has to stay cheap at 100K — rather than about the
    // closure path, which is bounded by how many trades genuinely trigger and is
    // exercised by the unit tests instead. A non-zero closure count in the
    // output means this assumption broke and the timings are contaminated.
    await pool.query(
      `INSERT INTO accounts
         (id, user_id, account_size, current_balance, starting_balance, peak_balance,
          status, account_type, max_drawdown_pct, daily_drawdown_pct, profit_target,
          challenge_model_slug, created_at)
       SELECT unnest($1::uuid[]), $2, 100000, 100000, 100000, 100000,
              'active', 'phase1', 99, NULL, 1000000000, $3, NOW()`,
      [ids, userId, RUN_ID]
    )
  }

  const TRADE_BATCH = 2000
  let seeded = 0
  while (seeded < TRADE_COUNT) {
    const batch = Math.min(TRADE_BATCH, TRADE_COUNT - seeded)
    const ids = []
    const accounts = []
    const instruments = []
    const directions = []
    const lots = []
    const openPrices = []
    const stopLosses = []
    const takeProfits = []

    for (let i = 0; i < batch; i++) {
      const index = seeded + i
      const instrument = INSTRUMENT_SET[index % INSTRUMENT_SET.length]
      const base = basePriceFor(instrument)
      const isBuy = index % 2 === 0
      ids.push(randomUUID())
      accounts.push(accountIds[index % accountIds.length])
      instruments.push(instrument)
      directions.push(isBuy ? 'buy' : 'sell')
      lots.push(0.01)
      openPrices.push(base)
      // Levels are set far enough away that the replay never actually triggers
      // them — this measures the scan, not the closure path. Closure cost is
      // reported separately when the replay does fire something.
      stopLosses.push(isBuy ? base * 0.5 : base * 1.5)
      takeProfits.push(isBuy ? base * 1.5 : base * 0.5)
    }

    await pool.query(
      `INSERT INTO trades
         (id, account_id, demo_trade_id, instrument, direction, lot_size, open_price,
          open_time, status, stop_loss, take_profit, order_type, commission, original_commission)
       SELECT unnest($1::uuid[]), unnest($2::uuid[]), unnest($1::uuid[])::text,
              unnest($3::text[]), unnest($4::text[]), unnest($5::numeric[]),
              unnest($6::numeric[]), NOW() - interval '1 hour', 'open',
              unnest($7::numeric[]), unnest($8::numeric[]), 'market', 0, 0`,
      [ids, accounts, instruments, directions, lots, openPrices, stopLosses, takeProfits]
    )

    seeded += batch
    if (seeded % 20000 === 0) process.stdout.write(`  ${seeded}/${TRADE_COUNT}\n`)
  }

  // Verify what actually landed. A silent shortfall here would otherwise show up
  // later as a smaller-than-expected index and quietly understate the timings.
  const verify = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM accounts WHERE challenge_model_slug = $1)                          AS accounts,
       (SELECT COUNT(*) FROM accounts WHERE challenge_model_slug = $1 AND status = 'active')    AS active_accounts,
       (SELECT COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id
         WHERE a.challenge_model_slug = $1)                                                     AS trades,
       (SELECT COUNT(*) FROM trades t JOIN accounts a ON a.id = t.account_id
         WHERE a.challenge_model_slug = $1 AND t.status = 'open')                               AS open_trades`,
    [RUN_ID]
  )
  const counts = verify.rows[0]
  const openTrades = parseInt(counts.open_trades, 10)
  const activeAccounts = parseInt(counts.active_accounts, 10)
  process.stdout.write(
    `Seeded: ${counts.accounts} accounts (${activeAccounts} active), ` +
    `${counts.trades} trades (${openTrades} open)\n`
  )

  // Rows this script just wrote as open/active are already something else by the
  // time we read them back. Nothing in this script does that, so another writer
  // — in practice a running `node server.js` and its interval engine — is
  // operating on the same tables. It will keep closing these trades and
  // competing for row locks throughout the replay, which inflates the timings.
  // This is a far more reliable signal than counting connections, since an idle
  // pool holds very few.
  const shortfall = (TRADE_COUNT - openTrades) + (ACCOUNT_COUNT - activeAccounts)
  if (shortfall > 0) {
    process.stdout.write(
      `\nWARNING: ${TRADE_COUNT - openTrades} trade(s) and ${ACCOUNT_COUNT - activeAccounts} account(s) were already\n` +
      'modified between INSERT and read-back. Another backend is running against this database and its\n' +
      'interval engine is acting on these rows. Stop it (`node server.js` / `npm start`) for a clean\n' +
      'measurement — the numbers below include its lock contention and are an upper bound.\n\n'
    )
  }

  return { userId, accountIds, contended: shortfall > 0 }
}

async function teardown() {
  process.stdout.write('Tearing down...\n')
  await pool.query(
    `DELETE FROM trades WHERE account_id IN (SELECT id FROM accounts WHERE challenge_model_slug = $1)`,
    [RUN_ID]
  )
  await pool.query(`DELETE FROM accounts WHERE challenge_model_slug = $1`, [RUN_ID])
  await pool.query(`DELETE FROM users WHERE email = $1`, [`${RUN_ID}@loadtest.invalid`])
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function replay() {
  const tickDurations = []
  const engineDurations = []
  let totalScanned = 0
  let totalClosures = 0

  const rssStart = process.memoryUsage().rss
  const lag = startLagSampler()

  for (let tick = 0; tick < TICK_COUNT; tick++) {
    // Move a handful of instruments, as a real feed does — the whole point of
    // the instrument index is that a tick touches a few, not all.
    const drift = Math.sin(tick / 12) * 0.0004
    const prices = buildPriceMap(drift)
    const moved = []
    for (let i = 0; i < MOVED_PER_TICK; i++) {
      moved.push(INSTRUMENT_SET[(tick * MOVED_PER_TICK + i) % INSTRUMENT_SET.length])
    }

    priceCache.__setPricesForTest(prices)

    const startedAt = process.hrtime.bigint()
    const result = await tradeEngine.onPriceTick(null, moved)
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

    tickDurations.push(elapsedMs)
    if (result) {
      engineDurations.push(result.durationMs)
      totalScanned += result.scanned
      totalClosures += result.closures
    }

    // Yield so the lag sampler gets a chance to observe the loop.
    await new Promise((resolve) => { setImmediate(resolve) })
  }

  lag.stop()
  const rssEnd = process.memoryUsage().rss

  return {
    tick: summarise('tick (wall)', tickDurations),
    engineReported: summarise('engine self-reported', engineDurations),
    eventLoopLag: summarise('event loop lag', lag.samples),
    totalScanned,
    avgScannedPerTick: Math.round(totalScanned / TICK_COUNT),
    totalClosures,
    rssStartMb: +(rssStart / 1024 / 1024).toFixed(1),
    rssEndMb: +(rssEnd / 1024 / 1024).toFixed(1),
    rssGrowthMb: +((rssEnd - rssStart) / 1024 / 1024).toFixed(1)
  }
}

function printTable(rows) {
  const header = ['metric', 'count', 'mean', 'p50', 'p95', 'p99', 'max']
  const widths = header.map((h) => h.length)
  const data = rows.map((row) => [row.label, row.count, row.mean, row.p50, row.p95, row.p99, row.max].map(String))
  for (const row of data) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length) })

  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')
  process.stdout.write(`\n${line(header)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`)
  for (const row of data) process.stdout.write(`${line(row)}\n`)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  assertSafeTarget()
  await assertNoBystanderAccounts()

  // Quiet the per-tick engine logging so it doesn't dominate the measurement.
  const originalLevel = logger.level
  logger.level = 'error'

  let seeded = false
  try {
    const seedResult = await seed()
    seeded = true
    const contended = seedResult.contended || await warnAboutConcurrentBackends()

    process.stdout.write('Building trade index...\n')
    const indexStart = process.hrtime.bigint()
    const summary = await tradeEngine.initializeEngine()
    const indexMs = Number(process.hrtime.bigint() - indexStart) / 1e6

    // Seed the cache before the first measured tick so tick 0 isn't an outlier.
    priceCache.__setPricesForTest(buildPriceMap(0))

    process.stdout.write(
      `Index built in ${indexMs.toFixed(0)}ms — ` +
      `${summary.trades} trades, ${summary.accounts} accounts, ${summary.pending} pending\n`
    )
    process.stdout.write(`Replaying ${TICK_COUNT} ticks (${MOVED_PER_TICK} instruments moved each)...\n`)

    const results = await replay()

    printTable([results.tick, results.engineReported, results.eventLoopLag])

    if (results.totalClosures > 0) {
      process.stdout.write(
        `\nWARNING: ${results.totalClosures} closures fired during the replay, so the timings above include\n` +
        'DB write time and are NOT a clean measurement of the scan. Seeded thresholds are set out of\n' +
        'reach, so this means something else acted on these rows — ' +
        (contended
          ? 'almost certainly the concurrently running backend flagged above.\n'
          : 'check for other writers on this database.\n')
      )
    }

    process.stdout.write(`
Trades indexed        ${tradeIndex.getTradeCount()}
Accounts indexed      ${tradeIndex.getAccountCount()}
Index build           ${indexMs.toFixed(0)} ms
Avg trades scanned    ${results.avgScannedPerTick} per tick  (vs ${tradeIndex.getTradeCount()} without the instrument index)
Closures triggered    ${results.totalClosures}
RSS                   ${results.rssStartMb} MB -> ${results.rssEndMb} MB  (growth ${results.rssGrowthMb} MB)

Read p99 on the tick row: that is the worst-case delay added to a stop-loss.
Above ~20ms at your target trade count means the main-thread assumption no
longer holds and the worker-thread design should be revisited.
`)
  } finally {
    logger.level = originalLevel
    if (seeded && !args.keep) {
      await teardown().catch((error) => {
        process.stderr.write(`Teardown failed — clean up manually with challenge_model_slug = '${RUN_ID}': ${error.message}\n`)
      })
    } else if (args.keep) {
      process.stdout.write(`\nData left in place. Remove it with: DELETE FROM accounts WHERE challenge_model_slug = '${RUN_ID}';\n`)
    }
    await pool.end()
  }
}

main().catch((error) => {
  process.stderr.write(`\nLoad test failed: ${error.message}\n${error.stack}\n`)
  process.exitCode = 1
})
