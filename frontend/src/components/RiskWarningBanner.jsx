import React, { useLayoutEffect, useRef, useState } from 'react'
import { getMemoryItem, setMemoryItem } from '../utils/memoryStore'

export default function RiskWarningBanner({ floating = false }) {
  const bannerRef = useRef(null)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return getMemoryItem('riskWarningDismissed') === 'true'
    } catch {
      return false
    }
  })

  useLayoutEffect(() => {
    if (!floating) return undefined

    const root = document.documentElement
    const setHeight = () => {
      const height = dismissed
        ? 0
        : Math.ceil(bannerRef.current?.getBoundingClientRect().height || 0)
      root.style.setProperty('--risk-warning-height', `${height}px`)
    }

    setHeight()

    let resizeObserver
    if (!dismissed && bannerRef.current && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(setHeight)
      resizeObserver.observe(bannerRef.current)
    }

    window.addEventListener('resize', setHeight)

    return () => {
      if (resizeObserver) resizeObserver.disconnect()
      window.removeEventListener('resize', setHeight)
      root.style.setProperty('--risk-warning-height', '0px')
    }
  }, [dismissed, floating])

  if (dismissed) return null

  function handleDismiss() {
    try {
      setMemoryItem('riskWarningDismissed', 'true')
    } catch {
      // Non-fatal: dismissal will not persist in restricted storage environments.
    }
    setDismissed(true)
  }

  return (
    <div
      ref={bannerRef}
      className={`risk-warning-banner${floating ? ' risk-warning-banner-floating' : ''}`}
      style={{
      background: 'color-mix(in srgb, var(--muted) 8%, transparent)',
      borderBottom: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
      padding: floating ? 'calc(12px + env(safe-area-inset-top)) 48px 12px' : '12px 48px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 'var(--space-4)',
      flexWrap: 'wrap'
    }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)', flex: 1 }}>
        <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 700, flexShrink: 0, marginTop: '2px', color: 'var(--muted)' }}>WARNING</span>
        <p style={{
          color: 'var(--text-muted)',
          fontSize: 'var(--fs-sm)',
          lineHeight: '1.6',
          margin: 0
        }}>
          <span style={{ color: 'var(--muted)', fontWeight: '600' }}>RISK WARNING: </span>
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
          border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
          color: 'var(--text-dim)',
          padding: 'var(--space-1) var(--space-3)',
          cursor: 'pointer',
          fontSize: 'var(--fs-sm)',
          flexShrink: 0,
          fontFamily: 'var(--font-ui)'
        }}
      >
        Dismiss
      </button>
    </div>
  )
}
