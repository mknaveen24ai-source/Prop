import React from 'react'
import { motion } from 'framer-motion'
import { useTheme } from '../ThemeContext'
import { Headset } from 'lucide-react'
import { renderIcon } from '../utils/iconMap'

const NAV_ITEMS = [
  { id: 'dashboard', icon: 'dashboard', label: 'Dashboard' },
  { id: 'rules', icon: 'journal', label: 'Rules' },
  { id: 'trade', icon: 'trade', label: 'Trade' },
  { id: 'analytics', icon: 'analytics', label: 'Analytics' },
  { id: 'history', icon: 'history', label: 'History' },
  { id: 'kyc', icon: 'kyc', label: 'KYC' },
  { id: 'payouts', icon: 'payouts', label: 'Payouts' },
  { id: 'chat', icon: 'chat', label: 'Live Chat' },
  { id: 'dispute', icon: 'dispute', label: 'Appeal' },
  { id: 'support', icon: 'support', label: 'Support' },
]

export default function Sidebar({ activePage, setActivePage, kycStatus, pendingPayouts = 0, unreadNotifications = 0 }) {
  useTheme()

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
              <motion.div
                key={item.id}
                whileHover={{ x: 3 }}
                transition={{ duration: 0.15 }}
              >
                <button
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
                  <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: '12px' }}>
                    {item.id === 'support'
                      ? <Headset size={16} color={isActive ? 'var(--accent)' : 'var(--text-secondary)'} />
                      : renderIcon(item.icon, { size: 16, color: isActive ? 'var(--accent)' : 'var(--text-secondary)' })}
                  </span>
                  <span style={{ fontWeight: isActive ? 600 : 500 }}>{item.label}</span>

                  {item.id === 'kyc' && kycStatus === 'pending' && (
                    <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--warning)', flexShrink: 0, boxShadow: '0 0 8px var(--warning)' }} />
                  )}
                  {item.id === 'kyc' && (kycStatus === 'not_submitted' || kycStatus === 'rejected') && (
                    <span style={{ marginLeft: 'auto', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--danger)', flexShrink: 0, boxShadow: '0 0 8px var(--danger)' }} />
                  )}

                  {item.id === 'payouts' && pendingPayouts > 0 && (
                    <span className="badge badge-danger" style={{ marginLeft: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: '10px', borderRadius: '20px' }}>
                      {pendingPayouts}
                    </span>
                  )}

                  {item.id === 'dashboard' && unreadNotifications > 0 && (
                    <span className="badge badge-danger" style={{ marginLeft: 'auto', flexShrink: 0, padding: '2px 8px', fontSize: '10px', borderRadius: '20px' }}>
                      {unreadNotifications}
                    </span>
                  )}
                </button>
              </motion.div>
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
              <div style={{ fontSize: '11px', color: 'var(--success)' }}>• Active</div>
            </div>
          </div>
        </div>
      </div>

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
                <span style={{ display: 'inline-flex', lineHeight: 1 }}>
                  {item.id === 'support'
                    ? <Headset size={18} color={isActive ? 'var(--accent)' : 'var(--text-muted)'} />
                    : renderIcon(item.icon, { size: 18, color: isActive ? 'var(--accent)' : 'var(--text-muted)' })}
                </span>
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
