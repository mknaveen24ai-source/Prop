import React, { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Shield } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { renderIcon } from '../../utils/iconMap'

export default function AdminSidebar({
  adminAxios,
  session,
  isCollapsed,
  onToggleCollapse,
  isMobileOpen,
  onMobileClose,
  socket
}) {
  const navigate = useNavigate()
  const [counts, setCounts] = useState({
    users: 0,
    kyc: 0,
    challenges: 0,
    funded: 0,
    payouts: 0,
    violations: 0
  })

  const isSuperAdmin = session?.role === 'super_admin'

  useEffect(() => {
    if (!adminAxios) return undefined

    const refreshCounts = () => {
      Promise.all([
        adminAxios.get('/api/admin/overview').catch(() => ({ data: {} })),
        adminAxios.get('/api/admin/violations/summary').catch(() => ({ data: { totals: {} } }))
      ])
        .then(([overviewRes, violationsRes]) => {
          const overview = overviewRes.data || {}
          const totals = violationsRes.data?.totals || {}
          setCounts((current) => ({
            ...current,
            users: overview.total_users || 0,
            kyc: overview.pending_kyc || 0,
            challenges: overview.active_challenges || 0,
            funded: overview.funded_accounts || 0,
            payouts: overview.pending_payouts || 0,
            violations: totals.total_open || 0
          }))
        })
        .catch(() => {})
    }

    refreshCounts()

    if (!socket) return undefined

    socket.on('admin_violation_updated', refreshCounts)
    socket.on('admin_enforcement_event', refreshCounts)
    socket.on('admin_command_center_updated', refreshCounts)
    socket.on('opposing_trade_detected', refreshCounts)

    return () => {
      socket.off('admin_violation_updated', refreshCounts)
      socket.off('admin_enforcement_event', refreshCounts)
      socket.off('admin_command_center_updated', refreshCounts)
      socket.off('opposing_trade_detected', refreshCounts)
    }
  }, [adminAxios, socket])

  useEffect(() => {
    if (!socket) return undefined

    const handleCountUpdate = (data) => {
      if (data.type === 'kyc') setCounts((current) => ({ ...current, kyc: current.kyc + 1 }))
      if (data.type === 'payout') setCounts((current) => ({ ...current, payouts: current.payouts + 1 }))
      if (data.type === 'violation') setCounts((current) => ({ ...current, violations: current.violations + 1 }))
    }

    socket.on('admin_alert', handleCountUpdate)
    return () => socket.off('admin_alert', handleCountUpdate)
  }, [socket])

  const profileName = session?.full_name || session?.email || 'Administrator'
  const profileRole = isSuperAdmin ? 'Platform Owner' : 'Administrator'
  const initials = profileName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || 'AD'

  return (
    <>
      <div className={`admin-sidebar-overlay ${isMobileOpen ? 'active' : ''}`} onClick={onMobileClose} style={{ display: isMobileOpen ? 'block' : 'none' }} />
      <aside className={`admin-sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobileOpen ? 'mobile-open' : ''}`}>
        <div className="admin-sidebar-header">
          <div className="admin-sidebar-logo">
            <Shield size={18} color="var(--admin-accent)" />
            {!isCollapsed && <span>Platform Admin</span>}
          </div>
        </div>

        <div className="admin-sidebar-scroll">
          <div className="admin-nav-group">
            <div className="admin-nav-label">Overview</div>
            <NavItem to="/admin" icon="dashboard" label="Dashboard" end />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Traders</div>
            <NavItem to="/admin/users" icon="users" label="All Users" badge={counts.users > 0 ? { val: counts.users, color: 'neutral' } : null} />
            <NavItem to="/admin/kyc" icon="kyc" label="KYC Approvals" badge={counts.kyc > 0 ? { val: counts.kyc, color: 'amber' } : null} />
            <NavItem to="/admin/challenges" icon="challenges" label="Challenges" badge={counts.challenges > 0 ? { val: counts.challenges, color: 'neutral' } : null} />
            <NavItem to="/admin/promotion-reviews" icon="approve" label="Promotion Review" />
            <NavItem to="/admin/funded" icon="funded" label="Funded Accounts" badge={counts.funded > 0 ? { val: counts.funded, color: 'gold' } : null} />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Trading</div>
            <NavItem to="/admin/trades" icon="trades" label="All Trades" />
            <NavItem to="/admin/competitions" icon="leaderboard" label="Competitions" />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Analytics</div>
            <NavItem to="/admin/analytics" icon="analytics" label="Analytics" />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Support</div>
            <NavItem to="/admin/chat" icon="chat" label="Chat" />
            <NavItem to="/admin/disputes" icon="dispute" label="Disputes" />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Finance</div>
            <NavItem to="/admin/payouts" icon="payouts" label="Payouts" badge={counts.payouts > 0 ? { val: counts.payouts, color: 'amber' } : null} />
            <NavItem to="/admin/affiliates" icon="affiliate" label="Affiliates" />
            <NavItem to="/admin/affiliates/payouts" icon="affiliate" label="Affiliate Payouts" />
            {isSuperAdmin && <NavItem to="/admin/pnl" icon="pnl" label="Platform P&L" />}
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Platform</div>
            {isSuperAdmin && <NavItem to="/admin/command-center" icon="command" label="Command Center" />}
            <NavItem to="/admin/access" icon="key" label="Access & Security" />
            <NavItem to="/admin/settings" icon="settings" label="Settings" />
            <NavItem to="/admin/trading-economics" icon="settings" label="Trading Economics" />
            {isSuperAdmin && <NavItem to="/admin/step-models" icon="challenges" label="Challenge Models" />}
            <NavItem to="/admin/violations" icon="violations" label="Violations" badge={counts.violations > 0 ? { val: counts.violations, color: 'red' } : null} />
            <NavItem to="/admin/leaderboard" icon="leaderboard" label="Leaderboard" />
          </div>
        </div>

        <div className="admin-sidebar-footer">
          <div className="admin-user-profile" onClick={() => navigate('/admin/settings')}>
            <div className="admin-avatar">{initials}</div>
            {!isCollapsed && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--ink)' }}>{profileName}</div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>{profileRole}</div>
              </div>
            )}
          </div>
          <button className="admin-sidebar-toggle" onClick={onToggleCollapse}>
            {isCollapsed
              ? <ChevronRight size={14} color="var(--admin-text-faint)" />
              : <><ChevronLeft size={14} color="var(--admin-text-faint)" /><span>Collapse</span></>}
          </button>
        </div>
      </aside>
    </>
  )
}

function NavItem({ to, icon, label, badge, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}
    >
      {({ isActive }) => (
        <>
          <span className="admin-nav-icon">
            {renderIcon(icon, { size: 16, color: isActive ? 'var(--admin-accent)' : 'var(--admin-text-faint)' })}
          </span>
          <span className="admin-nav-text">{label}</span>
          {badge && (
            <span className={`admin-nav-badge ${badge.color}`} style={{ marginLeft: 'auto' }}>
              {badge.val > 99 ? '99+' : badge.val}
            </span>
          )}
        </>
      )}
    </NavLink>
  )
}
