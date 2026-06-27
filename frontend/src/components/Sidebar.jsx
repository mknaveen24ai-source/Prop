import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTheme } from '../ThemeContext'
import { Headset, ChevronLeft, ChevronRight } from 'lucide-react'
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

export default function Sidebar({
  activePage,
  setActivePage,
  kycStatus,
  pendingPayouts = 0,
  unreadNotifications = 0,
  collapsed = false,
  onToggleCollapse,
}) {
  useTheme()

  const sidebarWidth = collapsed ? '64px' : '220px'

  return (
    <>
      <div
        className="sidebar"
        style={{
          background: 'var(--bg-surface)',
          backdropFilter: 'blur(20px)',
          borderRight: '1px solid var(--border)',
          width: sidebarWidth,
          minWidth: sidebarWidth,
          transition: 'width 0.25s cubic-bezier(0.4,0,0.2,1)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {/* Header */}
        <div
          className="sidebar-header"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: collapsed ? '24px 14px' : '24px 20px',
            borderBottom: '1px solid var(--border)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'padding 0.25s',
          }}
        >
          <div
            style={{
              width: '36px',
              height: '36px',
              flexShrink: 0,
              borderRadius: '10px',
              background: 'linear-gradient(135deg, var(--accent), var(--info))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '18px',
              boxShadow: '0 4px 12px var(--accent-glow)',
            }}
          >
            ⚡
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.2 }}
                style={{ overflow: 'hidden', whiteSpace: 'nowrap' }}
              >
                <div style={{ fontSize: '15px', fontWeight: 800, letterSpacing: '0.02em', color: 'var(--text-primary)' }}>
                  PROP FIRM
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Trader Portal</div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Collapse toggle button */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              position: 'absolute',
              top: '72px',
              right: '-12px',
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              zIndex: 10,
              color: 'var(--text-secondary)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
              transition: 'background 0.15s, color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = '#fff' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-surface)'; e.currentTarget.style.color = 'var(--text-secondary)' }}
          >
            {collapsed ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>
        )}

        {/* Navigation */}
        <nav className="sidebar-nav" style={{ padding: collapsed ? '16px 8px' : '24px 12px', transition: 'padding 0.25s' }}>
          <AnimatePresence>
            {!collapsed && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                style={{
                  fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)',
                  textTransform: 'uppercase', letterSpacing: '0.1em',
                  marginBottom: '12px', paddingLeft: '12px',
                }}
              >
                Menu
              </motion.div>
            )}
          </AnimatePresence>

          {NAV_ITEMS.map(item => {
            const isActive = activePage === item.id

            // Badge count for this item
            let badge = null
            if (item.id === 'kyc' && (kycStatus === 'pending' || kycStatus === 'not_submitted' || kycStatus === 'rejected')) {
              badge = (
                <span style={{
                  width: '8px', height: '8px', borderRadius: '50%',
                  background: kycStatus === 'pending' ? 'var(--warning)' : 'var(--danger)',
                  flexShrink: 0, boxShadow: kycStatus === 'pending' ? '0 0 8px var(--warning)' : '0 0 8px var(--danger)',
                  marginLeft: collapsed ? 0 : 'auto',
                  position: collapsed ? 'absolute' : 'static',
                  top: collapsed ? '4px' : undefined,
                  right: collapsed ? '4px' : undefined,
                }} />
              )
            }
            if (item.id === 'payouts' && pendingPayouts > 0) {
              badge = (
                <span className="badge badge-danger" style={{
                  marginLeft: collapsed ? 0 : 'auto', flexShrink: 0,
                  padding: '2px 6px', fontSize: '10px', borderRadius: '20px',
                  position: collapsed ? 'absolute' : 'static',
                  top: collapsed ? '2px' : undefined, right: collapsed ? '2px' : undefined,
                }}>
                  {pendingPayouts}
                </span>
              )
            }
            if (item.id === 'dashboard' && unreadNotifications > 0) {
              badge = (
                <span className="badge badge-danger" style={{
                  marginLeft: collapsed ? 0 : 'auto', flexShrink: 0,
                  padding: '2px 6px', fontSize: '10px', borderRadius: '20px',
                  position: collapsed ? 'absolute' : 'static',
                  top: collapsed ? '2px' : undefined, right: collapsed ? '2px' : undefined,
                }}>
                  {unreadNotifications}
                </span>
              )
            }

            return (
              <motion.div
                key={item.id}
                whileHover={{ x: collapsed ? 0 : 3 }}
                transition={{ duration: 0.15 }}
                style={{ position: 'relative' }}
              >
                <button
                  onClick={() => setActivePage(item.id)}
                  title={collapsed ? item.label : undefined}
                  className={`sidebar-item ${isActive ? 'active' : ''}`}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: isActive ? 'var(--accent-glow)' : 'transparent',
                    color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                    textAlign: 'left',
                    borderRadius: '10px',
                    padding: collapsed ? '12px 0' : '12px 14px',
                    marginBottom: '4px',
                    position: 'relative',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    transition: 'padding 0.25s, background 0.15s, color 0.15s',
                  }}
                >
                  {isActive && (
                    <div style={{
                      position: 'absolute', left: '-8px', top: '10%',
                      height: '80%', width: '4px',
                      background: 'var(--accent)', borderRadius: '0 4px 4px 0'
                    }} />
                  )}

                  <span style={{ display: 'inline-flex', alignItems: 'center', marginRight: collapsed ? 0 : '12px', flexShrink: 0 }}>
                    {item.id === 'support'
                      ? <Headset size={16} color={isActive ? 'var(--accent)' : 'var(--text-secondary)'} />
                      : renderIcon(item.icon, { size: 16, color: isActive ? 'var(--accent)' : 'var(--text-secondary)' })}
                  </span>

                  <AnimatePresence>
                    {!collapsed && (
                      <motion.span
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.2 }}
                        style={{ fontWeight: isActive ? 600 : 500, overflow: 'hidden', whiteSpace: 'nowrap', flex: 1 }}
                      >
                        {item.label}
                      </motion.span>
                    )}
                  </AnimatePresence>

                  {!collapsed && badge}
                </button>

                {/* In collapsed mode, show badge outside the button */}
                {collapsed && badge}
              </motion.div>
            )
          })}
        </nav>

        {/* Footer */}
        <div className="sidebar-footer" style={{ borderTop: '1px solid var(--border)', padding: collapsed ? '16px 8px' : '20px 16px', transition: 'padding 0.25s' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: collapsed ? '8px' : '12px',
            borderRadius: '12px',
            background: 'var(--bg-hover)',
            cursor: 'pointer',
            border: '1px solid var(--border-strong)',
            justifyContent: collapsed ? 'center' : 'flex-start',
            transition: 'padding 0.25s',
          }}>
            <div style={{
              width: '32px', height: '32px', flexShrink: 0,
              borderRadius: '50%', background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: '12px', fontWeight: 600,
            }}>
              TR
            </div>
            <AnimatePresence>
              {!collapsed && (
                <motion.div
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.2 }}
                  style={{ flex: 1, overflow: 'hidden' }}
                >
                  <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    Trader
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--success)' }}>• Active</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Mobile bottom nav — unchanged */}
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
