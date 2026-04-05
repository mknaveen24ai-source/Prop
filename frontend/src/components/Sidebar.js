import React from 'react'
import { useTheme } from '../ThemeContext'
import packageJson from '../../package.json'

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
      <div className="sidebar" style={{
        background: 'var(--bg-surface)',
        backdropFilter: 'blur(20px)',
        borderRight: '1px solid var(--border)'
      }}>
        <div className="sidebar-header" style={{
          display: 'flex', alignItems: 'center', gap: '12px', padding: '24px 20px', borderBottom: '1px solid var(--border)'
        }}>
          <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'linear-gradient(135deg, var(--accent), var(--info))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '18px', boxShadow: '0 4px 12px var(--accent-glow)' }}>
            ⚡
          </div>
          <div>
            <div style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '0.02em', color: 'var(--text-primary)' }}>PROP FIRM</div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Trader Portal</div>
          </div>
        </div>

        <nav className="sidebar-nav" style={{ padding: '24px 12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '12px', paddingLeft: '12px' }}>
            Menu
          </div>
          {NAV_ITEMS.map(item => {
            const isActive = activePage === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActivePage(item.id)}
                className={`sidebar-item ${isActive ? 'active' : ''}`}
                style={{
                  width: '100%',
                  border: 'none',
                  background: isActive ? 'var(--accent-glow)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  textAlign: 'left',
                  borderRadius: '10px',
                  padding: '12px 14px',
                  marginBottom: '4px',
                  position: 'relative'
                }}
              >
                {isActive && (
                  <div style={{ position: 'absolute', left: '-12px', top: '10%', height: '80%', width: '4px', background: 'var(--accent)', borderRadius: '0 4px 4px 0' }} />
                )}
                <span style={{ fontSize: '18px', marginRight: '12px' }}>{item.icon}</span>
                <span style={{ fontWeight: isActive ? 600 : 500 }}>{item.label}</span>

                {/* KYC badge */}
                {item.id === 'kyc' && kycStatus === 'pending' && (
                  <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--warning)', flexShrink: 0, boxShadow: '0 0 8px var(--warning)' }} />
                )}
                {item.id === 'kyc' && (kycStatus === 'not_submitted' || kycStatus === 'rejected') && (
                  <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)', flexShrink: 0, boxShadow: '0 0 8px var(--danger)' }} />
                )}

                {/* Payouts badge */}
                {item.id === 'payouts' && pendingPayouts > 0 && (
                  <span className="badge badge-danger" style={{ marginLeft: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: '10px', borderRadius: '20px' }}>
                    {pendingPayouts}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="sidebar-footer" style={{ borderTop: '1px solid var(--border)', padding: '20px 16px' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '12px', background: 'var(--bg-hover)', cursor: 'pointer', border: '1px solid var(--border-strong)' }}>
             <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '12px', fontWeight: 600 }}>
               TR
             </div>
             <div style={{ flex: 1, overflow: 'hidden' }}>
               <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Trader</div>
               <div style={{ fontSize: '11px', color: 'var(--success)' }}>● Active</div>
             </div>
           </div>
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