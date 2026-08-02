const pool = require('../db')
const { v4: uuidv4 } = require('uuid')

// Generalizes tradingDaysService.getTodayRealizedPnl's batch-by-account-ids
// pattern, swapping its "today" window for an arbitrary [startAt, endAt).
async function computeEntryStats(db, accountId, startAt, endAt) {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'closed')::int AS total_trades,
       COUNT(*) FILTER (WHERE status = 'closed' AND demo_pnl > 0)::int AS winning_trades,
       COALESCE(SUM(demo_pnl) FILTER (WHERE status = 'closed'), 0) AS realized_pnl
     FROM trades
     WHERE account_id = $1
       AND close_time >= $2
       AND close_time <= $3`,
    [accountId, startAt, endAt]
  )
  const row = result.rows[0] || {}
  const totalTrades = parseInt(row.total_trades || 0, 10)
  const winningTrades = parseInt(row.winning_trades || 0, 10)
  return {
    total_trades: totalTrades,
    winning_trades: winningTrades,
    win_rate: totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 1000) / 10 : 0,
    realized_pnl: parseFloat(row.realized_pnl || 0)
  }
}

async function fetchCompetitionBySlugOrId(idOrSlug) {
  const isNumeric = /^\d+$/.test(String(idOrSlug))
  const result = await pool.query(
    isNumeric
      ? `SELECT * FROM competitions WHERE id = $1`
      : `SELECT * FROM competitions WHERE slug = $1`,
    [idOrSlug]
  )
  return result.rows[0] || null
}

// Live-computed ranking of a competition's entries by current account P&L —
// mirrors the shape of server.js's fetchLeaderboardRows(), scoped to one
// competition instead of all funded accounts.
async function fetchCompetitionLeaderboard(competitionId, { limit = 100 } = {}) {
  const result = await pool.query(
    `SELECT
       ce.id AS entry_id, ce.user_id, ce.status, ce.final_rank,
       u.full_name, u.country, u.trader_uid, u.is_bot,
       a.account_uid, a.current_balance, a.starting_balance,
       COALESCE(ce.final_profit_usd,
         ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2)
       ) AS profit_usd,
       COALESCE(ce.final_profit_pct,
         ROUND(
           CASE WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
             ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
           END::numeric, 2
         )
       ) AS profit_pct
     FROM competition_entries ce
     JOIN users u ON u.id = ce.user_id
     LEFT JOIN accounts a ON a.id = ce.account_id
     WHERE ce.competition_id = $1
       AND ce.status IN ('active', 'completed')
       AND COALESCE(u.is_banned, FALSE) = FALSE
     ORDER BY
       CASE WHEN ce.final_rank IS NOT NULL THEN ce.final_rank ELSE 999999 END ASC,
       profit_pct DESC, profit_usd DESC, ce.joined_at ASC
     LIMIT $2`,
    [competitionId, limit]
  )
  return result.rows.map((row, index) => ({
    ...row,
    rank: row.final_rank || index + 1,
    profit_pct: parseFloat(row.profit_pct || 0),
    profit_usd: parseFloat(row.profit_usd || 0)
  }))
}

// Per-participant trade-performance breakdown for the admin analytics page —
// one batched GROUP BY query across every entry's account instead of N
// separate calls. Field names mirror trades.js's single-account
// GET /api/trades/analytics route for consistency.
async function computeCompetitionAnalytics(competitionId) {
  const competition = await fetchCompetitionBySlugOrId(competitionId)
  if (!competition) return null

  const entriesResult = await pool.query(
    `SELECT ce.id AS entry_id, ce.account_id, ce.status, u.full_name, u.email
       FROM competition_entries ce
       JOIN users u ON u.id = ce.user_id
      WHERE ce.competition_id = $1
      ORDER BY ce.joined_at ASC`,
    [competitionId]
  )
  const accountIds = entriesResult.rows.map((r) => r.account_id).filter(Boolean)

  const statsByAccount = new Map()
  if (accountIds.length > 0) {
    const statsResult = await pool.query(
      `SELECT
         account_id,
         COUNT(*)::int AS total_trades,
         COUNT(*) FILTER (WHERE demo_pnl > 0)::int AS winning_trades,
         COUNT(*) FILTER (WHERE demo_pnl < 0)::int AS losing_trades,
         COALESCE(SUM(demo_pnl), 0) AS realized_pnl,
         COALESCE(SUM(demo_pnl) FILTER (WHERE demo_pnl > 0), 0) AS gross_profit,
         COALESCE(SUM(ABS(demo_pnl)) FILTER (WHERE demo_pnl < 0), 0) AS gross_loss,
         COALESCE(MAX(demo_pnl), 0) AS best_trade,
         COALESCE(MIN(demo_pnl), 0) AS worst_trade
       FROM trades
       WHERE account_id = ANY($1::uuid[])
         AND status = 'closed'
         AND close_time >= $2
         AND close_time <= $3
       GROUP BY account_id`,
      [accountIds, competition.start_at, competition.end_at]
    )
    for (const row of statsResult.rows) {
      statsByAccount.set(row.account_id, row)
    }
  }

  const entries = entriesResult.rows.map((entry) => {
    const s = statsByAccount.get(entry.account_id)
    const totalTrades = s ? parseInt(s.total_trades, 10) : 0
    const winningTrades = s ? parseInt(s.winning_trades, 10) : 0
    const losingTrades = s ? parseInt(s.losing_trades, 10) : 0
    const grossProfit = s ? parseFloat(s.gross_profit) : 0
    const grossLoss = s ? parseFloat(s.gross_loss) : 0
    return {
      entry_id: entry.entry_id,
      account_id: entry.account_id,
      status: entry.status,
      full_name: entry.full_name,
      email: entry.email,
      total_trades: totalTrades,
      winning_trades: winningTrades,
      losing_trades: losingTrades,
      win_rate: totalTrades > 0 ? Math.round((winningTrades / totalTrades) * 1000) / 10 : 0,
      realized_pnl: s ? parseFloat(s.realized_pnl) : 0,
      avg_win: winningTrades > 0 ? Math.round((grossProfit / winningTrades) * 100) / 100 : 0,
      avg_loss: losingTrades > 0 ? Math.round((grossLoss / losingTrades) * 100) / 100 : 0,
      profit_factor: grossLoss > 0 ? Math.round((grossProfit / grossLoss) * 100) / 100 : (grossProfit > 0 ? 999 : 0),
      best_trade: s ? parseFloat(s.best_trade) : 0,
      worst_trade: s ? parseFloat(s.worst_trade) : 0
    }
  })

  const totalTrades = entries.reduce((sum, e) => sum + e.total_trades, 0)
  const totalWinning = entries.reduce((sum, e) => sum + e.winning_trades, 0)
  const totalRealizedPnl = Math.round(entries.reduce((sum, e) => sum + e.realized_pnl, 0) * 100) / 100
  const mostActive = entries.reduce((top, e) => (e.total_trades > (top?.total_trades || 0) ? e : top), null)

  const summary = {
    participant_count: entries.length,
    total_trades: totalTrades,
    overall_win_rate: totalTrades > 0 ? Math.round((totalWinning / totalTrades) * 1000) / 10 : 0,
    total_realized_pnl: totalRealizedPnl,
    most_active_trader: mostActive && mostActive.total_trades > 0 ? mostActive.full_name : null
  }

  return { summary, entries }
}

// Advisory-locks per (user, competition), checks for an existing entry and
// the max_participants cap, then creates the dedicated competition `accounts`
// row + `competition_entries` row. Shared by the public join route and the
// admin bot-entry endpoint so both go through identical account-provisioning
// logic. Caller must already be inside an open transaction on `client` and
// is responsible for any pre-checks specific to its own caller (e.g. the
// public route's KYC-approval check — bots are pre-approved at creation so
// need no such check).
async function createCompetitionEntry(client, competition, userId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2)`, [String(userId), competition.id])

  const existingResult = await client.query(
    `SELECT id FROM competition_entries WHERE competition_id = $1 AND user_id = $2`,
    [competition.id, userId]
  )
  if (existingResult.rows.length > 0) {
    throw Object.assign(new Error('You have already joined this competition.'), { statusCode: 409 })
  }

  if (competition.max_participants) {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM competition_entries WHERE competition_id = $1 AND status IN ('active', 'completed')`,
      [competition.id]
    )
    if (countResult.rows[0].count >= competition.max_participants) {
      throw Object.assign(new Error('This competition is full.'), { statusCode: 403 })
    }
  }

  const startingBalance = parseFloat(competition.starting_balance)
  const account_uid = uuidv4()

  const accountResult = await client.query(
    `INSERT INTO accounts
       (user_id, account_type, account_size, current_balance, starting_balance, peak_balance,
        profit_target, max_drawdown_pct, daily_drawdown_pct, status, phase_start_date, phase_end_date, account_uid)
     VALUES ($1, 'competition', $2, $2, $2, $2, 0, $3, $4, 'active', NOW(), $5, $6)
     RETURNING id`,
    [userId, startingBalance, competition.max_drawdown_pct, competition.daily_drawdown_pct, competition.end_at, account_uid]
  )
  const accountId = accountResult.rows[0].id

  const entryResult = await client.query(
    `INSERT INTO competition_entries (competition_id, user_id, account_id, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id`,
    [competition.id, userId, accountId]
  )

  return { entryId: entryResult.rows[0].id, accountId }
}

module.exports = {
  computeEntryStats,
  computeCompetitionAnalytics,
  createCompetitionEntry,
  fetchCompetitionBySlugOrId,
  fetchCompetitionLeaderboard
}
