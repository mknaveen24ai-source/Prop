const pool = require('../db')
const logger = require('./logger')
const { getTenantSettings } = require('../services/tenantPolicyService')
const {
  buildEmailMessage,
  sendEmailMessage,
  isSupportedEmailTemplate
} = require('../mailer')

const EMAIL_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
const EMAIL_SENDING_STALE_MS = 15 * 60_000

let emailQueueReady = false
let emailQueuePromise = null
const DEFAULT_KYC_REMINDER_DELAY_HOURS = Math.max(1, parseInt(process.env.EMAIL_KYC_REMINDER_DELAY_HOURS || '24', 10) || 24)

function toNullableString(value) {
  if (value == null) return null
  const normalized = String(value).trim()
  return normalized ? normalized : null
}

function normalizeScheduledFor(value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

function normalizeUniqueKey(value) {
  if (!value) return null
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, 255) : null
}

function summarizeError(error) {
  const raw = error?.message || error?.stack || String(error || 'Unknown email worker error')
  return String(raw).slice(0, 2000)
}

function computeRetryDelayMs(attemptCount) {
  const index = Math.max(0, parseInt(attemptCount, 10) - 1)
  return EMAIL_RETRY_DELAYS_MS[index] || null
}

async function ensureEmailQueueInfrastructure(db = pool) {
  if (emailQueueReady) return
  if (emailQueuePromise) return emailQueuePromise

  emailQueuePromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS email_jobs (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT,
        to_email TEXT NOT NULL,
        template_key TEXT NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        provider_message_id TEXT,
        preview_url TEXT,
        scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_attempt_at TIMESTAMPTZ,
        sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT email_jobs_status_check CHECK (status IN ('pending', 'sending', 'retry', 'sent', 'failed', 'dead'))
      )
    `)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_email_jobs_status_schedule ON email_jobs(status, scheduled_for ASC, id ASC)`)
    await db.query(`CREATE INDEX IF NOT EXISTS idx_email_jobs_created ON email_jobs(created_at DESC)`)
    await db.query(`ALTER TABLE email_jobs ADD COLUMN IF NOT EXISTS unique_key TEXT`)
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_email_jobs_unique_key ON email_jobs(unique_key)`)
    emailQueueReady = true
    emailQueuePromise = null
  })().catch((error) => {
    emailQueuePromise = null
    throw error
  })

  return emailQueuePromise
}

async function enqueueEmailJob({ userId = null, toEmail, templateKey, payload = {}, scheduledFor = null, uniqueKey = null }) {
  const normalizedTemplateKey = String(templateKey || '').trim().toLowerCase()
  const normalizedToEmail = String(toEmail || '').trim().toLowerCase()
  const normalizedUniqueKey = normalizeUniqueKey(uniqueKey)
  if (!normalizedToEmail) throw new Error('toEmail is required')
  if (!isSupportedEmailTemplate(normalizedTemplateKey)) {
    throw new Error(`Unsupported email template: ${normalizedTemplateKey || 'unknown'}`)
  }

  await ensureEmailQueueInfrastructure()
  const insertValues = [
    toNullableString(userId),
    normalizedToEmail,
    normalizedTemplateKey,
    JSON.stringify(payload || {}),
    normalizeScheduledFor(scheduledFor),
    normalizedUniqueKey
  ]

  if (normalizedUniqueKey) {
    const result = await pool.query(
      `INSERT INTO email_jobs
        (user_id, to_email, template_key, payload_json, status, scheduled_for, unique_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, 'pending', COALESCE($5, NOW()), $6, NOW(), NOW())
       ON CONFLICT (unique_key) DO NOTHING
       RETURNING id, status, scheduled_for, created_at`,
      insertValues
    )
    if (result.rows[0]) {
      return { ...result.rows[0], deduped: false }
    }
    const existing = await pool.query(
      `SELECT id, status, scheduled_for, created_at
         FROM email_jobs
        WHERE unique_key = $1
        LIMIT 1`,
      [normalizedUniqueKey]
    )
    return { ...(existing.rows[0] || {}), deduped: true }
  }

  const result = await pool.query(
    `INSERT INTO email_jobs
      (user_id, to_email, template_key, payload_json, status, scheduled_for, unique_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, 'pending', COALESCE($5, NOW()), $6, NOW(), NOW())
     RETURNING id, status, scheduled_for, created_at`,
    insertValues
  )
  return { ...result.rows[0], deduped: false }
}

async function enqueueTemplateEmail(templateKey, payload = {}, options = {}) {
  return enqueueEmailJob({
    userId: options?.userId || payload?.userId || null,
    toEmail: payload?.toEmail,
    templateKey,
    payload,
    scheduledFor: options?.scheduledFor || null,
    uniqueKey: options?.uniqueKey || null
  })
}

async function enqueuePasswordResetEmail(toEmail, resetLink, resetToken, options = {}) {
  return enqueueTemplateEmail('password_reset', { toEmail, resetLink, resetToken }, options)
}

async function enqueueWelcomeOnboardingEmail(toEmail, fullName, traderUid, affiliateCode, options = {}) {
  return enqueueTemplateEmail('welcome_onboarding', { toEmail, fullName, traderUid, affiliateCode }, options)
}

async function enqueueChallengeExpiryReminderEmail(toEmail, fullName, accountType, accountSize, daysRemaining, phaseEndDate, options = {}) {
  return enqueueTemplateEmail('challenge_expiry_reminder', { toEmail, fullName, accountType, accountSize, daysRemaining, phaseEndDate }, options)
}

async function enqueueChallengeInactivityReminderEmail(toEmail, fullName, accountType, accountSize, inactivityFailDays, daysUntilFail, lastActivityAt, options = {}) {
  return enqueueTemplateEmail('challenge_inactivity_reminder', { toEmail, fullName, accountType, accountSize, inactivityFailDays, daysUntilFail, lastActivityAt }, options)
}

async function enqueuePhasePassedEmail(toEmail, fullName, phase, accountSize, options = {}) {
  return enqueueTemplateEmail('phase_passed', { toEmail, fullName, phase, accountSize }, options)
}

async function enqueueAccountFailedEmail(toEmail, fullName, phase, reason, accountSize, options = {}) {
  return enqueueTemplateEmail('account_failed', { toEmail, fullName, phase, reason, accountSize }, options)
}

async function enqueueAccountExpiredEmail(toEmail, fullName, phase, accountSize, options = {}) {
  return enqueueTemplateEmail('account_expired', { toEmail, fullName, phase, accountSize }, options)
}

async function enqueueKycPendingReminderEmail(toEmail, fullName, hoursSinceSignup, options = {}) {
  return enqueueTemplateEmail('kyc_pending_reminder', { toEmail, fullName, hoursSinceSignup }, options)
}

async function enqueueKycApprovedEmail(toEmail, fullName, options = {}) {
  return enqueueTemplateEmail('kyc_approved', { toEmail, fullName }, options)
}

async function enqueueKycRejectedEmail(toEmail, fullName, reason, options = {}) {
  return enqueueTemplateEmail('kyc_rejected', { toEmail, fullName, reason }, options)
}

async function enqueuePayoutRequestedEmail(toEmail, fullName, amountRequested, amountPayable, paymentMethod, options = {}) {
  return enqueueTemplateEmail('payout_requested', { toEmail, fullName, amountRequested, amountPayable, paymentMethod }, options)
}

async function enqueuePayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod, options = {}) {
  return enqueueTemplateEmail('payout_approved', { toEmail, fullName, amountPayable, paymentMethod }, options)
}

async function enqueuePayoutRejectedEmail(toEmail, fullName, amountRequested, reason, options = {}) {
  return enqueueTemplateEmail('payout_rejected', { toEmail, fullName, amountRequested, reason }, options)
}

async function enqueueAffiliateCommissionEarnedEmail(toEmail, fullName, commissionAmount, referredName, options = {}) {
  return enqueueTemplateEmail('affiliate_commission_earned', { toEmail, fullName, commissionAmount, referredName }, options)
}

async function enqueueAffiliatePayoutRequestedEmail(toEmail, fullName, amountRequested, options = {}) {
  return enqueueTemplateEmail('affiliate_payout_requested', { toEmail, fullName, amountRequested }, options)
}

async function enqueueAffiliatePayoutApprovedEmail(toEmail, fullName, amountPayable, paymentMethod, options = {}) {
  return enqueueTemplateEmail('affiliate_payout_approved', { toEmail, fullName, amountPayable, paymentMethod }, options)
}

async function enqueueAffiliatePayoutRejectedEmail(toEmail, fullName, amountRequested, reason, options = {}) {
  return enqueueTemplateEmail('affiliate_payout_rejected', { toEmail, fullName, amountRequested, reason }, options)
}

async function enqueueCompetitionPrizeVoucherEmail(toEmail, fullName, competitionTitle, voucherCode, accountSize, expiresAt, options = {}) {
  return enqueueTemplateEmail('competition_prize_voucher', { toEmail, fullName, competitionTitle, voucherCode, accountSize, expiresAt }, options)
}

async function enqueueGiftChallengeVoucherEmail(toEmail, fullName, purchaserName, voucherCode, accountSize, giftMessage, expiresAt, options = {}) {
  return enqueueTemplateEmail('gift_challenge_voucher', { toEmail, fullName, purchaserName, voucherCode, accountSize, giftMessage, expiresAt }, options)
}

async function enqueueReferralSeasonPrizeVoucherEmail(toEmail, fullName, seasonTitle, voucherCode, accountSize, expiresAt, options = {}) {
  return enqueueTemplateEmail('referral_season_prize_voucher', { toEmail, fullName, seasonTitle, voucherCode, accountSize, expiresAt }, options)
}

/**
 * Queue the certificate award email.
 *
 * The payload deliberately carries only the certificate's public_id and the
 * display fields — the PDF and preview image are rendered by the mailer at send
 * time. Storing a rendered PDF in payload_json would put megabytes of base64
 * into a JSONB column that is read on every queue sweep.
 *
 * uniqueKey makes the whole thing idempotent for free: a replayed promotion or
 * a double-clicked payout approval hits the unique index on email_jobs and is
 * deduped rather than emailing the trader twice.
 */
async function enqueueCertificateAwardedEmail(toEmail, certificate, options = {}) {
  return enqueueTemplateEmail(
    'certificate_awarded',
    {
      toEmail,
      fullName: certificate?.recipient_name || 'Trader',
      title: certificate?.title || 'Certificate of Achievement',
      certificatePublicId: certificate?.public_id || ''
    },
    { ...options, uniqueKey: options.uniqueKey || `certificate:${certificate?.public_id || ''}` }
  )
}

async function claimPendingEmailJobs(limit = 10) {
  await ensureEmailQueueInfrastructure()
  await pool.query(
    `UPDATE email_jobs
        SET status = 'retry',
            updated_at = NOW(),
            last_error = COALESCE(last_error, 'Recovered stale sending job')
      WHERE status = 'sending'
        AND last_attempt_at IS NOT NULL
        AND last_attempt_at <= NOW() - (($1::bigint / 1000.0) * INTERVAL '1 second')`,
    [EMAIL_SENDING_STALE_MS]
  )
  const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 10, 100))
  const result = await pool.query(
    `WITH next_jobs AS (
       SELECT id
         FROM email_jobs
        WHERE status IN ('pending', 'retry')
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE email_jobs AS jobs
        SET status = 'sending',
            attempt_count = jobs.attempt_count + 1,
            last_attempt_at = NOW(),
            updated_at = NOW()
       FROM next_jobs
      WHERE jobs.id = next_jobs.id
      RETURNING jobs.*`,
    [safeLimit]
  )
  return result.rows
}

async function markEmailJobSent(jobId, meta = {}) {
  await pool.query(
    `UPDATE email_jobs
        SET status = 'sent',
            provider_message_id = $2,
            preview_url = $3,
            sent_at = NOW(),
            last_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [jobId, toNullableString(meta?.messageId), toNullableString(meta?.previewUrl)]
  )
}

