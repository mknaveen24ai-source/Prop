import nodeCrypto from 'node:crypto'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { QueryResultRow } from 'pg'
import type { Server } from 'socket.io'
import pool = require('./db')
import logger = require('./utils/logger')
import { getTenantSettingsMap } from './utils/tenantSettings'

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

interface ReferralSeasonsApi {
  computeReferralSeasonStandings: (
    db: typeof pool,
    season: ReferralSeasonRow,
    options: { persist: boolean }
  ) => Promise<unknown[]>
}

interface EmailQueueApi {
  enqueueReferralSeasonPrizeVoucherEmail: (
    email: string,
    fullName: string | null,
    title: string,
    code: string,
    accountSize: number,
    expiresAt: Date | string,
    metadata: { userId: string }
  ) => Promise<unknown>
}

interface UserNotificationsApi {
  createUserNotification: (
    io: TypedServer | null,
    userId: string,
    notification: { type: string; title: string; message: string }
  ) => Promise<unknown>
}

interface ReferralSeasonRow extends QueryResultRow {
  id: string
  title: string
  slug: string
  prize_pool_json: unknown
}

interface ReferralSeasonEntryRow extends QueryResultRow {
  entry_id: string
  final_rank: string | number
  referrer_user_id: string
  email: string | null
  full_name: string | null
}

interface VoucherRow extends QueryResultRow {
  id: string
  code: string
  expires_at: Date | string
}

interface VoucherSpec {
  account_size?: unknown
  challenge_model_slug?: unknown
}

const { computeReferralSeasonStandings } = require('./utils/referralSeasons') as ReferralSeasonsApi
const { enqueueReferralSeasonPrizeVoucherEmail } = require('./utils/emailQueue') as EmailQueueApi
const { createUserNotification } = require('./utils/userNotifications') as UserNotificationsApi

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral Season Engine
//
// Runs on a scheduler tick (see services/schedulerService.js) and drives the
// referral_seasons.status state machine: upcoming -> active -> completed.
// Mirrors competitionEngine.js's activate/finalize/issue-vouchers shape, but
// ranks affiliates by new paying referrals instead of trading P&L — see
// utils/referralSeasons.js and migration 026 for why this is a parallel
// engine rather than reusing the trading-competition tables.
// ─────────────────────────────────────────────────────────────────────────────

function generateSeasonVoucherCode(): string {
  return `SEASON-${nodeCrypto.randomBytes(5).toString('hex').toUpperCase()}`
}

async function activateDueSeasons(): Promise<void> {
  const result = await pool.query<ReferralSeasonRow>(
    `UPDATE referral_seasons
        SET status = 'active', updated_at = NOW()
      WHERE status = 'upcoming' AND start_at <= NOW()
      RETURNING id, title`
  )
  for (const row of result.rows) {
    logger.info(`Referral season engine: "${row.title}" (#${row.id}) is now ACTIVE`)
  }
}

