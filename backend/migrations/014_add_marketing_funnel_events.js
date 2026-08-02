/**
 * Migration 014: Add marketing_funnel_events table
 *
 * No pre-registration funnel tracking existed anywhere in this stack — user
 * registration (users.created_at) was the earliest tracked stage. This adds
 * a minimal event table for the "Visitors" stage of the Acquisition Funnel;
 * a fire-and-forget tracking call is added to the public Landing page.
 * Signups/Purchases stages of the same funnel are already real
 * (users.created_at / challenge_orders) and don't need this table.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS marketing_funnel_events (
      id          BIGSERIAL PRIMARY KEY,
      event_type  TEXT NOT NULL DEFAULT 'visit',
      session_id  TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_marketing_funnel_events_created ON marketing_funnel_events(event_type, created_at DESC)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS marketing_funnel_events`)
}
