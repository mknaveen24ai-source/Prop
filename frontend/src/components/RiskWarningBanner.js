import React, { useState } from 'react'

export default function RiskWarningBanner() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem('riskWarningDismissed') === 'true'
    } catch {
      return false
    }
  })

  if (dismissed) return null

  function handleDismiss() {
    try {
      sessionStorage.setItem('riskWarningDismissed', 'true')
    } catch {
      // Non-fatal: dismissal will not persist in restricted storage environments.
    }
    setDismissed(true)
  }

  return (
    <div style={{
      background: 'rgba(97, 97, 97, 0.08)',
      borderBottom: '1px solid rgba(97, 97, 97, 0.3)',
      padding: '12px 48px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '16px',
      flexWrap: 'wrap'
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flex: 1 }}>
        <span style={{ fontSize: '12px', fontWeight: 700, flexShrink: 0, marginTop: '2px', color: '#7a7a7a' }}>WARNING</span>
        <p style={{
          color: 'var(--text-muted)',
          fontSize: '12px',
          lineHeight: '1.6',
          margin: 0
        }}>
          <span style={{ color: '#7a7a7a', fontWeight: '600' }}>RISK WARNING: </span>
          This is a simulated trader evaluation platform. All trading accounts are demo accounts -
          no real market orders are placed. Payouts to successful traders are funded from company
          capital, not from user deposits. Past performance in the evaluation environment does not
          guarantee results in live markets. Trading forex and CFDs carries significant risk and is
          not suitable for all individuals. Ensure you fully understand the risks before proceeding.{' '}
          <span style={{ color: 'var(--text-dim)' }}>
            Not available to residents of the US, Canada, or sanctioned jurisdictions.
          </span>
        </p>
      </div>
      <button
        onClick={handleDismiss}
        style={{
          background: 'transparent',
          border: '1px solid rgba(97, 97, 97, 0.3)',
          color: 'var(--text-dim)',
          padding: '4px 12px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
          flexShrink: 0,
          fontFamily: 'DM Sans, sans-serif'
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
