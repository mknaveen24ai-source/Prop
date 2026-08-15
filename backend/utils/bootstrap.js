// Startup schema/infrastructure guards, moved verbatim out of server.js.
//
// This is deliberately NOT the migration system (see backend/migrations/ and
// MIGRATIONS.md). It is the idempotent safety net that runs on every boot so a
// request can never hit a table or column that a migration has not applied yet
// -- every statement here is CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS and is safe to re-run. Schema changes still belong in a migration
// first; this file only guarantees the floor.
//
// startServer() awaits ensureStartupInfrastructure() before httpServer.listen(),
// so nothing here races the first request.

const pool = require('../db')
const logger = require('./logger')
const { generateTraderUid } = require('./traderIds')
const { generateAccountUid } = require('./accountIds')
const { ensureIdempotencyInfrastructure } = require('./idempotency')
const { ensureEmailQueueInfrastructure } = require('./emailQueue')

// Required lazily inside ensureStartupInfrastructure(): routes/* pull in the
// route tree, which reaches back into utils/*. Requiring them at module load
// would make bootstrap.js part of that cycle for no benefit -- by the time
// startServer() calls in, every one of these modules is already loaded.
function lazyRouteInfrastructure() {
  const { ensureBillingInfrastructure } = require('../routes/billing')
  const { ensureChatTables } = require('../routes/chat')
  const { ensureTradeExperienceInfrastructure } = require('../routes/trades')
  return { ensureBillingInfrastructure, ensureChatTables, ensureTradeExperienceInfrastructure }
}

async function ensureUniqueIds() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trader_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_trader_uid_uq ON users(trader_uid)`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT TRUE`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_uid_uq ON accounts(account_uid)`)
    // Sequence tables for generateAccountUid/generateTraderUid (utils/accountIds.js,
    // utils/traderIds.js) — created here too (not just in their migrations) so the
    // backfill loops below never race against migrations not having run yet.
    await pool.query(`CREATE TABLE IF NOT EXISTS account_id_sequences (category TEXT PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS trader_id_sequences (id INTEGER PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
      date              DATE PRIMARY KEY,
      accounts_passed   INT NOT NULL DEFAULT 0,
      accounts_failed   INT NOT NULL DEFAULT 0,
      accounts_expired  INT NOT NULL DEFAULT 0,
      new_funded        INT NOT NULL DEFAULT 0
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS bbook_pnl_date_idx ON bbook_pnl(date DESC)`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`)
    await pool.query(`UPDATE accounts SET updated_at = created_at WHERE updated_at IS NULL`)
    await pool.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'accounts_upd_trigger') THEN
          CREATE TRIGGER accounts_upd_trigger
          BEFORE UPDATE ON accounts
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trade_logs (
        id          BIGSERIAL PRIMARY KEY,
        trade_id    TEXT,
        user_id     TEXT,
        account_id  TEXT,
        ip_address  TEXT,
        logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'trade_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN trade_id TYPE TEXT USING trade_id::text; END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'user_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN user_id TYPE TEXT USING user_id::text; END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'account_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN account_id TYPE TEXT USING account_id::text; END IF;
      END $$;
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id           BIGSERIAL PRIMARY KEY,
        user_id      TEXT,
        ip_address   TEXT,
        logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // FIX (BUG-M5): support_tickets DDL moved from inline route handlers to startup.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          BIGSERIAL PRIMARY KEY,
        user_id     INTEGER,
        email       TEXT,
        name        TEXT,
        category    TEXT,
        subject     TEXT NOT NULL,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id          BIGSERIAL PRIMARY KEY,
        ticket_id   BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
        sender_name TEXT,
        message     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx ON support_ticket_messages(ticket_id, created_at ASC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets(created_at DESC)`)
    const users = await pool.query(`SELECT id FROM users WHERE trader_uid IS NULL ORDER BY created_at ASC`)
    for (const row of users.rows) {
      const trader_uid = await generateTraderUid(pool)
      await pool.query(`UPDATE users SET trader_uid = $1 WHERE id = $2`, [trader_uid, row.id])
    }
    const accounts = await pool.query(`SELECT id, account_type, challenge_model_slug FROM accounts WHERE account_uid IS NULL ORDER BY created_at ASC`)
    for (const row of accounts.rows) {
      const account_uid = await generateAccountUid(pool, { accountType: row.account_type, challengeModelSlug: row.challenge_model_slug })
      await pool.query(`UPDATE accounts SET account_uid = $1 WHERE id = $2`, [account_uid, row.id])
    }
  } catch (err) {
    logger.warn('[startup] Failed to backfill unique IDs:', { error: err.message })
  }
}

// NOTE: routes/disputes.js has its own ensureDisputesInfrastructure() that
// declares user_id/account_id as TEXT, while this one declares them INTEGER
// with an FK. Both are CREATE TABLE IF NOT EXISTS, so on a fresh database
// whichever runs first wins. That predates this move and is left as-is here;
// queries that join disputes cast both sides to text so they work either way.
async function ensureDisputesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disputes (
      id             BIGSERIAL PRIMARY KEY,
      user_id        INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id     INTEGER,
      reason         TEXT      NOT NULL,
      description    TEXT      NOT NULL,
      status         TEXT      NOT NULL DEFAULT 'open',
      admin_response TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS disputes_created_idx ON disputes(created_at DESC)`)
}

// ─── Startup infrastructure ───────────────────────────────────────────────────
// These are independent of each other (different tables/columns), so they run
// concurrently — but startServer() awaits all of them before httpServer.listen(),
// so the first request can never race a table that hasn't been created yet.
async function ensureStartupInfrastructure() {
  const {
    ensureBillingInfrastructure,
    ensureChatTables,
    ensureTradeExperienceInfrastructure
  } = lazyRouteInfrastructure()

  await Promise.all([
    ensureUniqueIds().catch(err => {
      logger.error('[startup] Failed to ensure unique ids/infrastructure:', { error: err.message })
    }),
    pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS original_commission NUMERIC(10,2)`).catch(err => {
      logger.warn('[startup] Could not add original_commission column:', { error: err.message })
    }),
    ensureChatTables().catch(err => {
      logger.error('[startup] Failed to ensure chat tables:', { error: err.message })
    }),
    ensureBillingInfrastructure().catch(err => {
      logger.error('[startup] Failed to ensure billing infrastructure:', { error: err.message })
    }),
    ensureTradeExperienceInfrastructure().catch(err => {
      logger.error('[startup] Failed to ensure trade experience infrastructure:', { error: err.message })
    }),
    ensureIdempotencyInfrastructure().catch(err => {
      logger.error('[startup] Failed to ensure idempotency infrastructure:', { error: err.message })
    }),
    ensureEmailQueueInfrastructure().catch(err => {
      logger.error('[startup] Failed to ensure email queue infrastructure:', { error: err.message })
    }),
    ensureDisputesTable().catch(err => {
      logger.error('[startup] Failed to ensure disputes table:', { error: err.message })
    })
  ])
}

module.exports = {
  ensureStartupInfrastructure,
  ensureUniqueIds,
  ensureDisputesTable
}
