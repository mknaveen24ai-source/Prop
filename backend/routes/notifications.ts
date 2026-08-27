import type {
  LegacyErrorResponse,
  NotificationMutationResponseDto,
  UserNotificationDto
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('../utils/logger')
import { authenticateToken } from './middleware'

type ListResponse = UserNotificationDto[] | LegacyErrorResponse
type MutationResponse = NotificationMutationResponseDto | LegacyErrorResponse
type ListRequest = ExpressRequest<Record<string, never>, ListResponse>
type MutationRequest = ExpressRequest<Record<string, never>, MutationResponse>

interface NotificationRow extends QueryResultRow {
  id: string | number
  type: string
  title: string | null
  message: string
  read: boolean
  created_at: Date | string
}

interface NotificationTestApi {
  mapNotification: (row: NotificationRow) => UserNotificationDto
  listNotificationsHandler: (
    req: ListRequest,
    res: ExpressResponse<ListResponse>
  ) => Promise<ExpressResponse<ListResponse>>
}

interface NotificationRouter extends Router {
  __test__: NotificationTestApi
}

const PAGE_SIZE = 50
const router = express.Router() as NotificationRouter

function authenticatedUserId(req: { user?: Express.AuthenticatedUser }): string {
  if (!req.user) throw new Error('Authenticated user missing after authenticateToken')
  return req.user.userId
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function mapNotification(row: NotificationRow): UserNotificationDto {
  return {
    id: String(row.id),
    type: row.type,
    title: row.title,
    message: row.message,
    read: row.read,
    created_at: isoTimestamp(row.created_at)
  }
}

async function listNotificationsHandler(
  req: ListRequest,
  res: ExpressResponse<ListResponse>
): Promise<ExpressResponse<ListResponse>> {
  try {
    const result = await pool.query<NotificationRow>(
      `SELECT id, type, title, message, read, created_at
         FROM user_notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [authenticatedUserId(req), PAGE_SIZE]
    )
    return res.json(result.rows.map(mapNotification))
  } catch (error: unknown) {
    logger.error('Fetch notifications error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not fetch notifications' })
  }
}

async function markAllReadHandler(
  req: MutationRequest,
  res: ExpressResponse<MutationResponse>
): Promise<ExpressResponse<MutationResponse>> {
  try {
    await pool.query(
      'UPDATE user_notifications SET read = TRUE WHERE user_id = $1 AND read = FALSE',
      [authenticatedUserId(req)]
    )
    return res.json({ success: true })
  } catch (error: unknown) {
    logger.error('Mark notifications read error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not update notifications' })
  }
}

async function clearNotificationsHandler(
  req: MutationRequest,
  res: ExpressResponse<MutationResponse>
): Promise<ExpressResponse<MutationResponse>> {
  try {
    await pool.query('DELETE FROM user_notifications WHERE user_id = $1', [authenticatedUserId(req)])
    return res.json({ success: true })
  } catch (error: unknown) {
    logger.error('Clear notifications error:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not clear notifications' })
  }
}

router.get('/', authenticateToken, listNotificationsHandler)
router.post('/mark-all-read', authenticateToken, markAllReadHandler)
router.delete('/', authenticateToken, clearNotificationsHandler)

router.__test__ = { mapNotification, listNotificationsHandler }

export = router
