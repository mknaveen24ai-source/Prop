const pool = require('./db')
const crypto = require('crypto')
const Decimal = require('decimal.js')
const logger = require('./utils/logger')
const { calculatePnL, getLivePriceMap } = require('./routes/trades')
const { computeEntryStats } = require('./utils/competitions')
const { getTenantSettingsMap } = require('./utils/tenantSettings')
const { enqueueCompetitionPrizeVoucherEmail } = require('./utils/emailQueue')

// ─────────────────────────────────────────────────────────────────────────────
// Trading Competition Engine
//
// Runs on a scheduler tick (see services/schedulerService.js) and drives the
// competitions.status state machine: upcoming -> active -> completed.
// Competition accounts (accounts.account_type = 'competition') are already
// excluded from challengeEngine.js's phase pass/fail scan and from
// checkFloatingDrawdown's profit-target auto-pass branch — this engine owns
// their entire lifecycle instead.
// ─────────────────────────────────────────────────────────────────────────────

async function activateDueCompetitions() {
  const result = await pool.query(
    `UPDATE competitions
        SET status = 'active', updated_at = NOW()
      WHERE status = 'upcoming' AND start_at <= NOW()
      RETURNING id, title`
  )
  for (const row of result.rows) {
    logger.info(`Competition engine: "${row.title}" (#${row.id}) is now ACTIVE`)
  }
}

// Entries whose account got auto-failed (drawdown/daily-loss breach) by
// checkFloatingDrawdown's generic autoCloseAndFail() should be marked
// disqualified on the competition side too.
async function disqualifyBreachedEntries() {
  const result = await pool.query(
    `UPDATE competition_entries ce
        SET status = 'disqualified',
            disqualified_reason = COALESCE(ce.disqualified_reason, 'Account failed a risk-rule breach'),
            updated_at = NOW()
       FROM accounts a
      WHERE ce.account_id = a.id
        AND a.account_type = 'competition'
        AND a.status = 'failed'
        AND ce.status = 'active'
      RETURNING ce.id, ce.competition_id`
  )
  for (const row of result.rows) {
    logger.info(`Competition engine: entry ${row.id} disqualified (account breach) in competition #${row.competition_id}`)
  }
}

// Force-closes every open trade on one competition account inside a single
// transaction, mirroring trades.js's autoCloseAndFail/autoCloseAndPass
// locked-close pattern, then freezes the account.
async function closeAndFreezeAccount(accountId, priceMap) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const lockResult = await client.query(
      `SELECT id, status FROM accounts WHERE id = $1 AND status = 'active' FOR UPDATE SKIP LOCKED`,
      [accountId]
    )
    if (lockResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return
    }

    const openTrades = await client.query(
      `SELECT id, instrument, direction, lot_size, open_price, commission
         FROM trades WHERE account_id = $1 AND status = 'open' FOR UPDATE`,
      [accountId]
    )

    let totalPnlDec = new Decimal(0)
    for (const trade of openTrades.rows) {
      const priceData = priceMap[trade.instrument]
      const close_price = priceData
        ? parseFloat(trade.direction === 'buy' ? priceData.bid : priceData.ask)
        : parseFloat(trade.open_price)
      const demo_pnl = priceData
        ? calculatePnL(trade.direction, parseFloat(trade.open_price), close_price, parseFloat(trade.lot_size), trade.instrument, parseFloat(trade.commission || 0))
        : 0
      totalPnlDec = totalPnlDec.plus(demo_pnl)

      await client.query(
        `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(), demo_pnl = $2, close_reason = 'Competition Ended'
         WHERE id = $3`,
        [close_price, demo_pnl, trade.id]
      )
    }

    const totalPnl = totalPnlDec.toDecimalPlaces(2).toNumber()
    if (totalPnl !== 0) {
      await client.query(
        `UPDATE accounts SET current_balance = current_balance + $1, peak_balance = GREATEST(peak_balance, current_balance + $1)
         WHERE id = $2`,
        [totalPnl, accountId]
      )
    }

    await client.query(
      `UPDATE trades SET status = 'cancelled', close_time = NOW(), close_reason = 'Competition Ended'
       WHERE account_id = $1 AND status = 'pending'`,
      [accountId]
    )

    await client.query(`UPDATE accounts SET status = 'closed', updated_at = NOW() WHERE id = $1`, [accountId])

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    logger.error(`Competition engine: failed to close account ${accountId}`, { error: err.message })
  } finally {
    client.release()
  }
}

