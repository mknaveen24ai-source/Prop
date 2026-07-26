const pool = require('../db')

// Derives everything from the `trades` table directly (which already records
// close_time/demo_pnl on every close path) rather than maintaining a separate
// synced fact table — avoids having to hook into every trade-close call site.

function utcDayStart(date = new Date()) {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

async function getTodayRealizedPnl(db, accountIds) {
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds]
  if (ids.length === 0) return new Map()
  const todayStart = utcDayStart()
  const result = await db.query(
    `SELECT account_id, COALESCE(SUM(demo_pnl), 0) AS realized_pnl
       FROM trades
      WHERE account_id = ANY($1::uuid[])
        AND status = 'closed'
        AND close_time >= $2
      GROUP BY account_id`,
    [ids, todayStart.toISOString()]
  )
  const map = new Map()
  for (const row of result.rows) {
    map.set(row.account_id, parseFloat(row.realized_pnl))
  }
  return map
}

async function countTradingDays(db, accountId) {
  const result = await db.query(
    `SELECT COUNT(DISTINCT DATE(close_time AT TIME ZONE 'UTC')) AS days
       FROM trades
      WHERE account_id = $1 AND status = 'closed'`,
    [accountId]
  )
  return parseInt(result.rows[0]?.days || 0, 10)
}

async function getBestDayProfit(db, accountId) {
  const result = await db.query(
    `SELECT COALESCE(MAX(day_pnl), 0) AS best_day
       FROM (
         SELECT DATE(close_time AT TIME ZONE 'UTC') AS trading_day, SUM(demo_pnl) AS day_pnl
           FROM trades
          WHERE account_id = $1 AND status = 'closed'
          GROUP BY DATE(close_time AT TIME ZONE 'UTC')
       ) daily
      WHERE day_pnl > 0`,
    [accountId]
  )
  return parseFloat(result.rows[0]?.best_day || 0)
}

// Consistency rule: no single trading day's profit may exceed `consistencyPct`%
// of total realized profit. Returns { ok, bestDayProfit, totalProfit, bestDayPct }.
async function checkConsistencyRule(db, accountId, totalProfit, consistencyPct) {
  if (!Number.isFinite(consistencyPct) || consistencyPct <= 0 || totalProfit <= 0) {
    return { ok: true, bestDayProfit: 0, totalProfit, bestDayPct: 0 }
  }
  const bestDayProfit = await getBestDayProfit(db, accountId)
  const bestDayPct = (bestDayProfit / totalProfit) * 100
  return {
    ok: bestDayPct <= consistencyPct,
    bestDayProfit,
    totalProfit,
    bestDayPct
  }
}

module.exports = {
  utcDayStart,
  getTodayRealizedPnl,
  countTradingDays,
  getBestDayProfit,
  checkConsistencyRule
}
