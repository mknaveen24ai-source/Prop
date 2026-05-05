import React, { useState } from 'react'
import { renderIcon } from '../utils/iconMap'

export default function SimulatedTradingDisclaimer() {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="simulated-disclaimer" style={{
      background: 'rgba(148, 148, 148, 0.04)',
      border: '1px solid rgba(148, 148, 148, 0.15)',
      borderRadius: '8px',
      padding: expanded ? '14px 16px' : '10px 16px',
      marginBottom: '20px',
      transition: 'all 0.2s ease'
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{
            background: 'rgba(148, 148, 148, 0.15)',
            border: '1px solid rgba(148, 148, 148, 0.3)',
            borderRadius: '4px',
            padding: '2px 8px',
            fontSize: '10px',
            color: 'var(--accent)',
            fontWeight: '600',
            letterSpacing: '0.08em',
            flexShrink: 0
          }}>
            SIMULATED
          </span>
          <p style={{
            color: 'var(--text-muted)',
            fontSize: '12px',
            margin: 0,
            lineHeight: '1.5'
          }}>
            This is a demo evaluation account. All trades are simulated — no real money is at risk.
            {!expanded && (
              <button
                onClick={() => setExpanded(true)}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--accent)',
                  fontSize: '12px', cursor: 'pointer', padding: '0 0 0 6px',
                  fontFamily: 'DM Sans, sans-serif', textDecoration: 'underline'
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
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-dim)',
              fontSize: '18px', cursor: 'pointer', padding: '0', lineHeight: 1,
              flexShrink: 0
            }}
          >
            {renderIcon('close', { size: 18, color: 'var(--text-secondary)' })}
          </button>
        )}
      </div>

      {expanded && (
        <div style={{
          marginTop: '12px',
          paddingTop: '12px',
          borderTop: '1px solid rgba(148, 148, 148, 0.1)'
        }}>
          <p style={{
            color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.8', margin: 0
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
