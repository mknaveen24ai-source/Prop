import React from 'react'

/**
 * Ledger Desk boxed stat cell — the "At a Glance" ledger stat pattern
 * (small-caps mono label over a large tabular-mono value), used for
 * account rules, P&L, and admin dashboard numbers alike.
 *
 * tone: 'gain' | 'loss' | 'warn' | 'muted' | undefined (default ink)
 */
export default function StatCell({ label, value, tone, sub, className = '', ...rest }) {
  const valueClasses = ['lx-stat__value', tone ? `lx-stat__value--${tone}` : ''].filter(Boolean).join(' ')

  return (
    <div className={['lx-stat', className].filter(Boolean).join(' ')} {...rest}>
      {label && <div className="lx-stat__label">{label}</div>}
      <div className={valueClasses}>{value}</div>
      {sub && <div className="lx-stat__sub">{sub}</div>}
    </div>
  )
}
