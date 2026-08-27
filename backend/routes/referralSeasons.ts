import type {
  JsonValue,
  LegacyErrorResponse,
  ReferralSeasonDetailDto,
  ReferralSeasonDto,
  ReferralSeasonEntryDto,
  ReferralSeasonFinalStandingDto,
  ReferralSeasonLiveStandingDto,
  ReferralSeasonStatus,
  ReferralSeasonVoucherDto
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { QueryResultRow } from 'pg'
import pool = require('../db')
import logger = require('../utils/logger')
import { jsonValueSchema, parseExternal } from '../validation/unknown'

interface MiddlewareApi {
  authenticateToken: RequestHandler
}

interface ReferralSeasonRow extends QueryResultRow {
  id: string
  slug: string
  title: string
  description: string | null
  status: ReferralSeasonStatus
  start_at: Date | string
  end_at: Date | string
  ranking_metric: string
  prize_pool_json: unknown
  created_by: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface ReferralEntryRow extends QueryResultRow {
  new_paying_referrals: number
  final_rank: number
}

interface ReferralSeasonVoucherRow extends QueryResultRow {
  id: string
  code: string
  account_size: string
  challenge_model_slug: string
  status: string
  issued_at: Date | string
  expires_at: Date | string | null
  redeemed_at: Date | string | null
  season_title: string
  season_slug: string
  final_rank: number | null
}

interface ReferralSeasonApi {
  computeReferralSeasonStandings: (
    database: typeof pool,
    season: ReferralSeasonRow,
    options: { persist: false }
  ) => Promise<ReferralSeasonLiveStandingDto[]>
  fetchReferralSeasonBySlugOrId: (idOrSlug: string) => Promise<ReferralSeasonRow | null>
  fetchReferralSeasonLeaderboard: (seasonId: string) => Promise<ReferralSeasonFinalStandingDto[]>
}

interface SlugParams {
  [key: string]: string
  slug: string
}

interface ReferralSeasonsTestApi {
  mapReferralSeasonVoucher: (row: ReferralSeasonVoucherRow) => ReferralSeasonVoucherDto
  serializeSeason: (row: ReferralSeasonRow) => ReferralSeasonDto
}

interface ReferralSeasonsRouter extends Router {
  __test__: ReferralSeasonsTestApi
}

type ReferralSeasonsResponse = ReferralSeasonDto[]
  | ReferralSeasonDetailDto
  | ReferralSeasonLiveStandingDto[]
  | ReferralSeasonFinalStandingDto[]
  | ReferralSeasonVoucherDto[]
  | LegacyErrorResponse

const { authenticateToken } = require('./middleware') as MiddlewareApi
const {
  fetchReferralSeasonBySlugOrId,
  computeReferralSeasonStandings,
  fetchReferralSeasonLeaderboard
} = require('../utils/referralSeasons') as ReferralSeasonApi
const router = express.Router() as ReferralSeasonsRouter

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function nullableIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value)
}

function prizePool(value: unknown): JsonValue {
  return parseExternal(jsonValueSchema, value || [], 'referral season prize_pool_json')
}

function serializeSeason(row: ReferralSeasonRow): ReferralSeasonDto {
  return {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    description: row.description,
    status: row.status,
    start_at: isoTimestamp(row.start_at),
    end_at: isoTimestamp(row.end_at),
    ranking_metric: row.ranking_metric,
    prize_pool: prizePool(row.prize_pool_json)
  }
}

function mapReferralSeasonVoucher(row: ReferralSeasonVoucherRow): ReferralSeasonVoucherDto {
  return {
    id: String(row.id),
    code: row.code,
    account_size: String(row.account_size),
    challenge_model_slug: row.challenge_model_slug,
    status: row.status,
    issued_at: isoTimestamp(row.issued_at),
    expires_at: nullableIsoTimestamp(row.expires_at),
    redeemed_at: nullableIsoTimestamp(row.redeemed_at),
    season_title: row.season_title,
    season_slug: row.season_slug,
    final_rank: row.final_rank
  }
}

function authenticatedUserId(req: ExpressRequest): string {
  if (!req.user) throw new Error('Authenticated user missing from request')
  return req.user.userId
}

