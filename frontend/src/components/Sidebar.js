import React from 'react'
import { useTheme } from '../ThemeContext'

const NAV_ITEMS = [
  { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  { id: 'trade',     icon: '📈', label: 'Trade' },
  { id: 'analytics', icon: '🧠', label: 'Analytics' },
  { id: 'history',   icon: '📋', label: 'History' },
  { id: 'kyc',       icon: '🪪', label: 'KYC' },
  { id: 'payouts',   icon: '💰', label: 'Payouts' },
  { id: 'chat',      icon: '💬', label: 'Live Chat' },
  { id: 'dispute',   icon: '⚖️', label: 'Appeal' },
  { id: 'support',   icon: '🎧', label: 'Support' },
]

export default function Sidebar({ activePage, setActivePage, kycStatus, pendingPayouts = 0, unreadNotifications = 0 }) {
  // FIX: was destructuring { theme, toggleTheme } but theme was never used in
  // this component — only toggleTheme via ThemeToggle. Removed the dead import
  // to keep the lint output clean and make the code easier to read.
  useTheme() // keeps the subscription alive in case a future version needs it

  return (
    <>
      {/* ── Desktop Sidebar ── */}
      <div className="sidebar-desktop">
        <div style={{
          padding: '24px 20px 8px',
          borderBottom: '1px solid var(--navy-border)',
          marginBottom: '8px'
        }}>
          <div style={{
            fontSize: '11px', color: 'var(--text-dim)',
            letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: '600'
          }}>
            Navigation
          </div>
        </div>

        <nav style={{ flex: 1, padding: '8px 12px' }}>
          {NAV_ITEMS.map(item => {
            const isActive = activePage === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActivePage(item.id)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '12px 16px',
                  marginBottom: '4px',
                  borderRadius: '8px',
                  border: 'none',
                  background: isActive ? 'rgba(148, 148, 148, 0.12)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: isActive ? '600' : '400',
                  fontFamily: 'DM Sans, sans-serif',
                  textAlign: 'left',
                  transition: 'all 0.15s',
                  borderLeft: isActive ? '3px solid var(--accent)' : '3px solid transparent',
                  position: 'relative'
                }}
                onMouseEnter={e => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'rgba(148, 148, 148, 0.06)'
                    e.currentTarget.style.color = 'var(--text)'
                  }
                }}
                onMouseLeave={e => {
                  if (!isActive) {
                    e.currentTarget.style.background = 'transparent'
                    e.currentTarget.style.color = 'var(--text-muted)'
                  }
                }}
              >
                <span style={{ fontSize: '18px' }}>{item.icon}</span>
                <span>{item.label}</span>

                {/* KYC badge */}
                {item.id === 'kyc' && kycStatus === 'pending' && (
                  <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
                )}
                {item.id === 'kyc' && (kycStatus === 'not_submitted' || kycStatus === 'rejected') && (
                  <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                )}

                {/* Payouts badge */}
                {item.id === 'payouts' && pendingPayouts > 0 && (
                  <span style={{
                    marginLeft: 'auto', background: 'var(--accent)', color: 'var(--navy)',
                    borderRadius: '99px', fontSize: '10px', fontWeight: '700',
                    padding: '1px 6px', flexShrink: 0
                  }}>
                    {pendingPayouts}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div style={{
          padding: '16px 20px',
          borderTop: '1px solid var(--navy-border)',
          fontSize: '11px',
          color: 'var(--text-dim)'
        }}>
          <div style={{ marginBottom: '4px' }}>PROP FIRM</div>
          <div>v1.0.0</div>
        </div>
      </div>

      {/* ── Mobile Bottom Tab Bar ── */}
      <nav className="sidebar-mobile-bottom">
        {NAV_ITEMS.map(item => {
          const isActive = activePage === item.id
          return (
            <button
              key={item.id}
              onClick={() => setActivePage(item.id)}
              className="mobile-tab-btn"
              style={{
                color: isActive ? 'var(--accent)' : 'var(--text-muted)',
                borderTop: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                background: 'transparent',
              }}
            >
              <span style={{ position: 'relative', display: 'inline-block' }}>
                <span style={{ fontSize: '20px', lineHeight: 1 }}>{item.icon}</span>
                {item.id === 'kyc' && (kycStatus === 'pending' || kycStatus === 'not_submitted' || kycStatus === 'rejected') && (
                  <span style={{
                    position: 'absolute', top: '-3px', right: '-5px',
                    width: '7px', height: '7px', borderRadius: '50%',
                    background: kycStatus === 'pending' ? 'var(--accent)' : 'var(--red)',
                    border: '1px solid var(--navy)'
                  }} />
                )}
                {item.id === 'payouts' && pendingPayouts > 0 && (
                  <span style={{
                    position: 'absolute', top: '-4px', right: '-8px',
                    background: 'var(--accent)', color: 'var(--navy)',
                    borderRadius: '99px', fontSize: '9px', fontWeight: '700',
                    padding: '0 4px', lineHeight: '14px', minWidth: '14px',
                    textAlign: 'center'
                  }}>
                    {pendingPayouts}
                  </span>
                )}
              </span>
              <span style={{ fontSize: '10px', fontWeight: isActive ? '600' : '400', marginTop: '3px' }}>
                {item.label}
              </span>
            </button>
          )
        })}
      </nav>
    </>
  )
}