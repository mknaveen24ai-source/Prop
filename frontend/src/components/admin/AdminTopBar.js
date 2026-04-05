import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export default function AdminTopBar({ onMobileMenuClick }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [showNotifications, setShowNotifications] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  
  const notifRef = useRef();
  const profileRef = useRef();

  useEffect(() => {
    function handleClickOutside(e) {
      if (notifRef.current && !notifRef.current.contains(e.target)) setShowNotifications(false);
      if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfile(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Compute breadcrumbs
  const paths = location.pathname.split('/').filter(p => p !== 'admin' && p !== '');
  const currentPage = paths.length > 0 ? paths[0].charAt(0).toUpperCase() + paths[0].slice(1) : 'Dashboard';

  return (
    <header className="admin-topbar">
      <div className="admin-topbar-left">
        <button className="admin-hamburger" onClick={onMobileMenuClick}>☰</button>
        <div className="admin-breadcrumb">
          Admin <span style={{ color: 'var(--admin-border-strong)' }}>/</span> 
          <span className="admin-breadcrumb-active">{currentPage}</span>
        </div>
      </div>

      <div className="admin-topbar-center">
        <span className="admin-search-icon">🔍</span>
        <input 
          type="text" 
          className="admin-search-input" 
          placeholder="Search users, trades, accounts..." 
        />
      </div>

      <div className="admin-topbar-right">
        {/* Notifications */}
        <div style={{ position: 'relative' }} ref={notifRef}>
          <button className="admin-icon-btn" onClick={() => setShowNotifications(p => !p)}>
            🔔
            <span className="badge">3</span>
          </button>
          
          {showNotifications && (
            <div className="admin-dropdown" style={{ width: '320px', padding: 0 }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: '13px' }}>Notifications</strong>
                <button className="admin-btn-ghost" style={{ fontSize: '11px', padding: 0, border: 'none' }}>Mark all read</button>
              </div>
              <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {[
                  { title: 'New KYC Submitted', time: '5m ago', icon: '🪪' },
                  { title: 'Payout Request: $5,240', time: '12m ago', icon: '💸' },
                  { title: 'New Dispute Opened', time: '1h ago', icon: '⚖️' }
                ].map((n, i) => (
                  <div key={i} style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', display: 'flex', gap: '12px', cursor: 'pointer' }} className="admin-dropdown-item">
                    <span style={{ fontSize: '16px' }}>{n.icon}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '13px', color: 'var(--admin-text)' }}>{n.title}</div>
                      <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)' }}>{n.time}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: '8px', textAlign: 'center', borderTop: '1px solid var(--admin-border)' }}>
                <button className="admin-btn-ghost" style={{ fontSize: '12px', border: 'none', width: '100%' }}>View All</button>
              </div>
            </div>
          )}
        </div>

        {/* Profile */}
        <div style={{ position: 'relative' }} ref={profileRef}>
          <button className="admin-icon-btn" style={{ background: 'var(--admin-accent)', color: '#fff', border: 'none' }} onClick={() => setShowProfile(p => !p)}>
            AD
          </button>
          
          {showProfile && (
            <div className="admin-dropdown" style={{ width: '200px' }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--admin-border)', marginBottom: '4px' }}>
                <strong style={{ fontSize: '13px', display: 'block' }}>Administrator</strong>
                <span style={{ fontSize: '11px', color: 'var(--admin-text-muted)' }}>admin@propfirm.com</span>
              </div>
              <button className="admin-dropdown-item" onClick={() => navigate('/admin/settings')}>
                <span style={{ width: '20px' }}>⚙️</span> Platform Settings
              </button>
              <button className="admin-dropdown-item danger" style={{ marginTop: '4px', borderTop: '1px solid var(--admin-border)', borderRadius: '0 0 8px 8px' }}>
                <span style={{ width: '20px' }}>🚪</span> Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
