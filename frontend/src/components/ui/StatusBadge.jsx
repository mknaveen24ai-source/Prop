import React from 'react'
import { ACCOUNT_STATUSES, getStatusColor, getStatusLabel } from '../../utils/constants.js'

/**
 * Trader-side status pill. Single source of truth: ACCOUNT_STATUSES in
 * utils/constants.js — every status pill, dot and colored figure for
 * account/challenge/payout/affiliate status reads off that one map, per the
 * Modern Gazette handoff spec ("one map, every representation"). Admin-side
 * equivalent is components/admin/AdminBadge.jsx.
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
