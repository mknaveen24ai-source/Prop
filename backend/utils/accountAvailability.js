const VALID_ACCOUNT_SIZES = [5000, 10000, 25000, 50000, 100000, 200000, 400000]
const UNLIMITED_QUOTA = 999999

function quotaKey(size) {
  return `quota_${size}`
}

function buildAvailabilityPeriodMeta(settings = {}) {
  return {
    period_start: settings.max_accounts_period_start || null,
    period_end: settings.max_accounts_period_end || null
  }
}

function parseQuotaSetting(settings, size) {
  const rawValue = settings?.[quotaKey(size)]
  const parsed = rawValue !== undefined && rawValue !== null && rawValue !== ''
    ? parseInt(rawValue, 10)
    : 0
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

async function countUsedQuotaSlots(db, size, settings = {}) {
  const periodStart = settings.max_accounts_period_start
  const periodEnd = settings.max_accounts_period_end

  if (periodStart && periodEnd) {
    const result = await db.query(
      `SELECT COUNT(*) AS count
         FROM accounts
        WHERE account_size = $1
          AND created_at >= $2::date
          AND created_at < ($3::date + INTERVAL '1 day')`,
      [size, periodStart, periodEnd]
    )
    return parseInt(result.rows[0]?.count || 0, 10)
  }

  const result = await db.query(
    `SELECT COUNT(*) AS count
       FROM accounts
      WHERE account_size = $1`,
    [size]
  )
  return parseInt(result.rows[0]?.count || 0, 10)
}

async function buildAccountAvailability(db, settings = {}) {
  const periodMeta = buildAvailabilityPeriodMeta(settings)
  return Promise.all(VALID_ACCOUNT_SIZES.map(async (size) => {
    const configuredQuota = parseQuotaSetting(settings, size)

    if (configuredQuota === 0) {
      return {
        size,
        quota: 0,
        configured_quota: 0,
        used: 0,
        remaining: 0,
        locked: true,
        is_unlimited: false,
        reason: 'This account size is currently unavailable.',
        ...periodMeta
      }
    }

    const used = await countUsedQuotaSlots(db, size, settings)
    const isUnlimited = configuredQuota >= UNLIMITED_QUOTA
    const remaining = isUnlimited ? null : Math.max(0, configuredQuota - used)
    const locked = !isUnlimited && remaining === 0

    return {
      size,
      quota: isUnlimited ? UNLIMITED_QUOTA : configuredQuota,
      configured_quota: isUnlimited ? null : configuredQuota,
      used,
      remaining,
      locked,
      is_unlimited: isUnlimited,
      reason: locked
        ? `All ${configuredQuota} slots for the $${size.toLocaleString('en-US')} account are filled${periodStartLabel(settings)}.`
        : null,
      ...periodMeta
    }
  }))
}

function periodStartLabel(settings = {}) {
  return settings.max_accounts_period_start && settings.max_accounts_period_end
    ? ' for this period'
    : ''
}

module.exports = {
  UNLIMITED_QUOTA,
  VALID_ACCOUNT_SIZES,
  buildAvailabilityPeriodMeta,
  buildAccountAvailability,
  countUsedQuotaSlots,
  parseQuotaSetting,
  quotaKey
}