// Re-reads current_balance/starting_balance for a competition's rankable
// entries (active — pre-finalization — or completed — a correction after
// finalization), sorts by the competition's ranking_metric, and writes
// final_rank/final_profit_pct/final_profit_usd. Shared by finalizeCompetition
// (first-time ranking, with per-entry trade stats) and admin cheat-correction
// (re-rank only, no stats recompute — no trades changed, only a balance
// adjustment did).
async function computeAndPersistRanking(db, competition, { computeStats = false } = {}) {
  const entriesResult = await db.query(
    `SELECT ce.id, ce.account_id, a.current_balance, a.starting_balance
       FROM competition_entries ce
       JOIN accounts a ON a.id = ce.account_id
      WHERE ce.competition_id = $1 AND ce.status IN ('active', 'completed')`,
    [competition.id]
  )

  const ranked = []
  for (const entry of entriesResult.rows) {
    const startingBalance = parseFloat(entry.starting_balance || 0)
    const currentBalance = parseFloat(entry.current_balance || 0)
    const profitUsd = Math.round((currentBalance - startingBalance) * 100) / 100
    const profitPct = startingBalance > 0 ? Math.round(((currentBalance - startingBalance) / startingBalance) * 10000) / 100 : 0
    const stats = computeStats
      ? await computeEntryStats(db, entry.account_id, competition.start_at, competition.end_at)
      : null
    ranked.push({ entryId: entry.id, profitUsd, profitPct, stats })
  }

  const rankingMetric = competition.ranking_metric === 'profit_usd' ? 'profitUsd' : 'profitPct'
  ranked.sort((a, b) => {
    if (b[rankingMetric] !== a[rankingMetric]) return b[rankingMetric] - a[rankingMetric]
    return b.profitUsd - a.profitUsd
  })

  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i]
    const rank = i + 1
    if (computeStats) {
      await db.query(
        `UPDATE competition_entries
            SET status = 'completed', final_rank = $1, final_profit_pct = $2, final_profit_usd = $3,
                final_stats_json = $4::jsonb, updated_at = NOW()
          WHERE id = $5`,
        [rank, entry.profitPct, entry.profitUsd, JSON.stringify(entry.stats), entry.entryId]
      )
    } else {
      await db.query(
        `UPDATE competition_entries
            SET final_rank = $1, final_profit_pct = $2, final_profit_usd = $3, updated_at = NOW()
          WHERE id = $4`,
        [rank, entry.profitPct, entry.profitUsd, entry.entryId]
      )
    }
    ranked[i].rank = rank
  }

  return ranked
}

function generateVoucherCode() {
  return `WIN-${crypto.randomBytes(5).toString('hex').toUpperCase()}`
}

