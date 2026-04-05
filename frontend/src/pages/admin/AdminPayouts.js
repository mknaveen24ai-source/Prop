import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminPayouts() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [payouts, setPayouts] = useState([]);
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState('All');
  
  const [selectedPayout, setSelectedPayout] = useState(null);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    fetchPayouts();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPayouts = async () => {
    setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/payouts');
      setPayouts(res.data || []);
    } catch {
      toast.error('Failed to load payout requests');
    }
    setLoading(false);
  };

  const processPayout = async (status) => {
    if (!selectedPayout) return;
    try {
      await adminAxios.post('/api/admin/payouts/process', { 
        payoutId: selectedPayout.id, 
        status 
      });
      toast.success(`Payout successfully marked as ${status.toUpperCase()}`);
      setShowModal(false);
      fetchPayouts();
    } catch {
      toast.error(`Failed to mark payout as ${status}`);
    }
  };

  const columns = [
    { header: 'Request ID', key: 'id', isMono: true, render: p => `PAY-${String(p.id).padStart(5, '0')}` },
    { header: 'Trader', key: 'user_email', render: p => (
      <div>
        <div style={{ color: 'var(--admin-text)' }}>{p.user_email || 'Unknown User'}</div>
        <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>Acc #{p.account_id}</div>
      </div>
    )},
    { header: 'Requested Amount', key: 'amount', isMono: true, render: p => `$${(parseFloat(p.amount) || 0).toLocaleString(undefined, {minimumFractionDigits: 2})}` },
    { header: 'Destination', key: 'details', render: p => {
      let dest = 'Wire/Crypto';
      if (p.details) {
        try { const j = JSON.parse(p.details); dest = j.method || dest; } catch(e) {}
      }
      return dest;
    }},
    { header: 'Requested Date', key: 'created_at', render: p => new Date(p.created_at).toLocaleString() },
    { header: 'Status', key: 'status', render: p => <AdminBadge status={p.status} /> },
  ];

  const getRowActions = (p) => [
    { label: 'Review Request', icon: '🔍', onClick: () => { setSelectedPayout(p); setShowModal(true); } },
  ];

  const filtered = payouts.filter(p => {
    if (search && !String(p.id).includes(search) && !(p.user_email || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (filterStatus !== 'All' && p.status !== filterStatus.toLowerCase()) return false;
    return true;
  });

  const totals = payouts.reduce((acc, p) => {
    if (p.status === 'pending') acc.pending += parseFloat(p.amount) || 0;
    if (p.status === 'paid') acc.paid += parseFloat(p.amount) || 0;
    return acc;
  }, { pending: 0, paid: 0 });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">Payout Requests</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Approve profits split distributions to funded traders.</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="💸" label="Pending Payouts Value" value={`$${totals.pending.toLocaleString()}`} />
        <AdminStatCard icon="✅" label="Total Payouts Released" value={`$${totals.paid.toLocaleString()}`} />
      </div>

      <AdminFilterBar searchPlaceholder="Search via Payout ID or email..." searchValue={search} onSearchChange={setSearch}>
        {['All', 'Pending', 'Paid', 'Rejected'].map(k => (
          <button 
            key={k} 
            className={`admin-filter-chip ${filterStatus === k ? 'active' : ''}`}
            onClick={() => setFilterStatus(k)}
          >
            {k} {k === 'All' ? '' : `(${payouts.filter(p => p.status === k.toLowerCase()).length})`}
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
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={`Review Payout: PAY-${String(selectedPayout?.id || '').padStart(5, '0')}`}
        size="md"
      >
        {selectedPayout && (
          <div>
             <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: '8px' }}>Requested Amount</div>
                <div style={{ fontSize: '48px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: 'var(--admin-gold)' }}>
                  ${(parseFloat(selectedPayout.amount) || 0).toLocaleString(undefined, {minimumFractionDigits:2})}
                </div>
                <div style={{ marginTop: '12px' }}>
                  <AdminBadge status={selectedPayout.status} />
                </div>
             </div>

             <div className="admin-card" style={{ background: 'var(--admin-surface)', marginBottom: '24px' }}>
                <h3 className="admin-h3" style={{ borderBottom: '1px solid var(--admin-border)', paddingBottom: '8px', marginBottom: '16px' }}>Requester Details</h3>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)' }}>Trader Email</div>
                    <div style={{ fontSize: '14px', fontWeight: 500, color: 'var(--admin-text)' }}>{selectedPayout.user_email}</div>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)' }}>Master Account ID</div>
                    <div className="admin-font-mono" style={{ fontSize: '14px', color: 'var(--admin-text)' }}>#{selectedPayout.account_id}</div>
                  </div>
                  <div style={{ gridColumn: 'span 2' }}>
                    <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)' }}>Payout Destination Information</div>
                    <div className="admin-font-mono" style={{ fontSize: '13px', color: 'var(--admin-text)', background: 'var(--admin-bg)', padding: '12px', borderRadius: '6px', border: '1px solid var(--admin-border)', marginTop: '4px', whiteSpace: 'pre-wrap' }}>
                      {selectedPayout.details || 'No details provided.'}
                    </div>
                  </div>
                </div>
             </div>

             {selectedPayout.status === 'pending' ? (
                <div style={{ display: 'flex', gap: '12px' }}>
                  <button className="admin-btn admin-btn-success" style={{ flex: 1, padding: '16px', fontSize: '16px' }} onClick={() => processPayout('paid')}>
                    ✅ Mark as Paid
                  </button>
                  <button className="admin-btn admin-btn-danger" style={{ flex: 1, padding: '16px', fontSize: '16px' }} onClick={() => processPayout('rejected')}>
                    ❌ Reject Payout
                  </button>
                </div>
             ) : (
                <div style={{ display: 'flex' }}>
                   <button className="admin-btn admin-btn-ghost" style={{ width: '100%' }} onClick={() => setShowModal(false)}>Close Window</button>
                </div>
             )}
          </div>
        )}
      </AdminModal>
    </>
  );
}
