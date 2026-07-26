import React, { useEffect, useRef, useState } from 'react'
import { Menu } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router-dom'
import { renderIcon } from '../../utils/iconMap'

export default function AdminTopBar({ onMobileMenuClick, onLogout, session }) {
  const location = useLocation()
  const navigate = useNavigate()
  const [showNotifications, setShowNotifications] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  const notifRef = useRef()
  const profileRef = useRef()

  useEffect(() => {
    function handleClickOutside(event) {
      if (notifRef.current && !notifRef.current.contains(event.target)) setShowNotifications(false)
      if (profileRef.current && !profileRef.current.contains(event.target)) setShowProfile(false)
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const paths = location.pathname.split('/').filter((part) => part !== 'admin' && part !== '')
  const currentPage = paths.length > 0
    ? paths[0].charAt(0).toUpperCase() + paths[0].slice(1)
    : 'Dashboard'

  const roleLabel = session?.role === 'super_admin'
    ? 'Platform Owner'
    : 'Administrator'
  const scopeLabel = 'Global Scope'
  const authSourceLabel = session?.auth_source === 'platform_admin'
    ? 'DB Admin'
    : session?.auth_source === 'env_fallback'
      ? 'Bootstrap'
      : 'Unknown'
  const initials = String(session?.full_name || session?.email || 'AD')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'AD'

  const notifications = [
    { title: 'New KYC Submitted', time: '5m ago', icon: 'kyc' },
    { title: 'Payout Request: $5,240', time: '12m ago', icon: 'payouts' },
    { title: 'New Dispute Opened', time: '1h ago', icon: 'dispute' }
  ]

  return (
    <header className="admin-topbar">
      <div className="admin-topbar-left">
        <button className="admin-hamburger" onClick={onMobileMenuClick}>
          <Menu size={18} color="var(--admin-text)" />
        </button>
        <div className="admin-breadcrumb">
          Admin <span style={{ color: 'var(--admin-border-strong)' }}>/</span>
          <span className="admin-breadcrumb-active">{currentPage}</span>
        </div>
      </div>

      <div className="admin-topbar-center">
        <span className="admin-search-icon">
          {renderIcon('search', { size: 14, color: 'var(--admin-text-faint)' })}
        </span>
        <input
          type="text"
          className="admin-search-input"
          placeholder="Search users, trades, accounts..."
        />
      </div>

      <div className="admin-topbar-right">
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '2px',
          padding: '8px 12px',
          border: '1px solid var(--admin-border)',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.02)'
        }}>
          <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
            {roleLabel}
          </div>
          <div style={{ fontSize: '12px', color: 'var(--admin-text)' }}>
            {scopeLabel} • {authSourceLabel}
          </div>
        </div>

        <div style={{ position: 'relative' }} ref={notifRef}>
          <button className="admin-icon-btn" onClick={() => setShowNotifications((visible) => !visible)}>
            {renderIcon('bell', { size: 16, color: 'var(--admin-text)' })}
            <span className="badge">3</span>
          </button>

          {showNotifications && (
            <div className="admin-dropdown" style={{ width: '320px', padding: 0 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: '13px' }}>Notifications</strong>
                <button className="admin-btn-ghost" style={{ fontSize: '11px', padding: 0, border: 'none' }}>Mark all read</button>
              </div>
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {notifications.map((notification, index) => (
                  <div key={index} style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', display: 'flex', gap: '12px', cursor: 'pointer' }} className="admin-dropdown-item">
                    <span style={{ display: 'inline-flex' }}>
                      {renderIcon(notification.icon, { size: 16, color: 'var(--admin-accent)' })}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', color: 'var(--admin-text)' }}>{notification.title}</div>
                      <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>{notification.time}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ position: 'relative' }} ref={profileRef}>
          <button className="admin-icon-btn" style={{ background: 'var(--admin-accent)', color: 'var(--paper)', border: 'none' }} onClick={() => setShowProfile((visible) => !visible)}>
            {initials}
          </button>

          {showProfile && (
            <div className="admin-dropdown" style={{ width: '220px' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', marginBottom: '4px' }}>
                <strong style={{ fontSize: '13px', display: 'block' }}>{session?.full_name || roleLabel}</strong>
                <span style={{ fontSize: '11px', color: 'var(--admin-text-muted)' }}>{session?.email || roleLabel}</span>
                <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--admin-text-faint)' }}>
                  {roleLabel} • {scopeLabel} • {authSourceLabel}
                </div>
              </div>
              <button className="admin-dropdown-item" onClick={() => navigate('/admin/access')}>
                <span style={{ width: '20px', display: 'inline-flex' }}>
                  {renderIcon('key', { size: 14, color: 'var(--admin-text-faint)' })}
                </span>
                Access &amp; Security
              </button>
              <button className="admin-dropdown-item" onClick={() => navigate('/admin/settings')}>
                <span style={{ width: '20px', display: 'inline-flex' }}>
                  {renderIcon('settings', { size: 14, color: 'var(--admin-text-faint)' })}
                </span>
                Settings
              </button>
              <button
                className="admin-dropdown-item danger"
                style={{ marginTop: '4px', borderTop: '1px solid var(--admin-border)', borderRadius: '0 0 8px 8px' }}
                onClick={async () => {
                  await onLogout?.()
                  setShowProfile(false)
                }}
              >
                <span style={{ width: '20px', display: 'inline-flex' }}>
                  {renderIcon('logout', { size: 14, color: 'var(--admin-danger)' })}
                </span>
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