// Issues a competition_prize_vouchers row to each ranked entry whose matching
// prize_pool_json slot (by rank) carries a structured `voucher` field —
// alongside the pre-existing free-text `label` used for display only. One
// voucher per entry per competition (idempotent against re-running finalize).
async function issueCompetitionPrizeVouchers(competition) {
  const prizePool = Array.isArray(competition.prize_pool_json) ? competition.prize_pool_json : []
  const voucherByRank = new Map()
  for (const prize of prizePool) {
    if (prize && prize.voucher && Number.isFinite(Number(prize.rank))) {
      voucherByRank.set(Number(prize.rank), prize.voucher)
    }
  }
  if (voucherByRank.size === 0) return

  const settings = await getTenantSettingsMap(['competition_voucher_expiry_days'])
  const expiryDays = Math.max(1, parseInt(settings.competition_voucher_expiry_days, 10) || 90)

  const winnersResult = await pool.query(
    `SELECT ce.id AS entry_id, ce.final_rank, ce.user_id, u.email, u.full_name
       FROM competition_entries ce
       JOIN users u ON u.id = ce.user_id
      WHERE ce.competition_id = $1 AND ce.status = 'completed' AND ce.final_rank IS NOT NULL`,
    [competition.id]
  )

  for (const winner of winnersResult.rows) {
    const voucherSpec = voucherByRank.get(Number(winner.final_rank))
    if (!voucherSpec) continue

    const accountSize = parseFloat(voucherSpec.account_size)
    const challengeModelSlug = String(voucherSpec.challenge_model_slug || '').trim()
    if (!Number.isFinite(accountSize) || accountSize <= 0 || !challengeModelSlug) {
      logger.warn(`Competition engine: skipping malformed voucher spec for rank ${winner.final_rank} in competition #${competition.id}`)
      continue
    }

    const existing = await pool.query(
      `SELECT id FROM competition_prize_vouchers WHERE competition_entry_id = $1`,
      [winner.entry_id]
    )
    if (existing.rows.length > 0) continue

    let voucher = null
    for (let attempt = 0; attempt < 5 && !voucher; attempt++) {
      try {
        const insertResult = await pool.query(
          `INSERT INTO competition_prize_vouchers
             (code, competition_id, competition_entry_id, user_id, account_size, challenge_model_slug, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval)
           RETURNING *`,
          [generateVoucherCode(), competition.id, winner.entry_id, winner.user_id, accountSize, challengeModelSlug, expiryDays]
        )
        voucher = insertResult.rows[0]
      } catch (err) {
        if (err.code !== '23505') throw err // unique code collision — retry with a new code
      }
    }
    if (!voucher) {
      logger.error(`Competition engine: failed to generate a unique voucher code for entry ${winner.entry_id} after 5 attempts`)
      continue
    }

    logger.info(`Competition engine: issued voucher ${voucher.code} to user ${winner.user_id} for rank ${winner.final_rank} in competition #${competition.id}`)

    if (winner.email) {
      try {
        await enqueueCompetitionPrizeVoucherEmail(winner.email, winner.full_name, competition.title, voucher.code, accountSize, voucher.expires_at, { userId: winner.user_id })
      } catch (emailErr) {
        logger.warn('Competition engine: failed to enqueue prize voucher email:', { error: emailErr.message })
      }
    }
  }
}

async function finalizeCompetition(competition, io) {
  const priceMap = await getLivePriceMap().catch(() => ({}))

  const entriesResult = await pool.query(
    `SELECT ce.id, ce.account_id FROM competition_entries ce WHERE ce.competition_id = $1 AND ce.status = 'active'`,
    [competition.id]
  )

  for (const entry of entriesResult.rows) {
    await closeAndFreezeAccount(entry.account_id, priceMap)
  }

  const ranked = await computeAndPersistRanking(pool, competition, { computeStats: true })

  await pool.query(`UPDATE competitions SET status = 'completed', updated_at = NOW() WHERE id = $1`, [competition.id])

  try {
    await issueCompetitionPrizeVouchers(competition)
  } catch (err) {
    logger.error(`Competition engine: prize voucher issuance failed for competition #${competition.id}:`, { error: err.message })
  }

  logger.info(`Competition engine: "${competition.title}" (#${competition.id}) COMPLETED — ${ranked.length} entries ranked`)

  if (io) {
    io.emit('competition_ended', { competition_id: competition.id, slug: competition.slug })
  }
}

async function closeDueCompetitions(io) {
  const dueResult = await pool.query(
    `SELECT * FROM competitions WHERE status = 'active' AND end_at <= NOW()`
  )
  for (const competition of dueResult.rows) {
    await finalizeCompetition(competition, io)
  }
}

async function runCompetitionEngine(io) {
  try {
    await activateDueCompetitions()
    await disqualifyBreachedEntries()
    await closeDueCompetitions(io)
  } catch (err) {
    logger.error('Competition engine tick failed:', { error: err.message })
  }
}

module.exports = { runCompetitionEngine, computeAndPersistRanking }
