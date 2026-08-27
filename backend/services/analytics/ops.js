// Firm Intelligence → Ops Health tab (metrics F96–F100).
//
// Support load, dispute cost, price-feed integrity and engine health. The point
// of this tab is that operational strain shows up here BEFORE it shows up in
// revenue: a spike in "near drawdown" tickets or a diverging price source is a
// leading indicator of the disputes and chargebacks that arrive two weeks later.

const { readPool } = require('../../db')
const { num, int, round, pct, median } = require('./helpers')

// ── F96: support ticket volume and SLA ───────────────────────────────────────
async function supportLoad (range) {
  // `support_tickets` has no updated_at column, so "resolution time" is the
  // last message on a resolved/closed ticket rather than a status-change
  // timestamp the table never recorded. First response is the first ADMIN
  // message (sender_type is constrained to 'user'/'admin').
  const byCategory = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(t.category), ''), 'uncategorised') AS category,
            t.status,
            COUNT(*)::int AS tickets,
            AVG(EXTRACT(EPOCH FROM (
              (SELECT MIN(m.created_at) FROM support_ticket_messages m
                WHERE m.ticket_id = t.id AND m.sender_type = 'admin')
              - t.created_at)) / 3600.0) AS avg_first_response_hours,
            AVG(EXTRACT(EPOCH FROM (
              (SELECT MAX(m.created_at) FROM support_ticket_messages m
                WHERE m.ticket_id = t.id)
              - t.created_at)) / 3600.0)
              FILTER (WHERE t.status IN ('resolved', 'closed')) AS avg_resolution_hours,
            COUNT(*) FILTER (WHERE t.sla_due_at IS NOT NULL
                               AND t.status NOT IN ('resolved', 'closed')
                               AND t.sla_due_at < NOW())::int AS sla_breached
       FROM support_tickets t
      WHERE t.created_at BETWEEN $1 AND $2
      GROUP BY 1, 2
      ORDER BY tickets DESC`,
    [range.fromTs, range.toTs]
  )

  const daily = await readPool.query(
    `SELECT (created_at AT TIME ZONE 'UTC')::date::text AS date,
            COUNT(*)::int AS tickets
       FROM support_tickets
      WHERE created_at BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY 1`,
    [range.fromTs, range.toTs]
  )

  const grouped = new Map()
  for (const r of byCategory.rows) {
    const entry = grouped.get(r.category) || {
      category: r.category,
      tickets: 0,
      sla_breached: 0,
      by_status: {},
      first_response_samples: [],
      resolution_samples: []
    }
    const count = int(r.tickets)
    entry.tickets += count
    entry.sla_breached += int(r.sla_breached)
    entry.by_status[r.status] = count
    if (r.avg_first_response_hours !== null) entry.first_response_samples.push(num(r.avg_first_response_hours))
    if (r.avg_resolution_hours !== null) entry.resolution_samples.push(num(r.avg_resolution_hours))
    grouped.set(r.category, entry)
  }

  return {
    daily: daily.rows.map((r) => ({ date: r.date, tickets: int(r.tickets) })),
    categories: [...grouped.values()].map((e) => ({
      category: e.category,
      tickets: e.tickets,
      sla_breached: e.sla_breached,
      by_status: e.by_status,
      avg_first_response_hours: e.first_response_samples.length
        ? round(median(e.first_response_samples), 1)
        : null,
      avg_resolution_hours: e.resolution_samples.length
        ? round(median(e.resolution_samples), 1)
        : null
    })).sort((a, b) => b.tickets - a.tickets)
  }
}

// ── F97: dispute rate and cost ───────────────────────────────────────────────
async function disputes (range) {
  const [summary, failures] = await Promise.all([
    readPool.query(
      `SELECT d.status,
              COUNT(*)::int AS disputes,
              AVG(EXTRACT(EPOCH FROM (d.updated_at - d.created_at)) / 86400.0) AS avg_days_open
         FROM disputes d
        WHERE d.created_at BETWEEN $1 AND $2
        GROUP BY d.status
        ORDER BY disputes DESC`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT COUNT(*)::int AS failed_accounts
         FROM accounts
        WHERE status IN ('failed', 'expired')
          AND updated_at BETWEEN $1 AND $2`,
      [range.fromTs, range.toTs]
    )
  ])

  const total = summary.rows.reduce((s, r) => s + int(r.disputes), 0)
  const failedAccounts = int(failures.rows[0]?.failed_accounts)

  return {
    total,
    failed_accounts: failedAccounts,
    // The metric an operator actually acts on: disputes per 100 failures. Raw
    // dispute count rises with volume and says nothing on its own.
    disputes_per_100_failures: failedAccounts > 0 ? round((total / failedAccounts) * 100, 1) : null,
    statuses: summary.rows.map((r) => ({
      status: r.status,
      disputes: int(r.disputes),
      share_pct: pct(r.disputes, total),
      avg_days_open: num(r.avg_days_open, null) === null ? null : round(r.avg_days_open, 1)
    }))
  }
}

