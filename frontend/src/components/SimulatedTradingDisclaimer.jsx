import React, { useState } from 'react'
import { renderIcon } from '../utils/iconMap'

export default function SimulatedTradingDisclaimer() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="simulated-disclaimer" style={{
      background: 'color-mix(in srgb, var(--muted) 4%, transparent)',
      border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
      padding: expanded ? '14px 16px' : '10px 16px',
      marginBottom: 'var(--space-5)',
      transition: 'all 0.2s ease'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)' }}>
          <span style={{
            background: 'color-mix(in srgb, var(--muted) 15%, transparent)',
            border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)',
            padding: '2px 8px',
            fontSize: 'var(--fs-2xs)',
            color: 'var(--accent)',
            fontWeight: '600',
            letterSpacing: '0.08em',
            flexShrink: 0
          }}>
            SIMULATED
          </span>
          <p style={{
            color: 'var(--text-muted)',
            fontSize: 'var(--fs-sm)',
            margin: 0,
            lineHeight: '1.5'
          }}>
            This is a demo evaluation account. All trades are simulated — no real money is at risk.
            {!expanded && (
              <button
                onClick={() => setExpanded(true)}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--accent)',
                  fontSize: 'var(--fs-sm)', cursor: 'pointer', padding: '0 0 0 var(--space-1-5)',
                  fontFamily: 'var(--font-ui)', textDecoration: 'underline'
                }}
              >
                Learn more
              </button>
            )}
          </p>
        </div>
        {expanded && (
          <button
            onClick={() => setExpanded(false)}
            aria-label="Dismiss"
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-dim)',
              fontSize: 'var(--fs-xl)', cursor: 'pointer', padding: '0', lineHeight: 1,
              flexShrink: 0
            }}
          >
            {renderIcon('close', { size: 18, color: 'var(--text-secondary)' })}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{
          marginTop: 'var(--space-3)',
          paddingTop: 'var(--space-3)',
          borderTop: '1px solid color-mix(in srgb, var(--muted) 10%, transparent)'
        }}>
          <p style={{
            color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', lineHeight: '1.8', margin: 0
          }}>
            Your evaluation account is a simulated trading environment connected to live market prices.
            Trades are tracked for performance evaluation purposes only — no real orders are placed in
            any financial market, and no real funds are deposited or at risk.
            <br /><br />
            Payouts to successful traders are discretionary performance bonuses paid from company capital.
            They are not withdrawals of deposited funds. Past simulated performance does not guarantee
            results in live markets.
          </p>
        </div>
      )}
    </div>
  )
}
