/**
 * Migration 040: marketing attribution, ad spend, and login geography.
 * ─────────────────────────────────────────────────────────────────────────────
 * Three gaps that made real growth analysis impossible, all found while
 * building the admin intelligence pages.
 *
 * 1. `marketing_funnel_events` stores only `event_type` (always the literal
 *    'visit') and `session_id` — server.js's POST /api/analytics/track hard-
 *    codes the whitelist to ['visit'] and writes nothing else. That is enough
 *    to count visitors and nothing more: "which channel produced this signup"
 *    has no answer anywhere in the database today, so every source-attributed
 *    funnel number would have had to be invented.
 *
 *    The original table was deliberately minimal ("no PII, no fingerprinting,
 *    just a count") and that intent is preserved: the columns added here are
 *    campaign metadata the visitor's own URL already carries, plus an OPTIONAL
 *    user_id that is only ever set once a visitor has authenticated and is
 *    therefore already identified. No fingerprint, no IP, no user agent.
 *
 * 2. There is no record of what the firm SPENDS to acquire a trader, so CAC,
 *    LTV:CAC and payback period cannot be computed from any existing table.
 *    `marketing_spend` is a small admin-entered ledger — one row per channel
 *    per day — deliberately not tied to any ad-platform integration.
 *
 * 3. `login_logs` records an IP but no country, so "signed up in one country,
 *    logs in from another" — a standard AML/collusion signal — cannot be
 *    evaluated without re-resolving historical IPs. The column is populated
 *    going forward from the edge/CDN country header when the deployment has
 *    one (Cloudflare's cf-ipcountry and friends); it stays NULL rather than
 *    guessing when no such header is present, and every consumer treats NULL
 *    as "unknown", never as "mismatch".
 *
 * All three changes are additive and nullable. Nothing that writes to these
 * tables today needs to change to keep working.
 */

exports.up = async function up (knex) {
  // ── 1. Funnel attribution ────────────────────────────────────────────────
  await knex.raw(`
    ALTER TABLE marketing_funnel_events
      ADD COLUMN IF NOT EXISTS utm_source   TEXT,
      ADD COLUMN IF NOT EXISTS utm_medium   TEXT,
      ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
      ADD COLUMN IF NOT EXISTS referrer     TEXT,
      ADD COLUMN IF NOT EXISTS landing_path TEXT,
      ADD COLUMN IF NOT EXISTS user_id      UUID
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS marketing_funnel_events_type_created_idx
      ON marketing_funnel_events (event_type, created_at)
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS marketing_funnel_events_session_idx
      ON marketing_funnel_events (session_id)
      WHERE session_id IS NOT NULL
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS marketing_funnel_events_source_idx
      ON marketing_funnel_events (utm_source, created_at)
      WHERE utm_source IS NOT NULL
  `)

  // ── 2. Ad spend ledger (CAC / payback inputs) ────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS marketing_spend (
      id           BIGSERIAL PRIMARY KEY,
      spend_date   DATE NOT NULL,
      channel      TEXT NOT NULL,
      amount       NUMERIC(15,2) NOT NULL,
      currency     TEXT NOT NULL DEFAULT 'USD',
      note         TEXT,
      created_by   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT marketing_spend_amount_check CHECK (amount >= 0),
      CONSTRAINT marketing_spend_unique_day_channel UNIQUE (spend_date, channel)
    )
  `)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS marketing_spend_date_idx ON marketing_spend (spend_date)
  `)

  // ── 3. Login geography ───────────────────────────────────────────────────
  await knex.raw(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS country TEXT`)
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS login_logs_user_country_idx
      ON login_logs (user_id, country)
      WHERE country IS NOT NULL
  `)
}

exports.down = async function down (knex) {
  await knex.raw('DROP INDEX IF EXISTS login_logs_user_country_idx')
  await knex.raw('ALTER TABLE login_logs DROP COLUMN IF EXISTS country')

  await knex.raw('DROP TABLE IF EXISTS marketing_spend')

  await knex.raw('DROP INDEX IF EXISTS marketing_funnel_events_source_idx')
  await knex.raw('DROP INDEX IF EXISTS marketing_funnel_events_session_idx')
  await knex.raw('DROP INDEX IF EXISTS marketing_funnel_events_type_created_idx')
  await knex.raw(`
    ALTER TABLE marketing_funnel_events
      DROP COLUMN IF EXISTS utm_source,
      DROP COLUMN IF EXISTS utm_medium,
      DROP COLUMN IF EXISTS utm_campaign,
      DROP COLUMN IF EXISTS referrer,
      DROP COLUMN IF EXISTS landing_path,
      DROP COLUMN IF EXISTS user_id
  `)
}