// ── F98: ticket themes against account state ─────────────────────────────────
// Joins the support queue to what the ticket-opener's accounts were actually
// doing. "Most of our tickets come from traders who just breached drawdown" is
// a different operational problem from "most come from traders awaiting KYC",
// and the raw category counts cannot tell them apart.
async function ticketContext (range) {
  const { rows } = await readPool.query(
    `WITH ticket_users AS (
       SELECT t.id, t.category, t.user_id
         FROM support_tickets t
        WHERE t.created_at BETWEEN $1 AND $2
     )
     SELECT COALESCE(NULLIF(TRIM(tu.category), ''), 'uncategorised') AS category,
            COUNT(*)::int AS tickets,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM accounts a
               WHERE a.user_id::text = tu.user_id
                 AND a.status IN ('failed', 'expired')
            ))::int AS from_failed_traders,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM accounts a
               WHERE a.user_id::text = tu.user_id
                 AND a.account_type = 'funded'
            ))::int AS from_funded_traders,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM payouts p
               WHERE p.user_id::text = tu.user_id
                 AND p.status IN ('pending', 'approved')
            ))::int AS awaiting_payout,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM users u
               WHERE u.id::text = tu.user_id
                 AND u.kyc_status = 'pending'
            ))::int AS kyc_pending
       FROM ticket_users tu
      GROUP BY 1
      ORDER BY tickets DESC
      LIMIT 25`,
    [range.fromTs, range.toTs]
  )

  return rows.map((r) => ({
    category: r.category,
    tickets: int(r.tickets),
    from_failed_traders: int(r.from_failed_traders),
    from_funded_traders: int(r.from_funded_traders),
    awaiting_payout: int(r.awaiting_payout),
    kyc_pending: int(r.kyc_pending)
  }))
}

// ── F99: price feed health ───────────────────────────────────────────────────
async function priceFeedHealth () {
  const [staleness, sources, divergence] = await Promise.all([
    readPool.query(
      `SELECT instrument,
              EXTRACT(EPOCH FROM (LOCALTIMESTAMP - updated_at)) AS stale_seconds,
              bid, ask
         FROM price_feed
        ORDER BY stale_seconds DESC NULLS LAST
        LIMIT 40`
    ),
    readPool.query(
      `SELECT s.source_key, s.source_name, s.status, s.is_shared_default,
              s.last_seen_at, s.last_error_at, s.error_message,
              COUNT(sp.instrument)::int AS instruments,
              MAX(EXTRACT(EPOCH FROM (NOW() - sp.updated_at))) AS worst_stale_seconds
         FROM price_feed_sources s
         LEFT JOIN price_feed_source_prices sp ON sp.source_key = s.source_key
        GROUP BY s.source_key, s.source_name, s.status, s.is_shared_default,
                 s.last_seen_at, s.last_error_at, s.error_message
        ORDER BY s.is_shared_default DESC, s.source_key`
    ),
    // Cross-source spread on the same instrument at the same hour. A source
    // quietly drifting from its peers is the failure mode that produces
    // "the platform stopped me out at a price that never traded" disputes.
    readPool.query(
      `WITH latest AS (
         SELECT source_key, instrument, bucket_time, close
           FROM price_feed_source_history_1h
          WHERE bucket_time >= NOW() - INTERVAL '24 hours'
       )
       SELECT instrument,
              COUNT(DISTINCT source_key)::int AS sources,
              MAX(close) - MIN(close)         AS max_spread,
              CASE WHEN MIN(close) > 0
                   THEN ((MAX(close) - MIN(close)) / MIN(close)) * 100 END AS max_spread_pct
         FROM latest
        GROUP BY instrument, bucket_time
       HAVING COUNT(DISTINCT source_key) > 1
        ORDER BY max_spread_pct DESC NULLS LAST
        LIMIT 20`
    )
  ])

  const stale = staleness.rows.map((r) => ({
    instrument: r.instrument,
    stale_seconds: num(r.stale_seconds, null) === null ? null : round(r.stale_seconds, 1),
    bid: num(r.bid, null),
    ask: num(r.ask, null),
    spread: (r.bid !== null && r.ask !== null) ? round(num(r.ask) - num(r.bid), 5) : null
  }))

  return {
    instruments: stale,
    stale_over_60s: stale.filter((s) => (s.stale_seconds ?? 0) > 60).length,
    sources: sources.rows.map((r) => ({
      source_key: r.source_key,
      source_name: r.source_name,
      status: r.status,
      is_shared_default: r.is_shared_default,
      last_seen_at: r.last_seen_at,
      last_error_at: r.last_error_at,
      error_message: r.error_message,
      instruments: int(r.instruments),
      worst_stale_seconds: num(r.worst_stale_seconds, null) === null ? null : round(r.worst_stale_seconds, 1)
    })),
    divergence: divergence.rows.map((r) => ({
      instrument: r.instrument,
      sources: int(r.sources),
      max_spread: num(r.max_spread, null),
      max_spread_pct: num(r.max_spread_pct, null) === null ? null : round(r.max_spread_pct, 4)
    }))
  }
}