async function markEmailJobRetry(job, error) {
  const delayMs = computeRetryDelayMs(job?.attempt_count)
  const nextRunAt = delayMs ? new Date(Date.now() + delayMs) : null
  const status = nextRunAt ? 'retry' : 'dead'
  await pool.query(
    `UPDATE email_jobs
        SET status = $2,
            last_error = $3,
            scheduled_for = COALESCE($4, scheduled_for),
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, status, summarizeError(error), nextRunAt]
  )
}

async function processEmailJob(job) {
  try {
    const payload = job.payload_json && typeof job.payload_json === 'object'
      ? job.payload_json
      : JSON.parse(job.payload_json || '{}')
    const message = await buildEmailMessage(job.template_key, payload)
    const result = await sendEmailMessage(message)
    if (result.ok) {
      await markEmailJobSent(job.id, result)
      return { status: 'sent' }
    }
    await markEmailJobRetry(job, result.error || new Error('Unknown email send failure'))
    return { status: computeRetryDelayMs(job.attempt_count) ? 'retry' : 'dead' }
  } catch (error) {
    await markEmailJobRetry(job, error)
    return { status: computeRetryDelayMs(job.attempt_count) ? 'retry' : 'dead' }
  }
}

async function processEmailQueueBatch(options = {}) {
  const batchSize = Math.max(1, Math.min(parseInt(options?.batchSize, 10) || 10, 100))
  const jobs = await claimPendingEmailJobs(batchSize)
  if (jobs.length === 0) {
    return { claimed: 0, sent: 0, retry: 0, dead: 0 }
  }

  const summary = { claimed: jobs.length, sent: 0, retry: 0, dead: 0 }
  for (const job of jobs) {
    const result = await processEmailJob(job)
    if (result.status === 'sent') summary.sent += 1
    else if (result.status === 'retry') summary.retry += 1
    else summary.dead += 1
  }
  return summary
}

function buildUtcDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

function clampWholeDaysRemaining(endDate, now = new Date()) {
  const diffMs = endDate.getTime() - now.getTime()
  return Math.max(0, Math.ceil(diffMs / (24 * 60 * 60 * 1000)))
}

async function scheduleKycPendingReminderEmails(options = {}) {
  await ensureEmailQueueInfrastructure()
  const limit = Math.max(1, Math.min(parseInt(options?.limit, 10) || 250, 1000))
  const delayHours = Math.max(1, parseInt(options?.delayHours, 10) || DEFAULT_KYC_REMINDER_DELAY_HOURS)
  const periodKey = String(options?.periodKey || buildUtcDateKey()).trim() || buildUtcDateKey()

  const result = await pool.query(
    `SELECT u.id::text AS user_id,
            u.email,
            u.full_name,
            u.created_at
       FROM users u
      WHERE LOWER(COALESCE(u.kyc_status, 'pending')) = 'pending'
        AND COALESCE(NULLIF(TRIM(u.email), ''), '') <> ''
        AND u.created_at <= NOW() - ($1 * INTERVAL '1 hour')
        AND (
          u.kyc_submitted_at IS NULL
          OR u.id_document_path IS NULL
          OR u.selfie_path IS NULL
        )
      ORDER BY u.created_at ASC
      LIMIT $2`,
    [delayHours, limit]
  )

  let scheduled = 0
  for (const row of result.rows) {
    const createdAt = row.created_at ? new Date(row.created_at) : null
    const hoursSinceSignup = createdAt && Number.isFinite(createdAt.getTime())
      ? Math.max(1, Math.floor((Date.now() - createdAt.getTime()) / 3600000))
      : delayHours
    const job = await enqueueKycPendingReminderEmail(
      row.email,
      row.full_name || 'Trader',
      hoursSinceSignup,
      {
        userId: row.user_id,
        uniqueKey: `kyc-pending-reminder:${row.user_id}:${periodKey}`
      }
    )
    if (!job?.deduped) scheduled += 1
  }

  return {
    candidates: result.rows.length,
    scheduled
  }
}

async function scheduleChallengeExpiryReminderEmails(options = {}) {
  await ensureEmailQueueInfrastructure()
  const thresholds = Array.isArray(options?.thresholds) && options.thresholds.length > 0
    ? [...new Set(options.thresholds.map((value) => parseInt(value, 10)).filter((value) => Number.isFinite(value) && value >= 0))]
    : [7, 3, 1]
  const limit = Math.max(1, Math.min(parseInt(options?.limit, 10) || 500, 2000))
  const now = new Date()
  const maxThreshold = Math.max(...thresholds, 1)

  const result = await pool.query(
    `SELECT a.id,
            a.user_id::text AS user_id,
            a.account_type,
            a.account_size,
            a.phase_end_date,
            u.email,
            u.full_name
       FROM accounts a
       JOIN users u ON u.id = a.user_id
      WHERE a.status = 'active'
        AND a.account_type IN ('phase1', 'phase2')
        AND a.phase_end_date IS NOT NULL
        AND a.phase_end_date > NOW()
        AND a.phase_end_date <= NOW() + ($1 * INTERVAL '1 day')
      ORDER BY a.phase_end_date ASC
      LIMIT $2`,
    [maxThreshold, limit]
  )

  let scheduled = 0
  for (const row of result.rows) {
    const phaseEndDate = row.phase_end_date ? new Date(row.phase_end_date) : null
    if (!phaseEndDate || !Number.isFinite(phaseEndDate.getTime())) continue
    const daysRemaining = clampWholeDaysRemaining(phaseEndDate, now)
    if (!thresholds.includes(daysRemaining)) continue

    const job = await enqueueChallengeExpiryReminderEmail(
      row.email,
      row.full_name || 'Trader',
      row.account_type,
      row.account_size,
      daysRemaining,
      phaseEndDate.toISOString(),
      {
        userId: row.user_id,
        uniqueKey: `challenge-expiry:${row.id}:${phaseEndDate.toISOString().slice(0, 10)}:${daysRemaining}`
      }
    )
    if (!job?.deduped) scheduled += 1
  }

  return {
    candidates: result.rows.length,
    scheduled
  }
}

async function scheduleChallengeInactivityReminderEmails(options = {}) {
  await ensureEmailQueueInfrastructure()
  const thresholds = Array.isArray(options?.thresholds) && options.thresholds.length > 0
    ? [...new Set(options.thresholds.map((value) => parseInt(value, 10)).filter((value) => Number.isFinite(value) && value >= 0))]
    : [7, 3, 1]
  const limit = Math.max(1, Math.min(parseInt(options?.limit, 10) || 500, 2000))
  const result = await pool.query(
    `SELECT
        a.id,
        a.user_id::text AS user_id,
        a.account_type,
        a.account_size,
        a.phase_start_date,
        a.created_at,
        u.email,
        u.full_name,
        NULLIF(
          MAX(
            GREATEST(
              COALESCE(t.open_time, '-infinity'::timestamptz),
              COALESCE(t.close_time, '-infinity'::timestamptz)
            )
          ),
          '-infinity'::timestamptz
        ) AS last_activity_at
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN trades t ON t.account_id = a.id
      WHERE a.status = 'active'
        AND a.account_type IN ('phase1', 'phase2')
      GROUP BY a.id, a.user_id, a.account_type, a.account_size, a.phase_start_date, a.created_at, u.email, u.full_name
      ORDER BY COALESCE(MAX(GREATEST(COALESCE(t.open_time, '-infinity'::timestamptz), COALESCE(t.close_time, '-infinity'::timestamptz))), a.phase_start_date, a.created_at) ASC
      LIMIT $1`,
    [limit]
  )

  let cachedSettings = null
  let scheduled = 0
  const now = Date.now()
  const maxThreshold = Math.max(...thresholds, 1)

  for (const row of result.rows) {
    if (!cachedSettings) {
      cachedSettings = await getTenantSettings(['inactivity_auto_fail_enabled', 'inactivity_fail_days'])
    }
    const settings = cachedSettings || {}
    const inactivityEnabled = settings.inactivity_auto_fail_enabled !== 'false'
    const inactivityFailDays = Math.max(1, parseInt(settings.inactivity_fail_days || '30', 10) || 30)
    if (!inactivityEnabled || inactivityFailDays <= 0) continue

    const lastActivityAt = row.last_activity_at || row.phase_start_date || row.created_at
    const lastActivityDate = lastActivityAt ? new Date(lastActivityAt) : null
    if (!lastActivityDate || !Number.isFinite(lastActivityDate.getTime())) continue

    const inactiveDays = Math.floor((now - lastActivityDate.getTime()) / (24 * 60 * 60 * 1000))
    const daysUntilFail = inactivityFailDays - inactiveDays
    if (daysUntilFail <= 0 || daysUntilFail > maxThreshold || !thresholds.includes(daysUntilFail)) continue

    const job = await enqueueChallengeInactivityReminderEmail(
      row.email,
      row.full_name || 'Trader',
      row.account_type,
      row.account_size,
      inactivityFailDays,
      daysUntilFail,
      lastActivityDate.toISOString(),
      {
        userId: row.user_id,
        uniqueKey: `challenge-inactivity:${row.id}:${lastActivityDate.toISOString().slice(0, 10)}:${daysUntilFail}`
      }
    )
    if (!job?.deduped) scheduled += 1
  }

  return {
    candidates: result.rows.length,
    scheduled
  }
}

async function runEmailAutomationPass(options = {}) {
  const kycPendingReminders = await scheduleKycPendingReminderEmails({
    limit: options?.kycLimit,
    delayHours: options?.kycDelayHours,
    periodKey: options?.periodKey
  })
  const challengeExpiryReminders = await scheduleChallengeExpiryReminderEmails({
    limit: options?.challengeExpiryLimit
  })
  const challengeInactivityReminders = await scheduleChallengeInactivityReminderEmails({
    limit: options?.challengeInactivityLimit
  })
  return {
    scheduled: kycPendingReminders.scheduled + challengeExpiryReminders.scheduled + challengeInactivityReminders.scheduled,
    kyc_pending_reminders: kycPendingReminders.scheduled,
    kyc_candidates: kycPendingReminders.candidates,
    challenge_expiry_reminders: challengeExpiryReminders.scheduled,
    challenge_expiry_candidates: challengeExpiryReminders.candidates,
    challenge_inactivity_reminders: challengeInactivityReminders.scheduled,
    challenge_inactivity_candidates: challengeInactivityReminders.candidates
  }
}

/**
 * Counts of jobs that exhausted every retry delay and were parked at 'dead'.
 *
 * markEmailJobRetry moves a job to 'dead' once computeRetryDelayMs returns
 * null, so nothing retries forever — but nothing surfaces it either. A rising
 * dead count is the signal that outbound mail is broken (bad SMTP credentials,
 * a blocked sender domain), which otherwise shows up only as traders reporting
 * they never received a password reset.
 */
async function getDeadLetterStats() {
  const result = await pool.query(
    `SELECT COUNT(*)::int                         AS dead_count,
            MIN(created_at)                       AS oldest_dead,
            MAX(updated_at)                       AS latest_dead,
            COUNT(*) FILTER (
              WHERE updated_at > NOW() - INTERVAL '24 hours'
            )::int                                AS dead_last_24h
       FROM email_jobs
      WHERE status = 'dead'`
  )
  const row = result.rows[0] || {}
  return {
    dead_count: row.dead_count || 0,
    dead_last_24h: row.dead_last_24h || 0,
    oldest_dead: row.oldest_dead || null,
    latest_dead: row.latest_dead || null
  }
}

module.exports = {
  ensureEmailQueueInfrastructure,
  getDeadLetterStats,
  enqueueEmailJob,
  enqueueTemplateEmail,
  enqueuePasswordResetEmail,
  enqueueWelcomeOnboardingEmail,
  enqueueChallengeExpiryReminderEmail,
  enqueueChallengeInactivityReminderEmail,
  enqueuePhasePassedEmail,
  enqueueAccountFailedEmail,
  enqueueAccountExpiredEmail,
  enqueueKycPendingReminderEmail,
  enqueueKycApprovedEmail,
  enqueueKycRejectedEmail,
  enqueuePayoutRequestedEmail,
  enqueuePayoutApprovedEmail,
  enqueuePayoutRejectedEmail,
  enqueueAffiliateCommissionEarnedEmail,
  enqueueAffiliatePayoutRequestedEmail,
  enqueueAffiliatePayoutApprovedEmail,
  enqueueAffiliatePayoutRejectedEmail,
  enqueueCompetitionPrizeVoucherEmail,
  enqueueGiftChallengeVoucherEmail,
  enqueueReferralSeasonPrizeVoucherEmail,
  enqueueCertificateAwardedEmail,
  claimPendingEmailJobs,
  processEmailQueueBatch,
  runEmailAutomationPass,
  __test__: {
    computeRetryDelayMs,
    EMAIL_RETRY_DELAYS_MS,
    EMAIL_SENDING_STALE_MS,
    buildUtcDateKey,
    clampWholeDaysRemaining
  }
}
