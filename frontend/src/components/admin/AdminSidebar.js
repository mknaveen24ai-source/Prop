import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000';
const adminAxios = axios.create({ baseURL: API_URL, withCredentials: true });

// Socket logic must assume the socket client is passed or imported if global.
// Given constraints, we will accept a socket prop injected by AdminLayout.
export default function AdminSidebar({ isCollapsed, onToggleCollapse, isMobileOpen, onMobileClose, socket }) {
  const navigate = useNavigate();
  const [counts, setCounts] = useState({
    users: 0,
    kyc: 0,
    challenges: 0,
    funded: 0,
    payouts: 0,
    disputes: 0,
    chatUnread: 0
  });

  useEffect(() => {
    adminAxios.get('/api/admin/overview')
      .then(res => {
        const d = res.data || {};
        setCounts(prev => ({
          ...prev,
          users: d.total_users || 0,
          kyc: d.pending_kyc || 0,
          challenges: d.active_challenges || 0,
          funded: d.funded_accounts || 0,
          payouts: d.pending_payouts || 0,
          disputes: d.open_disputes || 0
        }));
      })
      .catch(() => {}); // Silently degrade — sidebar badges are non-critical
  }, []);

  // Socket.io bindings
  useEffect(() => {
    if (!socket) return;
    
    const handleCountUpdate = (data) => {
      // Assuming socket emits { type: 'kyc_submitted' } etc
      if (data.type === 'kyc') setCounts(c => ({ ...c, kyc: c.kyc + 1 }));
      if (data.type === 'payout') setCounts(c => ({ ...c, payouts: c.payouts + 1 }));
      if (data.type === 'dispute') setCounts(c => ({ ...c, disputes: c.disputes + 1 }));
      if (data.type === 'chat') setCounts(c => ({ ...c, chatUnread: c.chatUnread + 1 }));
    };

    socket.on('admin_alert', handleCountUpdate);
    return () => socket.off('admin_alert', handleCountUpdate);
  }, [socket]);

  return (
    <>
      <div className={`admin-sidebar-overlay ${isMobileOpen ? 'active' : ''}`} onClick={onMobileClose} style={{ display: isMobileOpen ? 'block' : 'none' }}></div>
      <aside className={`admin-sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobileOpen ? 'mobile-open' : ''}`}>
        
        <div className="admin-sidebar-header">
          <div className="admin-sidebar-logo">
            <span style={{ color: 'var(--admin-accent)', fontSize: '20px' }}>⚡</span>
            {!isCollapsed && <span>PropFirm Admin</span>}
          </div>
        </div>

        <div className="admin-sidebar-scroll">
          <div className="admin-nav-group">
            <div className="admin-nav-label">Overview</div>
            <NavItem to="/admin" icon="🏠" label="Dashboard" end />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Traders</div>
            <NavItem to="/admin/users" icon="👥" label="All Users" badge={counts.users > 0 ? { val: counts.users, color: 'neutral' } : null} />
            <NavItem to="/admin/kyc" icon="🪪" label="KYC Approvals" badge={counts.kyc > 0 ? { val: counts.kyc, color: 'amber' } : null} />
            <NavItem to="/admin/challenges" icon="🏆" label="Challenges" badge={counts.challenges > 0 ? { val: counts.challenges, color: 'neutral' } : null} />
            <NavItem to="/admin/funded" icon="💎" label="Funded Accounts" badge={counts.funded > 0 ? { val: counts.funded, color: 'gold' } : null} />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Trading</div>
            <NavItem to="/admin/trades" icon="📊" label="All Trades" />
            <NavItem to="/admin/copier" icon="🔁" label="Trade Copier" />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Finance</div>
            <NavItem to="/admin/payouts" icon="💸" label="Payouts" badge={counts.payouts > 0 ? { val: counts.payouts, color: 'amber' } : null} />
            <NavItem to="/admin/pnl" icon="📈" label="Platform P&L" />
          </div>

          <div className="admin-nav-group">
            <div className="admin-nav-label">Platform</div>
            <NavItem to="/admin/settings" icon="⚙️" label="Settings" />
            <NavItem to="/admin/disputes" icon="⚖️" label="Disputes" badge={counts.disputes > 0 ? { val: counts.disputes, color: 'red' } : null} />
            <NavItem to="/admin/chat" icon="💬" label="Support Chat" badge={counts.chatUnread > 0 ? { val: counts.chatUnread, color: 'red' } : null} />
            <NavItem to="/admin/leaderboard" icon="🏅" label="Leaderboard" />
          </div>
        </div>

        <div className="admin-sidebar-footer">
          <div className="admin-user-profile" onClick={() => navigate('/admin/settings')}>
            <div className="admin-avatar">AD</div>
            {!isCollapsed && (
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>Administrator</div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>System Access</div>
              </div>
            )}
          </div>
          <button className="admin-sidebar-toggle" onClick={onToggleCollapse}>
            {isCollapsed ? '▶' : '◀ Collapse'}
          </button>
        </div>

      </aside>
    </>
  );
}

function NavItem({ to, icon, label, badge, end = false }) {
  return (
    <NavLink 
      to={to} 
      end={end}
      className={({ isActive }) => `admin-nav-item ${isActive ? 'active' : ''}`}
    >
      <span className="admin-nav-icon">{icon}</span>
      <span className="admin-nav-text">{label}</span>
      {badge && (
        <span className={`admin-nav-badge ${badge.color}`} style={{ marginLeft: 'auto' }}>
          {badge.val > 99 ? '99+' : badge.val}
        </span>
      )}
    </NavLink>
  );
}
