import React from 'react'
import { useBranding } from '../../BrandingContext'

// Purely decorative — not wired to a live price feed. There's no public,
// unauthenticated market-data endpoint yet, and the live instrument ticker
// in TradingPanel.jsx needs a `prices` prop + order-form context that don't
// exist pre-login.
const TICKER_ITEMS = [
  { symbol: 'S&P 500', change: '+0.42%', up: true },
  { symbol: 'NASDAQ', change: '+0.68%', up: true },
  { symbol: 'GOLD', change: '-0.15%', up: false },
]

export default function AuthMasthead({ eyebrow = 'Section A · Members', maxWidth = 460 }) {
  const { tenant } = useBranding()

  return (
    <div className="auth-masthead" style={{ maxWidth }}>
      <div className="auth-masthead-top">
        <span className="auth-eyebrow">{eyebrow}</span>
        <div className="auth-masthead-ticker" aria-hidden="true">
          {TICKER_ITEMS.map((item, i) => (
            <React.Fragment key={item.symbol}>
              {i > 0 && <span className="auth-masthead-divider">·</span>}
              <span className="auth-masthead-item">
                {item.symbol}
                <span className={`auth-masthead-change ${item.up ? 'is-up' : 'is-down'}`}>{item.change}</span>
              </span>
            </React.Fragment>
          ))}
        </div>
      </div>
      <div className="auth-masthead-name">{tenant?.logo_text || tenant?.name || 'PropFirm'}</div>
    </div>
  )
}
