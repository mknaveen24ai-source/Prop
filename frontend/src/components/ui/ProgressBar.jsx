import React from 'react'

// Shared bar-meter markup — lifted out of DashboardAffiliatePage.jsx's
// commission-tier bar and DashboardComparePage.jsx's drawdown gauge, which
// had each hand-rolled the identical role="progressbar" pair. `color` is
// left to the caller (a flat accent for "more is good" progress, or a
// 3-tier tone for "less is good" usage like drawdown) rather than baked in
// here, since the two existing call sites need opposite color logic.
export default function ProgressBar({ value, max = 100, label, color = 'var(--accent)', trackColor = 'var(--bg-surface)', height = 8 }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      style={{ height: `${height}px`, borderRadius: `${height / 2}px`, background: trackColor, overflow: 'hidden' }}
    >
      <div style={{ height: '100%', width: `${pct}%`, background: color, transition: 'width 0.3s' }} />
    </div>
  )
}
