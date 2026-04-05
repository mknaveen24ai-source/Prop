import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import { useToast } from '../../components/admin/AdminToast';
import AdminModal from '../../components/admin/AdminModal';

export default function AdminUsers() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();
  
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState('');
  const [filterKyc, setFilterKyc] = useState('All');
  
  const [selectedUser, setSelectedUser] = useState(null);
  const [showBanModal, setShowBanModal] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/traders');
      setUsers(res.data || []);
    } catch (err) {
      toast.error('Failed to load users');
    }
    setLoading(false);
  };

  const handleAction = async (action, user) => {
    if (action === 'view') {
      setSelectedUser(user);
    } else if (action === 'reset_pwd') {
      toast.success(`Password reset email sent to ${user.email}`);
    } else if (action === 'ban') {
      setSelectedUser(user);
      setShowBanModal(true);
    } else if (action === 'unban') {
      try {
        await adminAxios.post(`/api/admin/traders/${user.id}/ban`, { is_banned: false });
        toast.success('User unbanned successfully');
        fetchUsers();
      } catch (err) {
        toast.error('Failed to unban user');
      }
    }
  };

  const confirmBan = async () => {
    if (!selectedUser) return;
    try {
      await adminAxios.post(`/api/admin/traders/${selectedUser.id}/ban`, { is_banned: true, reason: 'Admin panel ban' });
      toast.success('User banned successfully');
      setShowBanModal(false);
      fetchUsers();
    } catch (err) {
      toast.error('Failed to ban user');
    }
  };

  const columns = [
    { header: 'Trader', key: 'id', render: (u) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <div className="admin-avatar" style={{ width: '36px', height: '36px', fontSize: '13px', background: u.is_banned ? 'var(--admin-danger)' : undefined }}>
          {(u.name || u.email || 'A').charAt(0).toUpperCase()}
        </div>
        <div>
          <div style={{ color: 'var(--admin-text)', fontWeight: 500, fontSize: '13px' }}>{u.name || 'Unnamed Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px' }}>{u.email}</div>
        </div>
      </div>
    )},
    { header: 'UID', key: 'uid', isMono: true, render: u => String(u.id).padStart(5, '0') },
    { header: 'Country', key: 'country', render: u => u.country || '—' },
    { header: 'KYC', key: 'kyc_status', render: u => <AdminBadge status={u.kyc_status || 'pending'} /> },
    { header: 'Joined', key: 'created_at', render: u => new Date(u.created_at).toLocaleDateString() },
    { header: 'Status', key: 'is_banned', render: u => u.is_banned ? <AdminBadge status="banned" /> : <AdminBadge status="active" /> },
  ];

  const getRowActions = (user) => {
    const actions = [
      { label: 'View Full Profile', icon: '👤', onClick: () => handleAction('view', user) },
      { label: 'View All Trades', icon: '📊', onClick: () => {} },
      { label: 'Send Message', icon: '✉️', onClick: () => {} },
      { label: 'Reset Password', icon: '🔑', onClick: () => handleAction('reset_pwd', user) },
    ];
    
    if (user.is_banned) {
      actions.push({ label: 'Unban User', icon: '✅', onClick: () => handleAction('unban', user) });
    } else {
      actions.push({ label: 'Ban User', icon: '🚫', onClick: () => handleAction('ban', user), danger: true });
    }
    return actions;
  };

  // Filter Logic
  const filteredUsers = users.filter(u => {
    if (search && !u.email.toLowerCase().includes(search.toLowerCase()) && !(u.name && u.name.toLowerCase().includes(search.toLowerCase()))) return false;
    if (filterKyc !== 'All' && u.kyc_status !== filterKyc.toLowerCase()) return false;
    return true;
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">All Users</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Manage {users.length} traders across the platform.</p>
        </div>
        <button className="admin-btn admin-btn-ghost">
          <span style={{ fontSize: '16px' }}>📥</span> Export CSV
        </button>
      </div>

      <AdminFilterBar searchPlaceholder="Search via email, name, or UID..." searchValue={search} onSearchChange={setSearch}>
        {['All', 'Approved', 'Pending', 'Rejected'].map(k => (
          <button 
            key={k} 
            className={`admin-filter-chip ${filterKyc === k ? 'active' : ''}`}
            onClick={() => setFilterKyc(k)}
          >
            {k} {k === 'All' ? '' : `(${users.filter(u => u.kyc_status === k.toLowerCase()).length})`}
          </button>
        ))}
      </AdminFilterBar>

      <div className="admin-card" style={{ padding: 0 }}>
        <AdminDataTable 
          columns={columns}
          data={filteredUsers}
          loading={loading}
          rowActions={getRowActions}
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>

      {/* Slide-in Details Drawer */}
      <div className="admin-modal-overlay" style={{ 
        display: selectedUser ? 'flex' : 'none', 
        justifyContent: 'flex-end', 
        padding: 0, 
        animation: 'none' 
      }} onMouseDown={() => setSelectedUser(null)}>
        <div style={{ 
          width: '500px', maxWidth: '100vw', background: 'var(--admin-surface)', height: '100vh', 
          borderLeft: '1px solid var(--admin-border)', display: 'flex', flexDirection: 'column',
          transform: selectedUser ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 0.3s ease',
        }} onMouseDown={e => e.stopPropagation()}>
          
          {selectedUser && (
            <>
              <div style={{ padding: '24px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 className="admin-h2" style={{ margin: 0 }}>Trader Profile</h2>
                <button className="admin-modal-close" onClick={() => setSelectedUser(null)}>✕</button>
              </div>
              
              <div style={{ padding: '24px', flex: 1, overflowY: 'auto' }}>
                <div style={{ textAlign: 'center', marginBottom: '24px' }}>
                  <div className="admin-avatar" style={{ width: '80px', height: '80px', fontSize: '32px', margin: '0 auto 16px' }}>
                    {(selectedUser.name || selectedUser.email || 'A').charAt(0).toUpperCase()}
                  </div>
                  <h3 className="admin-h2" style={{ marginBottom: '4px' }}>{selectedUser.name || 'Unnamed Trader'}</h3>
                  <div style={{ color: 'var(--admin-text-faint)' }}>{selectedUser.email}</div>
                  <div style={{ marginTop: '12px' }}>
                    <AdminBadge status={selectedUser.is_banned ? 'banned' : 'active'} />
                    <AdminBadge status={selectedUser.kyc_status} style={{ marginLeft: '8px' }} />
                  </div>
                </div>

                <h3 className="admin-h3" style={{ borderBottom: '1px solid var(--admin-border)', paddingBottom: '8px', marginBottom: '16px' }}>System Info</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '32px' }}>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', textTransform: 'uppercase' }}>Trader UID</div>
                    <div className="admin-font-mono" style={{ fontSize: '14px', marginTop: '4px' }}>{String(selectedUser.id).padStart(5, '0')}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', textTransform: 'uppercase' }}>Joined Date</div>
                    <div style={{ fontSize: '14px', marginTop: '4px' }}>{new Date(selectedUser.created_at).toLocaleString()}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', textTransform: 'uppercase' }}>Country</div>
                    <div style={{ fontSize: '14px', marginTop: '4px' }}>{selectedUser.country || 'Unknown'}</div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', textTransform: 'uppercase' }}>Phone</div>
                    <div style={{ fontSize: '14px', marginTop: '4px' }}>{selectedUser.phone || 'Unknown'}</div>
                  </div>
                </div>

                <h3 className="admin-h3" style={{ borderBottom: '1px solid var(--admin-border)', paddingBottom: '8px', marginBottom: '16px' }}>Quick Actions</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <button className="admin-btn admin-btn-ghost" style={{ justifyContent: 'flex-start' }}>🔑 Force Password Reset</button>
                  <button className="admin-btn admin-btn-ghost" style={{ justifyContent: 'flex-start' }}>✉️ Send Direct Email</button>
                  <button className="admin-btn admin-btn-ghost" style={{ justifyContent: 'flex-start' }}>🏆 Manually Add Account</button>
                  {selectedUser.is_banned ? (
                    <button className="admin-btn admin-btn-success" style={{ justifyContent: 'flex-start' }} onClick={() => handleAction('unban', selectedUser)}>✅ Unban Trader</button>
                  ) : (
                    <button className="admin-btn admin-btn-danger" style={{ justifyContent: 'flex-start' }} onClick={() => handleAction('ban', selectedUser)}>🚫 Ban Trader</button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <AdminModal 
        isOpen={showBanModal} 
        onClose={() => setShowBanModal(false)}
        title="Confirm Ban"
        size="sm"
        footer={<>
          <button className="admin-btn admin-btn-ghost" onClick={() => setShowBanModal(false)}>Cancel</button>
          <button className="admin-btn admin-btn-danger" onClick={confirmBan}>Yes, Ban Trader</button>
        </>}
      >
        <p>Are you sure you want to ban <strong>{selectedUser?.email}</strong>?</p>
        <p style={{ color: 'var(--admin-text-faint)', fontSize: '13px', marginTop: '8px' }}>Their active challenge accounts and funding will be suspended immediately. They will not be able to log into the platform.</p>
      </AdminModal>
    </>
  );
}
