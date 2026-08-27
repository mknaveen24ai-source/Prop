// Daily analytics rollup refresh (migration 039).
//
// The intelligence pages ask a lot of cohort, survival, percentile and
// benchmarking questions. Answering those from `trades` directly would mean
// full scans of the hottest table in the product on every tab load, competing
// with the live trading engine for the same pages.
//
// So three daily-grain tables are maintained here and every query that does not
// need trade-level detail reads them instead.
//
// The refresh is a DELETE + INSERT over a trailing window, not an incremental
// merge. That choice is deliberate:
//
//   - a missed run self-heals on the next one, so there is no catch-up path to
//     get wrong and no "last successful run" state to store;
//   - late-arriving corrections (an admin balance adjustment backdated, a trade
//     closed against a corrected price) are picked up automatically;
//   - the job is safe to run twice concurrently in the sense that the result is
//     identical either way, and the advisory lock below stops it happening.
//
// The window is intentionally wider than one day for the same reason.

const pool = require('../../db')
const logger = require('../../utils/logger')

const DEFAULT_LOOKBACK_DAYS = 7
const ADVISORY_LOCK_KEY = 8412771 // arbitrary, must be unique across the app's pg_advisory_lock users

async function refreshAccountDailyStats (client, lookbackDays) {
  await client.query(
    `DELETE FROM account_daily_stats
      WHERE trading_date >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))::date`,
    [lookbackDays]
  )

  // Grain is the UTC calendar day a trade CLOSED on. Open trades are excluded
  // entirely — an unrealised position is not a day's result, and including it
  // would make yesterday's row change every tick.
  await client.query(
    `INSERT INTO account_daily_stats (
       account_id, trading_date, trades_closed, wins, losses,
       gross_win, gross_loss, net_pnl, broker_pnl, commission,
       volume_lots, avg_hold_mins, max_trade_pnl, min_trade_pnl, refreshed_at
     )
     SELECT
       t.account_id,
       (t.close_time AT TIME ZONE 'UTC')::date            AS trading_date,
       COUNT(*)::int                                       AS trades_closed,
       COUNT(*) FILTER (WHERE t.demo_pnl > 0)::int         AS wins,
       COUNT(*) FILTER (WHERE t.demo_pnl < 0)::int         AS losses,
       COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0), 0)  AS gross_win,
       COALESCE(SUM(-t.demo_pnl) FILTER (WHERE t.demo_pnl < 0), 0) AS gross_loss,
       COALESCE(SUM(t.demo_pnl), 0)                        AS net_pnl,
       COALESCE(SUM(t.broker_pnl), 0)                      AS broker_pnl,
       COALESCE(SUM(t.commission), 0)                      AS commission,
       COALESCE(SUM(t.lot_size), 0)                        AS volume_lots,
       ROUND(AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)) / 60.0)::numeric, 2) AS avg_hold_mins,
       MAX(t.demo_pnl)                                     AS max_trade_pnl,
       MIN(t.demo_pnl)                                     AS min_trade_pnl,
       NOW()
     FROM trades t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.status = 'closed'
       AND t.close_time IS NOT NULL
       AND t.close_time >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))
     GROUP BY t.account_id, (t.close_time AT TIME ZONE 'UTC')::date`,
    [lookbackDays]
  )
}

async function refreshTradeDailyStats (client, lookbackDays) {
  await client.query(
    `DELETE FROM trade_daily_stats
      WHERE trading_date >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))::date`,
    [lookbackDays]
  )

  await client.query(
    `INSERT INTO trade_daily_stats (
       trading_date, instrument, direction, trades_closed, wins,
       net_pnl, broker_pnl, volume_lots, commission,
       avg_hold_mins, avg_slippage_pips, refreshed_at
     )
     SELECT
       (t.close_time AT TIME ZONE 'UTC')::date              AS trading_date,
       t.instrument,
       UPPER(t.direction)                                   AS direction,
       COUNT(*)::int                                        AS trades_closed,
       COUNT(*) FILTER (WHERE t.demo_pnl > 0)::int          AS wins,
       COALESCE(SUM(t.demo_pnl), 0)                         AS net_pnl,
       COALESCE(SUM(t.broker_pnl), 0)                       AS broker_pnl,
       COALESCE(SUM(t.lot_size), 0)                         AS volume_lots,
       COALESCE(SUM(t.commission), 0)                       AS commission,
       ROUND(AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)) / 60.0)::numeric, 2) AS avg_hold_mins,
       ROUND(AVG(NULLIF(t.slippage_pips, 0))::numeric, 3)   AS avg_slippage_pips,
       NOW()
     FROM trades t
     WHERE t.status = 'closed'
       AND t.close_time IS NOT NULL
       AND t.close_time >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))
     GROUP BY 1, 2, 3`,
    [lookbackDays]
  )
}

