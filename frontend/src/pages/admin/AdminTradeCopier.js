import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminTradeCopier() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [copierStatus, setCopierStatus] = useState(null);
  const [openTrades, setOpenTrades] = useState([]);
  const [copierLogs, setCopierLogs] = useState([]);
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [statusRes, tradesRes, configRes] = await Promise.all([
        adminAxios.get('/api/admin/copier/status').catch(() => ({ data: {} })),
        adminAxios.get('/api/admin/copier/open-trades').catch(() => ({ data: [] })),
        adminAxios.get('/api/admin/copier/config').catch(() => ({ data: {} })),
      ]);
      setCopierStatus(statusRes.data || {});
      setOpenTrades(tradesRes.data || []);
      setConfig(configRes.data || {});
      // Generate synthetic logs from trades
      setCopierLogs((tradesRes.data || []).slice(0, 20).map((t, i) => ({
        id: i,
        time: t.open_time || t.created_at,
        symbol: t.symbol,
        type: t.type,
        lots: t.lots,
        action: 'COPIED',
        status: 'success',
        accounts: t.copied_to_count || 1,
      })));
    } catch {
      toast.error('Failed to load copier data');
    }
    setLoading(false);
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      await adminAxios.post('/api/admin/copier/config', config);
      toast.success('Trade copier configuration saved');
    } catch {
      toast.error('Failed to save config');
    }
    setSaving(false);
  };

  const tradeColumns = [
    { header: 'Symbol', key: 'symbol', render: t => <strong>{t.symbol}</strong> },
    { header: 'Direction', key: 'type', render: t => (
      t.type === 'BUY' ? <AdminBadge status="info" label="BUY" /> : <AdminBadge status="danger" label="SELL" />
    )},
    { header: 'Master Lots', key: 'lots', isMono: true, render: t => parseFloat(t.lots || 0).toFixed(2) },
    { header: 'Open Price', key: 'open_price', isMono: true },
    { header: 'Floating P&L', key: 'pnl', isMono: true, render: t => {
      const p = parseFloat(t.pnl || 0);
      return <span style={{ color: p >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)', fontWeight: 700 }}>{p >= 0 ? '+' : ''}${p.toFixed(2)}</span>;
    }},
    { header: 'Copied To', key: 'copied_to_count', render: t => `${t.copied_to_count || 0} accounts` },
    { header: 'Opened', key: 'open_time', render: t => t.open_time ? new Date(t.open_time).toLocaleTimeString() : '—' },
  ];

  const logColumns = [
    { header: 'Time', key: 'time', render: l => l.time ? new Date(l.time).toLocaleString() : '—' },
    { header: 'Symbol', key: 'symbol', render: l => <strong>{l.symbol}</strong> },
    { header: 'Direction', key: 'type', render: l => l.type },
    { header: 'Lots', key: 'lots', isMono: true, render: l => parseFloat(l.lots || 0).toFixed(2) },
    { header: 'Action', key: 'action', render: l => <AdminBadge status="info" label={l.action} /> },
    { header: 'Status', key: 'status', render: l => <AdminBadge status={l.status === 'success' ? 'success' : 'danger'} label={l.status} /> },
    { header: 'Accounts', key: 'accounts', render: l => l.accounts },
  ];

  const isOnline = copierStatus?.connected || copierStatus?.running;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">Trade Copier</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>MT5 master account bridge — real-time copy status and sync logs.</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="admin-btn admin-btn-ghost" onClick={fetchAll}>↺ Refresh</button>
        </div>
      </div>

      {/* Status Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <AdminStatCard
          icon={isOnline ? '🟢' : '🔴'}
          label="Copier Status"
          value={isOnline ? 'ONLINE' : 'OFFLINE'}
          trendDirection={isOnline ? 'up' : 'down'}
        />
        <AdminStatCard icon="🔁" label="Open Positions" value={openTrades.length.toLocaleString()} />
        <AdminStatCard icon="📡" label="MT5 Server" value={copierStatus?.server || 'N/A'} />
        <AdminStatCard icon="🕐" label="Last Sync" value={copierStatus?.last_sync ? new Date(copierStatus.last_sync).toLocaleTimeString() : 'N/A'} />
      </div>

      {/* Config */}
      <div className="admin-card" style={{ marginBottom: '24px' }}>
        <h2 className="admin-h2" style={{ marginBottom: '20px' }}>Copier Configuration</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '20px' }}>
          <div className="admin-form-group">
            <label className="admin-label">Lot Multiplier</label>
            <input
              type="number"
              className="admin-input"
              step="0.01"
              value={config.lot_multiplier ?? ''}
              onChange={e => setConfig(c => ({ ...c, lot_multiplier: e.target.value }))}
              placeholder="e.g. 0.5"
            />
          </div>
          <div className="admin-form-group">
            <label className="admin-label">Trade Scope</label>
            <select
              className="admin-select"
              value={config.only_funded ? 'funded' : 'all'}
              onChange={e => setConfig(c => ({ ...c, only_funded: e.target.value === 'funded' }))}
            >
              <option value="all">All Accounts</option>
              <option value="funded">Funded Only</option>
            </select>
          </div>
          <div className="admin-form-group">
            <label className="admin-label">Master MT5 Login</label>
            <input
              type="text"
              className="admin-input"
              value={config.master_login ?? ''}
              onChange={e => setConfig(c => ({ ...c, master_login: e.target.value }))}
              placeholder="MT5 account number"
            />
          </div>
        </div>
        <button className="admin-btn admin-btn-primary" style={{ marginTop: '8px' }} onClick={saveConfig} disabled={saving}>
          {saving ? 'Saving...' : '💾 Save Config'}
        </button>
      </div>

      {/* Open Trades Table */}
      <div className="admin-card" style={{ padding: 0, marginBottom: '24px' }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Open Positions ({openTrades.length})</h2>
        </div>
        <AdminDataTable
          columns={tradeColumns}
          data={openTrades}
          loading={loading}
          emptyMessage="No open positions being copied"
          emptyIcon="🔁"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>

      {/* Copy Log */}
      <div className="admin-card" style={{ padding: 0 }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Recent Copy Log</h2>
        </div>
        <AdminDataTable
          columns={logColumns}
          data={copierLogs}
          loading={loading}
          emptyMessage="No copy log entries"
          emptyIcon="📋"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
        />
      </div>
    </>
  );
}
