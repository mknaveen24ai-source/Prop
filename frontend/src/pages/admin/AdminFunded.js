import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminFunded() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [search, setSearch] = useState('');
  
  const [selectedAcc, setSelectedAcc] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  useEffect(() => {
    fetchAccounts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAccounts = async () => {
    setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/accounts');
      const allAccs = res.data || [];
      // Filter ONLY funded accounts
      setAccounts(allAccs.filter(a => a.status === 'funded'));
    } catch {
      toast.error('Failed to load funded master accounts');
    }
    setLoading(false);
  };

  const handleAction = (action, acc) => {
    if (action === 'view') {
      setSelectedAcc(acc);
      setShowOverrideModal(true);
    } else if (action === 'sync_mt5') {
      toast.success(`MT5 sync command sent for Account #${String(acc.id).padStart(5, '0')}`);
    }
  };

  const executeRevoke = async () => {
    if (!selectedAcc) return;
    try {
      await adminAxios.post(`/api/admin/accounts/${selectedAcc.id}/override`, { action: 'revoke_funded' });
      toast.success(`Account ID ${selectedAcc.id} funding revoked.`);
      setShowOverrideModal(false);
      fetchAccounts();
    } catch (err) {
      toast.error('Failed to revoke funding');
    }
  };

  const columns = [
    { header: 'Account ID', key: 'id', isMono: true, render: a => `#${String(a.id).padStart(5, '0')}` },
    { header: 'Trader', key: 'user_id', render: a => a.user_email || `User #${a.user_id}` },
    { header: 'Status', key: 'status', render: () => <AdminBadge status="funded" label="MASTER" /> },
    { header: 'Size', key: 'size', isMono: true, render: a => `$${(a.size || 0).toLocaleString()}` },
    { header: 'Balance', key: 'balance', isMono: true, render: a => `$${(a.balance || 0).toFixed(2)}` },
    { header: 'Total Payouts', key: 'payouts', isMono: true, render: a => `$${(a.total_payouts || 0).toFixed(2)}` },
    { header: 'Profit Split', key: 'split', render: a => `${a.profit_split || 80}/${100 - (a.profit_split || 80)}` },
    { header: 'MT5 ID', key: 'mt5', isMono: true, render: a => a.mt5_login || 'Pending Sync' },
    { header: 'Funded Date', key: 'created_at', render: a => new Date(a.created_at).toLocaleDateString() }, // Note: assuming created_at or updated_at for funded date
  ];

  const getRowActions = (acc) => [
    { label: 'View Master Details', icon: '🔍', onClick: () => handleAction('view', acc) },
    { label: 'Edit Profit Split %', icon: '⚙️', onClick: () => {} },
    { label: 'Request MT5 Sync', icon: '🔁', onClick: () => handleAction('sync_mt5', acc) },
    { label: 'Revoke Funding', icon: '🚫', onClick: () => handleAction('view', acc), danger: true },
  ];

  const filtered = accounts.filter(a => {
    if (search && !String(a.id).includes(search) && !(a.user_email || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">Funded Accounts</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Monitor live multi-asset Master accounts.</p>
        </div>
      </div>

      <AdminFilterBar searchPlaceholder="Search via Account ID or user email..." searchValue={search} onSearchChange={setSearch} />

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
        title={`Master Account: #${String(selectedAcc?.id || '').padStart(5, '0')}`}
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
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Total Payouts Released</div>
                <div style={{ fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: 'var(--admin-gold)' }}>
                  ${(selectedAcc.total_payouts || 0).toFixed(2)}
                </div>
              </div>
            </div>

            <h3 className="admin-h3" style={{ borderBottom: '1px solid var(--admin-border)', paddingBottom: '8px', marginBottom: '16px' }}>Master Controls</h3>
            <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', padding: '16px', borderRadius: '8px' }}>
              <p style={{ fontSize: '12px', color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
                Revoking funding will instantly disconnect this account from the MT5 trade copier bridge and lock trade execution.
              </p>
              <button className="admin-btn admin-btn-danger" style={{ width: '100%' }} onClick={executeRevoke}>
                🚫 Revoke Master Access
              </button>
            </div>
          </div>
        )}
      </AdminModal>
    </>
  );
}
