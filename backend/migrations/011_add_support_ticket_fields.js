/**
 * Migration 011: Add assigned agent + SLA deadline to support_tickets
 *
 * The admin Support & Appeals Center UI shows an assigned agent and an SLA
 * countdown per ticket, neither of which existed as columns. Both are
 * nullable so existing tickets simply show as unassigned/no-SLA until
 * touched; new tickets get a real SLA deadline set at creation time
 * (see server.js's /api/support/ticket handler).
 */

exports.up = async function (knex) {
  await knex.raw(`
    ALTER TABLE support_tickets
      ADD COLUMN IF NOT EXISTS assigned_agent TEXT,
      ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ
  `)
}

exports.down = async function (knex) {
  await knex.raw(`
    ALTER TABLE support_tickets
      DROP COLUMN IF EXISTS assigned_agent,
      DROP COLUMN IF EXISTS sla_due_at
  `)
}
