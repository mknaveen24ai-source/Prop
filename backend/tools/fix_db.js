/**
 * WARNING: This is a one-time migration/debug script.
 * DO NOT run this in production unless explicitly instructed.
 * This script may modify database schema or data irreversibly.
 */

const pool = require('../db');

async function fix() {
  try {
    // support_tickets fixes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          BIGSERIAL PRIMARY KEY,
        user_id     TEXT,
        email       TEXT,
        name        TEXT,
        category    TEXT,
        subject     TEXT NOT NULL,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    
    // Attempt to alter in case they exist as INTEGER and need to be TEXT
    await pool.query(`ALTER TABLE support_tickets ALTER COLUMN user_id TYPE TEXT`).catch(e => console.error(e.message));
    await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category TEXT`).catch(e => console.error(e.message));
    await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS email TEXT`).catch(e => console.error(e.message));
    await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS name TEXT`).catch(e => console.error(e.message));
    
    // disputes fixes
    await pool.query(`
      CREATE TABLE IF NOT EXISTS disputes (
        id             BIGSERIAL PRIMARY KEY,
        user_id        TEXT NOT NULL,
        account_id     TEXT,
        reason         TEXT NOT NULL,
        description    TEXT NOT NULL,
        admin_reply    TEXT,
        status         TEXT NOT NULL DEFAULT 'open',
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`ALTER TABLE disputes ALTER COLUMN user_id TYPE TEXT`).catch(e => console.error(e.message));
    await pool.query(`ALTER TABLE disputes ALTER COLUMN account_id TYPE TEXT`).catch(e => console.error(e.message));

    console.log("DB Tables updated successfully!");
  } catch(e) {
    console.error("DB Fix error:", e);
  } finally {
    pool.end();
  }
}

fix();
