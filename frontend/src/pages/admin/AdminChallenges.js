import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminChallenges() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState('');
  const [filterPhase, setFilterPhase] = useState('All');
  
  const [selectedAcc, setSelectedAcc] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  useEffect(() => {
    fetchAccounts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      // Assuming old Admin.js route /api/admin/accounts or similar
      const res = await adminAxios.get('/api/admin/accounts');
      const allAccs = res.data || [];
      // Filter out funded accounts since this page is for Challenges only
      setAccounts(allAccs.filter(a => a.status !== 'funded'));
    } catch {
      toast.error('Failed to load active challenges');
    }
    setLoading(false);
  };

  const handleAction = (action, acc) => {
    if (action === 'view') {
      setSelectedAcc(acc);
      setShowOverrideModal(true);
    } else if (action === 'trades') {
      toast.success('Navigating to full trade history...');
      // Logic to jump to AdminTrades filtered by an account ID
    }
  };

  const executeOverride = async (type) => {
    if (!selectedAcc) return;
    try {
      await adminAxios.post(`/api/admin/accounts/${selectedAcc.id}/override`, { action: type });
      toast.success(`Account ID ${selectedAcc.id} successfully updated to ${type}`);
      setShowOverrideModal(false);
      fetchAccounts();
    } catch (err) {
      toast.error('Failed to apply override');
    }
  };

  const renderProgressBar = (val, max, type) => {
    const pct = Math.min(100, Math.max(0, (val / max) * 100)) || 0;
    
    let color = 'var(--admin-success)';
    if (type === 'drawdown') {
      color = pct > 90 ? 'var(--admin-danger)' : pct > 70 ? 'var(--admin-warning)' : 'var(--admin-info)';
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div className="admin-progress-bg">
          <div className="admin-progress-fill" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span style={{ fontSize: '11px', fontFamily: 'var(--admin-font-mono)' }}>{pct.toFixed(1)}%</span>
      </div>
    );
  };

  const columns = [
    { header: 'Account ID', key: 'id', isMono: true, render: a => `#${String(a.id).padStart(5, '0')}` },
    { header: 'Trader', key: 'user_id', render: a => a.user_email || `User #${a.user_id}` },
    { header: 'Phase', key: 'status', render: a => a.status === 'phase1' ? 'Phase 1' : a.status === 'phase2' ? 'Phase 2' : 'Unknown' },
    { header: 'Size', key: 'size', isMono: true, render: a => `$${(a.size || 0).toLocaleString()}` },
    { header: 'Balance', key: 'balance', isMono: true, render: a => `$${(a.balance || 0).toFixed(2)}` },
    { header: 'Profit %', key: 'profit', render: a => {
      // Mock metrics for display
      const target = a.status === 'phase1' ? (a.size * 0.1) : (a.size * 0.05);
      const profit = Math.max(0, a.balance - a.size);
      return renderProgressBar(profit, target, 'profit');
    }},
    { header: 'Drawdown %', key: 'drawdown', render: a => {
      const ddLimit = a.size * 0.1; // 10%
      const peak = a.high_water_mark || a.size;
      const currentDd = Math.max(0, peak - a.equity);
      return renderProgressBar(currentDd, ddLimit, 'drawdown');
    }},
    { header: 'Status', key: 'statusState', render: a => {
      if (a.is_banned) return <AdminBadge status="banned" />;
      if (a.balance < a.size * 0.9) return <AdminBadge status="failed" />;
      return <AdminBadge status="active" />;
    }},
    { header: 'Created', key: 'created_at', render: a => new Date(a.created_at).toLocaleDateString() },
  ];

  const getRowActions = (acc) => [
    { label: 'View Details & Overrides', icon: '🔍', onClick: () => handleAction('view', acc) },
    { label: 'View Full Trade Log', icon: '📊', onClick: () => handleAction('trades', acc) },
    { label: 'Message Trader', icon: '💬', onClick: () => {} },
  ];

  const filtered = accounts.filter(a => {
    if (search && !String(a.id).includes(search) && !(a.user_email || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filterPhase !== 'All' && a.status !== filterPhase.toLowerCase().replace(' ', '')) return false;
    return true;
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">Active Challenges</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Monitor Phase 1 & 2 evaluation objectives.</p>
        </div>
      </div>

      <AdminFilterBar searchPlaceholder="Search via Account ID or user email..." searchValue={search} onSearchChange={setSearch}>
        {['All', 'Phase 1', 'Phase 2'].map(k => (
          <button 
            key={k} 
            className={`admin-filter-chip ${filterPhase === k ? 'active' : ''}`}
            onClick={() => setFilterPhase(k)}
          >
            {k} {k === 'All' ? '' : `(${accounts.filter(a => a.status === k.toLowerCase().replace(' ', '')).length})`}
          </button>
        ))}
      </AdminFilterBar>

      <div className="admin-card" style={{ padding: 0 }}>
        <AdminDataTable 
          columns={columns}
          data={filtered}
          loading={loading}
          rowActions={getRowActions}
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>

      <AdminModal
        isOpen={showOverrideModal}
        onClose={() => setShowOverrideModal(false)}
        title={`Account Data: #${String(selectedAcc?.id || '').padStart(5, '0')}`}
        size="md"
        footer={<>
          <button className="admin-btn admin-btn-ghost" onClick={() => setShowOverrideModal(false)}>Close</button>
        </>}
      >
        {selectedAcc && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '24px' }}>
              <div style={{ background: 'var(--admin-bg)', padding: '16px', borderRadius: '8px', border: '1px solid var(--admin-border)' }}>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Current Balance</div>
                <div style={{ fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: 'var(--admin-text)' }}>
                  ${(selectedAcc.balance || 0).toFixed(2)}
                </div>
              </div>
              <div style={{ background: 'var(--admin-bg)', padding: '16px', borderRadius: '8px', border: '1px solid var(--admin-border)' }}>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Current Equity</div>
                <div style={{ fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: 'var(--admin-text)' }}>
                  ${(selectedAcc.equity || 0).toFixed(2)}
                </div>
              </div>
            </div>

            <h3 className="admin-h3" style={{ borderBottom: '1px solid var(--admin-border)', paddingBottom: '8px', marginBottom: '16px' }}>Admin Manual Overrides</h3>
            <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', padding: '16px', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
                Use these buttons to forcibly bypass the standard phase metrics due to data errors, manual verifications, or dispute resolutions.
              </p>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button className="admin-btn admin-btn-success" style={{ flex: 1 }} onClick={() => executeOverride('pass')}>
                  ✅ Force Pass Phase
                </button>
                <button className="admin-btn admin-btn-danger" style={{ flex: 1 }} onClick={() => executeOverride('fail')}>
                  ❌ Breach Account
                </button>
                <button className="admin-btn admin-btn-ghost" style={{ flex: 1 }}>
                  ⏳ Extend 14 Days
                </button>
              </div>
            </div>
          </div>
        )}
      </AdminModal>
    </>
  );
}