async function refreshRevenueDaily (client, lookbackDays) {
  await client.query(
    `DELETE FROM revenue_daily
      WHERE revenue_date >= (CURRENT_DATE - ($1::int * INTERVAL '1 day'))::date`,
    [lookbackDays]
  )

  // One row per day, assembled from four independent sources. A FULL OUTER JOIN
  // chain rather than a driving calendar table: a day with payouts but no sales
  // must still produce a row, and so must the reverse.
  await client.query(
    `WITH bounds AS (
       SELECT (CURRENT_DATE - ($1::int * INTERVAL '1 day'))::date AS start_date
     ),
     orders AS (
       SELECT (o.paid_at AT TIME ZONE 'UTC')::date AS d,
              COUNT(*)::int                        AS orders_paid,
              COALESCE(SUM(o.amount), 0)           AS gross_revenue
         FROM challenge_orders o, bounds b
        WHERE o.status = 'paid'
          AND o.paid_at IS NOT NULL
          AND o.paid_at >= b.start_date
        GROUP BY 1
     ),
     discounts AS (
       SELECT (r.redeemed_at AT TIME ZONE 'UTC')::date AS d,
              COALESCE(SUM(r.discount_amount), 0)      AS discount_total
         FROM coupon_redemptions r, bounds b
        WHERE r.redeemed_at >= b.start_date
        GROUP BY 1
     ),
     commissions AS (
       SELECT (c.earned_at AT TIME ZONE 'UTC')::date AS d,
              COALESCE(SUM(c.commission_amount), 0)   AS affiliate_commission
         FROM affiliate_commissions c, bounds b
        WHERE c.earned_at >= b.start_date
        GROUP BY 1
     ),
     paid_out AS (
       SELECT (p.paid_at AT TIME ZONE 'UTC')::date AS d,
              COALESCE(SUM(p.amount_payable), 0)    AS payouts_paid,
              COUNT(*)::int                         AS payouts_count
         FROM payouts p, bounds b
        WHERE p.status = 'paid'
          AND p.paid_at IS NOT NULL
          AND p.paid_at >= b.start_date
        GROUP BY 1
     ),
     buyers AS (
       SELECT d,
              COUNT(*) FILTER (WHERE prior_orders = 0)::int AS new_buyers,
              COUNT(*) FILTER (WHERE prior_orders > 0)::int AS returning_buyers
         FROM (
           SELECT (o.paid_at AT TIME ZONE 'UTC')::date AS d,
                  o.user_id,
                  (SELECT COUNT(*) FROM challenge_orders p
                    WHERE p.user_id = o.user_id
                      AND p.status = 'paid'
                      AND p.paid_at < o.paid_at)::int AS prior_orders
             FROM challenge_orders o, bounds b
            WHERE o.status = 'paid'
              AND o.paid_at IS NOT NULL
              AND o.paid_at >= b.start_date
         ) first_seen
        GROUP BY d
     ),
     signups AS (
       SELECT (u.created_at AT TIME ZONE 'UTC')::date AS d, COUNT(*)::int AS signups
         FROM users u, bounds b
        WHERE u.created_at >= b.start_date
          AND u.is_bot = false
        GROUP BY 1
     ),
     all_days AS (
       SELECT d FROM orders
       UNION SELECT d FROM discounts
       UNION SELECT d FROM commissions
       UNION SELECT d FROM paid_out
       UNION SELECT d FROM signups
     )
     INSERT INTO revenue_daily (
       revenue_date, orders_paid, gross_revenue, discount_total,
       affiliate_commission, payouts_paid, payouts_count,
       new_buyers, returning_buyers, signups, refreshed_at
     )
     SELECT
       ad.d,
       COALESCE(o.orders_paid, 0),
       COALESCE(o.gross_revenue, 0),
       COALESCE(dc.discount_total, 0),
       COALESCE(cm.affiliate_commission, 0),
       COALESCE(po.payouts_paid, 0),
       COALESCE(po.payouts_count, 0),
       COALESCE(bu.new_buyers, 0),
       COALESCE(bu.returning_buyers, 0),
       COALESCE(sg.signups, 0),
       NOW()
     FROM all_days ad
     LEFT JOIN orders      o  ON o.d  = ad.d
     LEFT JOIN discounts   dc ON dc.d = ad.d
     LEFT JOIN commissions cm ON cm.d = ad.d
     LEFT JOIN paid_out    po ON po.d = ad.d
     LEFT JOIN buyers      bu ON bu.d = ad.d
     LEFT JOIN signups     sg ON sg.d = ad.d`,
    [lookbackDays]
  )
}

// Full historical rebuild — used by the backfill script and by tests that need
// a populated rollup from a freshly seeded database. Same code path as the
// incremental refresh, just with an unbounded window.
async function refreshAnalyticsRollups ({ lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const client = await pool.connect()
  const started = Date.now()

  try {
    // Non-blocking: if another instance already holds the lock this run is a
    // no-op rather than a queued duplicate. The next interval will catch up.
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [ADVISORY_LOCK_KEY])
    if (!lock.rows[0]?.acquired) {
      logger.debug('[analytics:rollups] skipped — another instance holds the lock')
      return { skipped: true }
    }

    try {
      await client.query('BEGIN')
      await refreshAccountDailyStats(client, lookbackDays)
      await refreshTradeDailyStats(client, lookbackDays)
      await refreshRevenueDaily(client, lookbackDays)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {})
    }

    const durationMs = Date.now() - started
    logger.info('[analytics:rollups] refreshed', { lookbackDays, durationMs })
    return { skipped: false, lookbackDays, durationMs }
  } finally {
    client.release()
  }
}

module.exports = {
  refreshAnalyticsRollups,
  DEFAULT_LOOKBACK_DAYS,
  ADVISORY_LOCK_KEY,
  // exported for targeted tests
  _internals: { refreshAccountDailyStats, refreshTradeDailyStats, refreshRevenueDaily }
}
