/**
 * Migration 016: Trading competitions (weekly/monthly contests with a leaderboard)
 *
 * `competitions` holds admin-configured contest windows/rules; `competition_entries`
 * links a user to the dedicated `accounts` row (account_type='competition') they
 * trade on for that contest. Entry fee / recurrence / prize-pool columns are
 * included now but unused by v1 (free-to-join, one-off, admin manual payout) so
 * the schema doesn't need to change when those are layered in later.
 *
 * set_updated_at() is (re)defined here rather than assumed to already exist —
 * it's normally created by server.js's ensureUniqueIds() at app startup, but
 * migrations run as a separate deploy step before the server process starts,
 * so this table can't depend on that ordering.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS competitions (
      id                  BIGSERIAL PRIMARY KEY,
      slug                TEXT NOT NULL UNIQUE,
      title               TEXT NOT NULL,
      description         TEXT,
      type                TEXT NOT NULL DEFAULT 'weekly',      -- 'weekly' | 'monthly' | 'custom'
      status              TEXT NOT NULL DEFAULT 'upcoming',    -- 'upcoming' | 'active' | 'completed' | 'cancelled'
      start_at            TIMESTAMPTZ NOT NULL,
      end_at              TIMESTAMPTZ NOT NULL,
      entry_fee           NUMERIC NOT NULL DEFAULT 0,          -- unused in v1 (always 0), reserved for a future paid-entry mode
      starting_balance    NUMERIC NOT NULL DEFAULT 10000,
      max_participants    INTEGER,                              -- NULL = unlimited
      ranking_metric      TEXT NOT NULL DEFAULT 'profit_pct',   -- 'profit_pct' | 'profit_usd'
      max_drawdown_pct    NUMERIC NOT NULL DEFAULT 10,
      daily_drawdown_pct  NUMERIC,
      rules_json          JSONB NOT NULL DEFAULT '{}'::jsonb,   -- min_trades, allowed_instruments, etc.
      prize_pool_json     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{rank:1,label:"$500"}] — informational display only
      recurrence          TEXT,                                  -- unused in v1, reserved: 'weekly' | 'monthly'
      is_template         BOOLEAN NOT NULL DEFAULT FALSE,         -- unused in v1, reserved for auto-recurrence
      template_id         BIGINT REFERENCES competitions(id),
      created_by          TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competitions_start_end ON competitions(start_at, end_at)`)

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS competition_entries (
      id                  BIGSERIAL PRIMARY KEY,
      competition_id      BIGINT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id          UUID REFERENCES accounts(id),
      status              TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'disqualified' | 'withdrawn' | 'completed'
      joined_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      final_rank          INTEGER,
      final_profit_pct    NUMERIC,
      final_profit_usd    NUMERIC,
      final_stats_json    JSONB,
      disqualified_reason TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_competition_entry_user ON competition_entries(competition_id, user_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competition_entries_account ON competition_entries(account_id)`)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_competition_entries_competition_status ON competition_entries(competition_id, status)`)

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'competitions_upd_trigger') THEN
        CREATE TRIGGER competitions_upd_trigger BEFORE UPDATE ON competitions
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'competition_entries_upd_trigger') THEN
        CREATE TRIGGER competition_entries_upd_trigger BEFORE UPDATE ON competition_entries
        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
      END IF;
    END $$;
  `)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS competition_entries`)
  await knex.raw(`DROP TABLE IF EXISTS competitions`)
}
