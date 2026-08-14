'use strict'

const pool = require('../db')
const logger = require('../utils/logger')

/**
 * Persists a notification row for a trader and (if an io instance is given)
 * pushes it live over their socket room, same event shape the trader
 * dashboard's bell already listens for. Insert-then-emit, not the other way
 * around, so a delivery failure never loses the persisted record.
 */
async function createUserNotification(io, userId, { type = 'info', title = null, message }) {
  if (!userId || !message) return null
  try {
    const result = await pool.query(
      `INSERT INTO user_notifications (user_id, type, title, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, type, title, message, read, created_at`,
      [userId, type, title, message]
    )
    const notification = result.rows[0]
    if (io) {
      io.to(String(userId)).emit('platform_notification', notification)
    }
    return notification
  } catch (error) {
    logger.error('[userNotifications] Failed to persist notification:', { error: error.message })
    return null
  }
}

module.exports = { createUserNotification }
