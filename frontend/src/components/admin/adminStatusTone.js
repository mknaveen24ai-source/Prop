/**
 * Admin-side status pill/dot/chart-segment tone resolution. Thin wrapper
 * around utils/statusTone.js — the single 5-tone (gain/accent/warn/muted/
 * loss) map shared with the trader side (utils/constants.js ACCOUNT_STATUSES),
 * per the Modern Gazette handoff spec: "one map, every representation."
 * AdminBadge.jsx renders the pill; anything that needs a raw color instead
 * (border accents, donut/pie slice fills) should call getAdminStatusColor
 * rather than keeping its own parallel lookup.
 */
import { normalizeStatusTone, getStatusToneColor } from '../../utils/statusTone.js'

/** Normalize any status string/label to one of the 5 tone keys (gain/accent/warn/muted/loss). */
export function normalizeAdminTone(status) {
  return normalizeStatusTone(status)
}

/** Raw CSS color for a status — for chart segments, border accents, dots. */
export function getAdminStatusColor(status) {
  return getStatusToneColor(status)
}
