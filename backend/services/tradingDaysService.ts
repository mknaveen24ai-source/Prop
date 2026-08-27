import type { Pool, PoolClient, QueryResultRow } from 'pg'

// Derives everything from the `trades` table directly (which already records
// close_time/demo_pnl on every close path) rather than maintaining a separate
// synced fact table — avoids having to hook into every trade-close call site.

type Queryable = Pick<Pool | PoolClient, 'query'>

interface RealizedPnlRow extends QueryResultRow {
  account_id: string
  realized_pnl: string
}

interface CountRow extends QueryResultRow {
  days: string
}

interface BestDayRow extends QueryResultRow {
  best_day: string
}

interface ConsistencyResult {
  ok: boolean
  bestDayProfit: number
  totalProfit: number
  bestDayPct: number
}

function utcDayStart(date: Date = new Date()): Date {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d
}

async function getTodayRealizedPnl(
  db: Queryable,
  accountIds: string | readonly string[]
): Promise<Map<string, number>> {
  const ids = Array.isArray(accountIds) ? accountIds : [accountIds]
  if (ids.length === 0) return new Map()
  const todayStart = utcDayStart()
  const result = await db.query<RealizedPnlRow>(
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

async function countTradingDays(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query<CountRow>(
    `SELECT COUNT(DISTINCT DATE(close_time AT TIME ZONE 'UTC')) AS days
       FROM trades
      WHERE account_id = $1 AND status = 'closed'`,
    [accountId]
  )
  return parseInt(String(result.rows[0]?.days || 0), 10)
}

// Counts only days whose net P&L reached `minDailyProfitPct`% of starting
// balance — days that don't clear the bar don't count toward min_trading_days.
async function countQualifyingTradingDays(
  db: Queryable,
  accountId: string,
  startingBalance: string | number,
  minDailyProfitPct: string | number
): Promise<number> {
  const balance = parseFloat(String(startingBalance))
  const threshold = parseFloat(String(minDailyProfitPct))
  if (!(balance > 0) || !Number.isFinite(threshold) || threshold <= 0) {
    return countTradingDays(db, accountId)
  }
  const result = await db.query<CountRow>(
    `SELECT COUNT(*) AS days
       FROM (
         SELECT DATE(close_time AT TIME ZONE 'UTC') AS trading_day, SUM(demo_pnl) AS day_pnl
           FROM trades
          WHERE account_id = $1 AND status = 'closed'
          GROUP BY DATE(close_time AT TIME ZONE 'UTC')
       ) daily
      WHERE (day_pnl / $2::numeric) * 100 >= $3`,
    [accountId, balance, threshold]
  )
  return parseInt(String(result.rows[0]?.days || 0), 10)
}

async function getBestDayProfit(db: Queryable, accountId: string): Promise<number> {
  const result = await db.query<BestDayRow>(
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
  return parseFloat(String(result.rows[0]?.best_day || 0))
}

// Consistency rule: no single trading day's profit may exceed `consistencyPct`%
// of total realized profit. Returns { ok, bestDayProfit, totalProfit, bestDayPct }.
async function checkConsistencyRule(
  db: Queryable,
  accountId: string,
  totalProfit: number,
  consistencyPct: number
): Promise<ConsistencyResult> {
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

const tradingDaysService = {
  utcDayStart,
  getTodayRealizedPnl,
  countTradingDays,
  countQualifyingTradingDays,
  getBestDayProfit,
  checkConsistencyRule
}

export = tradingDaysService