// Issues a referral_season_prize_vouchers row to each ranked entry whose
// matching prize_pool_json slot (by rank) carries a structured `voucher`
// field — identical shape/idempotency guard to
// competitionEngine.js's issueCompetitionPrizeVouchers().
async function issueReferralSeasonPrizeVouchers(
  season: ReferralSeasonRow,
  _ranked: readonly unknown[],
  io: TypedServer | null
): Promise<void> {
  const prizePool: unknown[] = Array.isArray(season.prize_pool_json) ? season.prize_pool_json : []
  const voucherByRank = new Map<number, VoucherSpec>()
  for (const prize of prizePool) {
    if (isRecord(prize) && isRecord(prize.voucher) && Number.isFinite(Number(prize.rank))) {
      voucherByRank.set(Number(prize.rank), prize.voucher)
    }
  }
  if (voucherByRank.size === 0) return

  const settings = await getTenantSettingsMap(['referral_season_voucher_expiry_days'])
  const expiryDays = Math.max(1, parseInt(String(settings.referral_season_voucher_expiry_days), 10) || 90)

  const entriesResult = await pool.query<ReferralSeasonEntryRow>(
    `SELECT rse.id AS entry_id, rse.final_rank, rse.referrer_user_id, u.email, u.full_name
       FROM referral_season_entries rse
       JOIN users u ON u.id = rse.referrer_user_id
      WHERE rse.season_id = $1 AND rse.final_rank IS NOT NULL`,
    [season.id]
  )

  for (const winner of entriesResult.rows) {
    const voucherSpec = voucherByRank.get(Number(winner.final_rank))
    if (!voucherSpec) continue

    const accountSize = parseFloat(String(voucherSpec.account_size))
    const challengeModelSlug = String(voucherSpec.challenge_model_slug || '').trim()
    if (!Number.isFinite(accountSize) || accountSize <= 0 || !challengeModelSlug) {
      logger.warn(`Referral season engine: skipping malformed voucher spec for rank ${winner.final_rank} in season #${season.id}`)
      continue
    }

    const existing = await pool.query(
      `SELECT id FROM referral_season_prize_vouchers WHERE season_entry_id = $1`,
      [winner.entry_id]
    )
    if (existing.rows.length > 0) continue

    let voucher: VoucherRow | null = null
    for (let attempt = 0; attempt < 5 && !voucher; attempt++) {
      try {
        const insertResult = await pool.query<VoucherRow>(
          `INSERT INTO referral_season_prize_vouchers
             (code, season_id, season_entry_id, user_id, account_size, challenge_model_slug, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' days')::interval)
           RETURNING *`,
          [generateSeasonVoucherCode(), season.id, winner.entry_id, winner.referrer_user_id, accountSize, challengeModelSlug, expiryDays]
        )
        voucher = insertResult.rows[0] ?? null
      } catch (error: unknown) {
        if (!isRecord(error) || error.code !== '23505') throw error // unique code collision — retry with a new code
      }
    }
    if (!voucher) {
      logger.error(`Referral season engine: failed to generate a unique voucher code for entry ${winner.entry_id} after 5 attempts`)
      continue
    }

    logger.info(`Referral season engine: issued voucher ${voucher.code} to user ${winner.referrer_user_id} for rank ${winner.final_rank} in season #${season.id}`)

    // Persisted, cross-device notification — competitionEngine.js's
    // finalizeCompetition() never calls this for winners (only email + an
    // unscoped socket broadcast); closing that gap here rather than leaving
    // season winners without an in-app record of what they won.
    try {
      await createUserNotification(io, winner.referrer_user_id, {
        type: 'success',
        title: 'You won the referral season!',
        message: `You ranked #${winner.final_rank} in "${season.title}" and won a free $${accountSize.toLocaleString()} challenge account. Redeem code ${voucher.code} at checkout.`
      })
    } catch (notificationError: unknown) {
      logger.warn('Referral season engine: failed to create winner notification:', { error: errorMessage(notificationError) })
    }

    if (winner.email) {
      try {
        await enqueueReferralSeasonPrizeVoucherEmail(winner.email, winner.full_name, season.title, voucher.code, accountSize, voucher.expires_at, { userId: winner.referrer_user_id })
      } catch (emailError: unknown) {
        logger.warn('Referral season engine: failed to enqueue prize voucher email:', { error: errorMessage(emailError) })
      }
    }
  }
}

async function finalizeSeason(season: ReferralSeasonRow, io: TypedServer | null): Promise<void> {
  const ranked = await computeReferralSeasonStandings(pool, season, { persist: true })

  await pool.query(`UPDATE referral_seasons SET status = 'completed', updated_at = NOW() WHERE id = $1`, [season.id])

  try {
    await issueReferralSeasonPrizeVouchers(season, ranked, io)
  } catch (error: unknown) {
    logger.error(`Referral season engine: prize voucher issuance failed for season #${season.id}:`, { error: errorMessage(error) })
  }

  logger.info(`Referral season engine: "${season.title}" (#${season.id}) COMPLETED — ${ranked.length} entries ranked`)

  if (io) {
    io.emit('referral_season_ended', { season_id: season.id, slug: season.slug })
  }
}

async function closeDueSeasons(io: TypedServer | null): Promise<void> {
  const dueResult = await pool.query<ReferralSeasonRow>(
    `SELECT * FROM referral_seasons WHERE status = 'active' AND end_at <= NOW()`
  )
  for (const season of dueResult.rows) {
    await finalizeSeason(season, io)
  }
}

async function runReferralSeasonEngine(io: TypedServer | null): Promise<void> {
  try {
    await activateDueSeasons()
    await closeDueSeasons(io)
  } catch (error: unknown) {
    logger.error('Referral season engine tick failed:', { error: errorMessage(error) })
  }
}

const referralSeasonEngine = { runReferralSeasonEngine }

export = referralSeasonEngine
