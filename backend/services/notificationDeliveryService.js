'use strict'

const pool = require('../db')
const logger = require('../utils/logger')
const mailer = require('../mailer')

const BATCH_SIZE = 20

// admin_notifications.audience is free text with no defined taxonomy anywhere
// in the codebase (see routes/admin.js POST /notifications) — the only
// resolvable values are "all" and a specific user's email or numeric id.
// Anything else is an unresolved segment string with nothing to match against.
async function resolveRecipients(audience) {
  const normalized = String(audience || 'all').trim()

  if (!normalized || normalized.toLowerCase() === 'all') {
    const result = await pool.query(`SELECT id, email, full_name FROM users WHERE is_banned = FALSE`)
    return { recipients: result.rows, resolvedAs: 'all' }
  }

  const isNumeric = /^\d+$/.test(normalized)
  const result = await pool.query(
    isNumeric
      ? `SELECT id, email, full_name FROM users WHERE id = $1`
      : `SELECT id, email, full_name FROM users WHERE LOWER(email) = LOWER($1)`,
    [normalized]
  )
  if (result.rows.length > 0) return { recipients: result.rows, resolvedAs: 'single_user' }

  return { recipients: [], resolvedAs: 'unresolved_segment' }
}

async function deliverNotification(io, notification) {
  const { channel, title, message, audience } = notification

  if (channel === 'webhook') {
    return { status: 'failed', note: 'No webhook destination is configured for this platform yet.' }
  }

  const { recipients, resolvedAs } = await resolveRecipients(audience)

  if (resolvedAs === 'unresolved_segment') {
    return {
      status: 'failed',
      note: `Audience "${audience}" does not match "all" or a known user — segment targeting has no user grouping to resolve against yet.`
    }
  }

  if (channel === 'web') {
    const payload = { id: notification.id, type: notification.type, title, message, created_at: notification.created_at }
    if (resolvedAs === 'all') {
      io.emit('platform_notification', payload)
      return { status: 'sent', note: 'Broadcast to all connected sessions' }
    }
    recipients.forEach((recipient) => io.to(String(recipient.id)).emit('platform_notification', payload))
    return { status: 'sent', note: `Broadcast to ${recipients.length} recipient(s)` }
  }

  if (channel === 'email') {
    if (recipients.length === 0) {
      return { status: 'failed', note: 'No matching recipient email found.' }
    }
    const subject = title || 'Platform Notification'
    const html = mailer.htmlWrap(subject, `<p>${String(message).replace(/\n/g, '<br/>')}</p>`)
    let sentCount = 0
    for (const recipient of recipients) {
      if (!recipient.email) continue
      const result = await mailer.sendEmailMessage({ to: recipient.email, subject, html, text: message })
      if (result.ok) sentCount++
    }
    if (sentCount === 0) return { status: 'failed', note: 'Email delivery failed for all recipients.' }
    return { status: 'sent', note: `Emailed ${sentCount}/${recipients.length} recipient(s)` }
  }

  return { status: 'failed', note: `Unknown channel: ${channel}` }
}

async function processQueuedNotifications(io) {
  const due = await pool.query(
    `SELECT id, type, channel, title, message, audience, created_at
       FROM admin_notifications
      WHERE status IN ('queued', 'scheduled')
        AND (scheduled_for IS NULL OR scheduled_for <= NOW())
      ORDER BY created_at ASC
      LIMIT $1`,
    [BATCH_SIZE]
  )

  for (const notification of due.rows) {
    try {
      const { status, note } = await deliverNotification(io, notification)
      await pool.query(
        `UPDATE admin_notifications
            SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
          WHERE id = $1`,
        [notification.id, status]
      )
      if (status === 'failed') {
        logger.warn(`[notifications] Delivery failed for notification #${notification.id}: ${note}`)
      }
    } catch (error) {
      logger.error(`[notifications] Error delivering notification #${notification.id}:`, { error: error.message })
    }
  }
}

module.exports = { processQueuedNotifications }
