/**
 * Migration 025: Persisted trader-facing notification history
 *
 * Before this, the notification bell in Dashboard.jsx was entirely
 * client-local — populated only by live Socket.IO events into localStorage,
 * so history didn't survive a storage clear and never synced across
 * devices/tabs. This table backs a real GET /api/notifications for the
 * trader, wired in via backend/utils/userNotifications.js's
 * createUserNotification(), called from notificationDeliveryService.js's
 * 'web' channel (admin-authored broadcasts) as the first integration point.
 */

exports.up = async function (knex) {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id          BIGSERIAL PRIMARY KEY,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL DEFAULT 'info',
      title       TEXT,
      message     TEXT NOT NULL,
      read        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await knex.raw(`CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC)`)
}

exports.down = async function (knex) {
  await knex.raw(`DROP TABLE IF EXISTS user_notifications`)
}