async function listSeasonsHandler(
  req: ExpressRequest,
  res: ExpressResponse<ReferralSeasonsResponse>
): Promise<ExpressResponse<ReferralSeasonsResponse>> {
  try {
    const rawStatus: unknown = req.query.status
    const status = String(rawStatus || '').trim()
    const validStatuses: readonly ReferralSeasonStatus[] = [
      'upcoming',
      'active',
      'completed',
      'cancelled'
    ]
    const conditions: string[] = []
    const values: unknown[] = []
    if (validStatuses.includes(status as ReferralSeasonStatus)) {
      values.push(status)
      conditions.push(`status = $${values.length}`)
    } else {
      conditions.push(`status != 'cancelled'`)
    }
    const result = await pool.query<ReferralSeasonRow>(
      `SELECT id, slug, title, description, status, start_at, end_at,
              ranking_metric, prize_pool_json, created_by, created_at, updated_at
         FROM referral_seasons
        WHERE ${conditions.join(' AND ')}
        ORDER BY start_at DESC
        LIMIT 100`,
      values
    )
    return res.json(result.rows.map(serializeSeason))
  } catch (error: unknown) {
    logger.error('[referral-seasons] Failed to list seasons:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load referral seasons' })
  }
}

async function seasonDetailHandler(
  req: ExpressRequest<SlugParams>,
  res: ExpressResponse<ReferralSeasonsResponse>
): Promise<ExpressResponse<ReferralSeasonsResponse>> {
  try {
    const rawSlug: unknown = req.params.slug
    const slug = typeof rawSlug === 'string' ? rawSlug : ''
    const season = await fetchReferralSeasonBySlugOrId(slug)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    let myEntry: ReferralSeasonEntryDto | null = null
    const userId = authenticatedUserId(req)
    if (season.status === 'completed') {
      const entryResult = await pool.query<ReferralEntryRow>(
        `SELECT new_paying_referrals, final_rank
           FROM referral_season_entries
          WHERE season_id = $1 AND referrer_user_id = $2`,
        [season.id, userId]
      )
      myEntry = entryResult.rows[0] || null
    } else {
      const ranked = await computeReferralSeasonStandings(pool, season, { persist: false })
      const mine = ranked.find((row) => row.referrer_user_id === userId)
      myEntry = mine
        ? { new_paying_referrals: mine.new_paying_referrals, final_rank: mine.rank }
        : null
    }

    return res.json({ ...serializeSeason(season), my_entry: myEntry })
  } catch (error: unknown) {
    logger.error('[referral-seasons] Failed to load season detail:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load referral season' })
  }
}

async function seasonLeaderboardHandler(
  req: ExpressRequest<SlugParams>,
  res: ExpressResponse<ReferralSeasonsResponse>
): Promise<ExpressResponse<ReferralSeasonsResponse>> {
  try {
    const rawSlug: unknown = req.params.slug
    const slug = typeof rawSlug === 'string' ? rawSlug : ''
    const season = await fetchReferralSeasonBySlugOrId(slug)
    if (!season) return res.status(404).json({ error: 'Referral season not found' })

    if (season.status === 'completed') {
      return res.json(await fetchReferralSeasonLeaderboard(season.id))
    }
    return res.json(await computeReferralSeasonStandings(pool, season, { persist: false }))
  } catch (error: unknown) {
    logger.error('[referral-seasons] Failed to load leaderboard:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load leaderboard' })
  }
}

async function myVouchersHandler(
  req: ExpressRequest,
  res: ExpressResponse<ReferralSeasonsResponse>
): Promise<ExpressResponse<ReferralSeasonsResponse>> {
  try {
    const result = await pool.query<ReferralSeasonVoucherRow>(
      `SELECT v.id, v.code, v.account_size, v.challenge_model_slug, v.status,
              v.issued_at, v.expires_at, v.redeemed_at,
              s.title AS season_title, s.slug AS season_slug, rse.final_rank
         FROM referral_season_prize_vouchers v
         JOIN referral_seasons s ON s.id = v.season_id
         LEFT JOIN referral_season_entries rse ON rse.id = v.season_entry_id
        WHERE v.user_id = $1
        ORDER BY v.issued_at DESC`,
      [authenticatedUserId(req)]
    )
    return res.json(result.rows.map(mapReferralSeasonVoucher))
  } catch (error: unknown) {
    logger.error('[referral-seasons] Failed to load vouchers:', { error: errorMessage(error) })
    return res.status(500).json({ error: 'Could not load vouchers' })
  }
}

router.get('/', listSeasonsHandler)
router.get<SlugParams>('/:slug', authenticateToken, seasonDetailHandler)
router.get<SlugParams>('/:slug/leaderboard', seasonLeaderboardHandler)
router.get('/vouchers/mine', authenticateToken, myVouchersHandler)

router.__test__ = { mapReferralSeasonVoucher, serializeSeason }

export = router
