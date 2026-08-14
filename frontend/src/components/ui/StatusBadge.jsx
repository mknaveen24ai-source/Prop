import React from 'react'
import { ACCOUNT_STATUSES, getStatusColor, getStatusLabel } from '../../utils/constants.js'

/**
 * Trader-side status pill. Colors resolve through utils/statusTone.js (the
 * app's one 5-tone gain/accent/warn/muted/loss map, per the Modern Gazette
 * handoff spec "one map, every representation"); ACCOUNT_STATUSES in
 * utils/constants.js layers curated trader-facing labels on top of that same
 * map and falls through to it for any status the curated table doesn't list.
 * Admin-side equivalent is components/admin/AdminBadge.jsx.
 */
export default function StatusBadge({ status, label, className = '', style }) {
  const color = getStatusColor(status)
  const text = label || getStatusLabel(status)
  return (
    <span
      className={`lx-badge ${className}`.trim()}
      style={{ color, ...style }}
    >
      {text}
    </span>
  )
}

export { ACCOUNT_STATUSES, getStatusColor, getStatusLabel }
