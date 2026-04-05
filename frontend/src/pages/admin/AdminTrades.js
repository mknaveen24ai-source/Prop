import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminTrades() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState([]);
  const [search, setSearch] = useState('');
  const [filterDirection, setFilterDirection] = useState('All');
  
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  useEffect(() => {
    fetchTrades();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchTrades = async () => {
    setLoading(true);
    try {
      // In old Admin.js trades might not have had a dedicated mass endpoint depending on version, 
      // but assuming standard structure or we degrade silently
      const res = await adminAxios.get('/api/admin/trades').catch(() => ({ data: [] }));
      setTrades(res.data || []);
    } catch {
      toast.error('Failed to load global executions');
    }
    setLoading(false);
  };

  const executeForceClose = async () => {
    if (!selectedTrade) return;
    try {
      await adminAxios.post(`/api/admin/trades/${selectedTrade.id}/close`);
      toast.success(`Trade ${selectedTrade.id} force closed`);
      setShowOverrideModal(false);
      fetchTrades();
    } catch {
      toast.error('Failed to force close trade');
    }
  };

  const columns = [
    { header: 'Trade ID', key: 'id', isMono: true, render: t => `#${String(t.id).padStart(6, '0')}` },
    { header: 'Account / Trader', key: 'account_id', render: t => (
      <div>
        <div style={{ color: 'var(--admin-text)' }}>Acc #{t.account_id}</div>
        <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>Trader #{t.user_id}</div>
      </div>
    )},
    { header: 'Instrument', key: 'symbol', render: t => <span style={{ fontWeight: 600 }}>{t.symbol}</span> },
    { header: 'Direction', key: 'type', render: t => (
      t.type === 'BUY' ? <AdminBadge status="active" label="BUY" /> : <AdminBadge status="danger" label="SELL" outline />
    )},
    { header: 'Lots', key: 'lots', isMono: true, render: t => parseFloat(t.lots).toFixed(2) },
    { header: 'Open / Close Price', key: 'open_price', isMono: true, render: t => (
      <div>
        <div>{t.open_price}</div>
        <div style={{ color: 'var(--admin-text-muted)' }}>{t.close_price || '—'}</div>
      </div>
    )},
    { header: 'SL / TP', key: 'sl', isMono: true, render: t => (
      <div>
        <div style={{ color: 'var(--admin-danger)' }}>{t.sl || '—'}</div>
        <div style={{ color: 'var(--admin-success)' }}>{t.tp || '—'}</div>
      </div>
    )},
    { header: 'P&L', key: 'pnl', isMono: true, render: t => {
      const pnl = parseFloat(t.pnl) || 0;
      return (
        <span style={{ color: pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)', fontWeight: 700 }}>
          {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
        </span>
      );
    }},
    { header: 'Status', key: 'status', render: t => <AdminBadge status={t.status === 'open' ? 'info' : 'neutral'} label={t.status} /> },
  ];

  const getRowActions = (t) => {
    let actions = [
      { label: 'View Details', icon: '🔍', onClick: () => { setSelectedTrade(t); setShowOverrideModal(true); } }
    ];
    if (t.status === 'open') {
      actions.push({ label: 'Force Close Trade', icon: '⚠️', onClick: () => { setSelectedTrade(t); setShowOverrideModal(true); }, danger: true });
    }
    return actions;
  };

  const filtered = trades.filter(t => {
    if (search && !String(t.id).includes(search) && !t.symbol.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterDirection !== 'All' && t.type !== filterDirection.toUpperCase()) return false;
    return true;
  });

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">All Executions</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Monitor live market exposures and execution history.</p>
        </div>
      </div>

      <AdminFilterBar searchPlaceholder="Search via Ticket ID or Symbol..." searchValue={search} onSearchChange={setSearch}>
        {['All', 'BUY', 'SELL'].map(k => (
          <button 
            key={k} 
            className={`admin-filter-chip ${filterDirection === k ? 'active' : ''}`}
            onClick={() => setFilterDirection(k)}
          >
            {k}
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
        title={`Trade Ticket: #${String(selectedTrade?.id || '').padStart(6, '0')}`}
        size="md"
        footer={<>
          <button className="admin-btn admin-btn-ghost" onClick={() => setShowOverrideModal(false)}>Close</button>
        </>}
      >
        {selectedTrade && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Instrument</div>
                <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--admin-text)' }}>{selectedTrade.symbol}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Direction & Size</div>
                <div style={{ fontSize: '18px', fontWeight: 600, color: selectedTrade.type === 'BUY' ? 'var(--admin-info)' : 'var(--admin-danger)' }}>
                  {selectedTrade.type} <span style={{ color: 'var(--admin-text)' }}>{selectedTrade.lots} Lot</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--admin-danger)' }}>Stop Loss</div>
                <div style={{ fontSize: '16px', fontFamily: 'var(--admin-font-mono)' }}>{selectedTrade.sl || 'Not Set'}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--admin-success)' }}>Take Profit</div>
                <div style={{ fontSize: '16px', fontFamily: 'var(--admin-font-mono)' }}>{selectedTrade.tp || 'Not Set'}</div>
              </div>
            </div>

            <div style={{ background: 'var(--admin-surface)', border: '1px solid var(--admin-border)', padding: '16px', borderRadius: '8px', marginBottom: '24px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Net Floating P&L</div>
              <div style={{ fontSize: '32px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: (parseFloat(selectedTrade.pnl) || 0) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                {(parseFloat(selectedTrade.pnl) || 0) >= 0 ? '+' : ''}${(parseFloat(selectedTrade.pnl) || 0).toFixed(2)}
              </div>
            </div>

            {selectedTrade.status === 'open' && (
               <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.2)', padding: '16px', borderRadius: '8px' }}>
                 <p style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
                   As an administrator, you may forcibly close this active market execution. This action will realize the current floating P&L and cannot be reversed.
                 </p>
                 <button className="admin-btn admin-btn-danger" style={{ width: '100%' }} onClick={executeForceClose}>
                   Force Close Position
                 </button>
               </div>
            )}
          </div>
        )}
      </AdminModal>
    </>
  );
}
