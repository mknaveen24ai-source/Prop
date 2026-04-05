import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { chartThemeProps } from '../../components/admin/AdminChart';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminPlatformPnL() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [bbook, setBbook] = useState([]);

  useEffect(() => {
    Promise.all([
      adminAxios.get('/api/admin/overview').catch(() => ({ data: {} })),
      adminAxios.get('/api/admin/bbook').catch(() => ({ data: [] })),
    ]).then(([overviewRes, bbookRes]) => {
      setOverview(overviewRes.data || {});
      setBbook(bbookRes.data || []);
    }).catch(() => toast.error('Failed to load P&L data'))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build rolling daily PnL chart from bbook data
  const rollingData = bbook.slice(-30).map((row, i) => ({
    day: `D${i + 1}`,
    edge: parseFloat(row.platform_pnl || row.net_edge || 0),
    fees: parseFloat(row.fee_revenue || 0),
  }));

  const totalEdge = bbook.reduce((s, r) => s + parseFloat(r.platform_pnl || r.net_edge || 0), 0);
  const totalFees = bbook.reduce((s, r) => s + parseFloat(r.fee_revenue || 0), 0);
  const winRate = overview?.trader_win_rate ? `${parseFloat(overview.trader_win_rate).toFixed(1)}%` : '—';

  if (loading) {
    return (
      <div style={{ padding: '40px' }}>
        <div className="admin-skeleton" style={{ height: '120px', marginBottom: '24px' }} />
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: '24px' }}>
        <h1 className="admin-h1">Platform P&amp;L</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>B-Book edge, fee revenue, and platform-wide exposure analytics.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '32px' }}>
        <AdminStatCard icon="📈" label="Total B-Book Edge" value={`$${totalEdge.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} trendDirection={totalEdge >= 0 ? 'up' : 'down'} />
        <AdminStatCard icon="💰" label="Total Fee Revenue" value={`$${totalFees.toLocaleString(undefined, { maximumFractionDigits: 2 })}`} trendDirection="up" />
        <AdminStatCard icon="🏆" label="Trader Win Rate" value={winRate} />
        <AdminStatCard icon="📊" label="Total Traders" value={(overview?.total_users || 0).toLocaleString()} />
        <AdminStatCard icon="💎" label="Funded Accounts" value={(overview?.funded_accounts || 0).toLocaleString()} />
        <AdminStatCard icon="⚖️" label="Net Exposure" value={`$${(overview?.net_exposure || 0).toLocaleString()}`} />
      </div>

      {/* Rolling P&L Chart */}
      <div className="admin-card" style={{ marginBottom: '24px' }}>
        <h2 className="admin-h2" style={{ marginBottom: '24px' }}>Rolling Platform Edge (30 Days)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={rollingData}>
            <defs>
              <linearGradient id="edgeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--admin-accent)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--admin-accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="day" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={v => `$${v}`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={v => `$${v.toFixed(2)}`} />
            <ReferenceLine y={0} stroke="var(--admin-border-strong)" strokeDasharray="4 2" />
            <Area type="monotone" dataKey="edge" stroke="var(--admin-accent)" fill="url(#edgeGrad)" strokeWidth={2} name="B-Book Edge" />
            <Area type="monotone" dataKey="fees" stroke="var(--admin-gold)" fill="none" strokeWidth={2} name="Fee Revenue" strokeDasharray="5 3" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* B-Book Recent Positions */}
      <div className="admin-card" style={{ padding: 0 }}>
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ margin: 0 }}>Recent B-Book Positions</h2>
        </div>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                {['Symbol', 'Direction', 'Lots', 'Trader P&L', 'Platform Edge', 'Closed At'].map(h => (
                  <th key={h} className="admin-th">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bbook.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="admin-empty-state">
                      <div className="admin-empty-icon">📊</div>
                      <div className="admin-empty-title">No B-Book positions recorded yet</div>
                    </div>
                  </td>
                </tr>
              ) : bbook.slice(0, 50).map((row, i) => {
                const traderPnl = parseFloat(row.trader_pnl || 0);
                const platEdge = parseFloat(row.platform_pnl || row.net_edge || 0);
                return (
                  <tr key={row.id || i}>
                    <td className="admin-td" style={{ fontWeight: 600 }}>{row.symbol || '—'}</td>
                    <td className="admin-td">
                      <span style={{ color: row.type === 'BUY' ? 'var(--admin-info)' : 'var(--admin-danger)', fontWeight: 600 }}>
                        {row.type || '—'}
                      </span>
                    </td>
                    <td className="admin-td admin-td-mono">{parseFloat(row.lots || 0).toFixed(2)}</td>
                    <td className="admin-td admin-td-mono" style={{ color: traderPnl >= 0 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>
                      {traderPnl >= 0 ? '+' : ''}${traderPnl.toFixed(2)}
                    </td>
                    <td className="admin-td admin-td-mono" style={{ color: platEdge >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)', fontWeight: 700 }}>
                      {platEdge >= 0 ? '+' : ''}${platEdge.toFixed(2)}
                    </td>
                    <td className="admin-td" style={{ color: 'var(--admin-text-muted)' }}>
                      {row.closed_at ? new Date(row.closed_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