// ── F100: engine health ──────────────────────────────────────────────────────
async function engineHealth (range) {
  const [emailQueue, tradeFlow, openState, idempotency] = await Promise.all([
    readPool.query(
      `SELECT status, COUNT(*)::int AS jobs,
              MAX(EXTRACT(EPOCH FROM (NOW() - scheduled_for)) / 60.0) AS oldest_wait_mins
         FROM email_jobs
        WHERE status IN ('pending', 'sending', 'retry', 'failed', 'dead')
        GROUP BY status`
    ),
    readPool.query(
      `SELECT (close_time AT TIME ZONE 'UTC')::date::text AS date,
              COUNT(*)::int AS closed,
              COUNT(*) FILTER (WHERE close_reason IS NOT NULL AND close_reason <> 'manual')::int AS system_closed
         FROM trades
        WHERE status = 'closed'
          AND close_time BETWEEN $1 AND $2
        GROUP BY 1 ORDER BY 1`,
      [range.fromTs, range.toTs]
    ),
    readPool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::int    AS open_trades,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending_orders,
              COUNT(*) FILTER (WHERE status = 'open' AND open_time < NOW() - INTERVAL '30 days')::int AS stale_open
         FROM trades`
    ),
    readPool.query(
      `SELECT status, COUNT(*)::int AS claims
         FROM idempotency_requests
        WHERE created_at >= NOW() - INTERVAL '24 hours'
        GROUP BY status`
    )
  ])

  const closeReasons = await readPool.query(
    `SELECT COALESCE(NULLIF(TRIM(close_reason), ''), 'unspecified') AS reason,
            COUNT(*)::int AS trades
       FROM trades
      WHERE status = 'closed'
        AND close_time BETWEEN $1 AND $2
      GROUP BY 1
      ORDER BY trades DESC
      LIMIT 15`,
    [range.fromTs, range.toTs]
  )

  const o = openState.rows[0] || {}

  return {
    email_queue: emailQueue.rows.map((r) => ({
      status: r.status,
      jobs: int(r.jobs),
      oldest_wait_mins: num(r.oldest_wait_mins, null) === null ? null : round(r.oldest_wait_mins, 1)
    })),
    trade_flow: tradeFlow.rows.map((r) => ({
      date: r.date,
      closed: int(r.closed),
      system_closed: int(r.system_closed),
      system_closed_pct: pct(r.system_closed, r.closed)
    })),
    open_state: {
      open_trades: int(o.open_trades),
      pending_orders: int(o.pending_orders),
      // An "open" position older than a month on an evaluation account is
      // almost always an engine or bridge fault, not a trading decision.
      stale_open_over_30d: int(o.stale_open)
    },
    close_reasons: closeReasons.rows.map((r) => ({
      reason: r.reason,
      trades: int(r.trades)
    })),
    idempotency_24h: idempotency.rows.map((r) => ({
      status: r.status,
      claims: int(r.claims)
    }))
  }
}

async function build (range) {
  const [support, disputeRows, context, feed, engine] = await Promise.all([
    supportLoad(range),
    disputes(range),
    ticketContext(range),
    priceFeedHealth(),
    engineHealth(range)
  ])

  return {
    generated_at: new Date().toISOString(),
    range: { from: range.from, to: range.to, days: range.days },
    support,                    // F96
    disputes: disputeRows,      // F97
    ticket_context: context,    // F98
    price_feed: feed,           // F99
    engine                      // F100
  }
}

module.exports = { build }
