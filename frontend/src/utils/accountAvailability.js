export const ALL_ACCOUNT_SIZES = Object.freeze([5000, 10000, 25000, 50000, 100000])
export const UNLIMITED_QUOTA = 999999

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function normalizeAvailabilityRow(row = {}, fallbackSize = 0) {
  const size = normalizeNumber(row.size, fallbackSize)
  const quota = row.quota == null ? 0 : normalizeNumber(row.quota, 0)
  const configuredQuota = row.configured_quota == null ? (quota >= UNLIMITED_QUOTA ? null : quota) : normalizeNumber(row.configured_quota, 0)
  const used = normalizeNumber(row.used, 0)
  const isUnlimited = row.is_unlimited === true || quota >= UNLIMITED_QUOTA
  const remaining = isUnlimited
    ? null
    : row.remaining == null
      ? Math.max(0, quota - used)
      : normalizeNumber(row.remaining, 0)
  const locked = row.locked === true || quota === 0 || (!isUnlimited && remaining <= 0)

  return {
    size,
    quota: isUnlimited ? UNLIMITED_QUOTA : quota,
    configured_quota: isUnlimited ? null : configuredQuota,
    used,
    remaining,
    locked,
    is_unlimited: isUnlimited,
    reason: row.reason || (locked ? 'This account size is currently unavailable.' : null),
    period_start: row.period_start || null,
    period_end: row.period_end || null
  }
}

export function normalizeAvailabilityRows(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : []
  return ALL_ACCOUNT_SIZES.map((size) => {
    const matched = sourceRows.find((row) => Number(row?.size) === size)
    return normalizeAvailabilityRow(matched || {}, size)
  })
}

export function buildUnavailableAvailabilityRows(reason = 'Availability is temporarily unavailable.') {
  return ALL_ACCOUNT_SIZES.map((size) => normalizeAvailabilityRow({
    size,
    quota: 0,
    configured_quota: 0,
    used: 0,
    remaining: 0,
    locked: true,
    is_unlimited: false,
    reason
  }, size))
}
