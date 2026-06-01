import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import AdminStatCard from '../AdminStatCard';
import AdminChart, { chartThemeProps } from '../AdminChart';
import { ChartSkeleton } from './AdminDashboardFeedback';

function EmptyChartState({ height, message }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height,
        color: 'var(--admin-text-muted)',
        fontSize: '13px',
      }}
    >
      {message}
    </div>
  );
}

function ActionCard({ title, count, color, link, navigate }) {
  const isAlert = count > 0;

  return (
    <div
      className="admin-card"
      onClick={() => navigate(link)}
      style={{
        padding: '16px',
        marginBottom: 0,
        cursor: 'pointer',
        border: isAlert ? `1px solid ${color}` : undefined,
        background: isAlert ? 'rgba(255,255,255,0.02)' : undefined,
      }}
    >
      <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '8px' }}>{title}</div>
      <div style={{ fontSize: '24px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: isAlert ? color : 'var(--admin-text)' }}>
        {count}
      </div>
    </div>
  );
}

export function AdminDashboardStats({ loading, error, overview, navigate }) {
  if (loading || error || !overview) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
      <AdminStatCard icon="👥" label="Total Users" value={(overview.users?.total || 0).toLocaleString()} onClick={() => navigate('/admin/users')} />
      <AdminStatCard
        icon="🏆"
        label="Active Challenges"
        value={((overview.accounts?.phase1 || 0) + (overview.accounts?.phase2 || 0)).toLocaleString()}
        onClick={() => navigate('/admin/challenges')}
      />
      <AdminStatCard icon="💎" label="Funded Traders" value={(overview.accounts?.funded || 0).toLocaleString()} onClick={() => navigate('/admin/funded')} />
      <AdminStatCard
        icon="💸"
        label="Total Paid Out"
        value={`$${(overview.payouts?.total_paid || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/payouts')}
      />
      <AdminStatCard
        icon="📈"
        label="Platform PnL (all trades)"
        value={`$${(overview.trades?.total_pnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/pnl')}
      />
      <AdminStatCard icon="🪪" label="Pending KYC" value={overview.users?.pending_kyc || 0} onClick={() => navigate('/admin/kyc')} />
    </div>
  );
}

export function AdminDashboardCharts({
  loading,
  trendsLoading,
  error,
  overview,
  signupTrend,
  accountStatusData,
  funnelData,
}) {
  if (error) return null;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '24px', marginBottom: '24px' }}>
        {trendsLoading ? (
          <ChartSkeleton height={220} />
        ) : (
          <AdminChart title="New Signups + Phase 1 Challenges (30D)">
            {signupTrend.length > 0 ? (
              <LineChart data={signupTrend}>
                <CartesianGrid {...chartThemeProps.grid} />
                <XAxis dataKey="label" {...chartThemeProps.xAxis} interval={4} />
                <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
                <Tooltip {...chartThemeProps.tooltip} />
                <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                <Line type="monotone" dataKey="signups" stroke="var(--admin-accent)" strokeWidth={3} dot={false} activeDot={{ r: 6 }} name="Signups" />
                <Line type="monotone" dataKey="challenges" stroke="var(--admin-info)" strokeWidth={3} dot={false} name="Challenges" />
              </LineChart>
            ) : (
              <EmptyChartState height="220px" message="No signup data in the last 30 days" />
            )}
          </AdminChart>
        )}

        {loading ? (
          <ChartSkeleton height={220} />
        ) : accountStatusData.length > 0 ? (
          <AdminChart title="Account Status Breakdown">
            <PieChart>
              <Tooltip {...chartThemeProps.tooltip} />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Pie
                data={accountStatusData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={78}
                paddingAngle={4}
                dataKey="value"
                stroke="var(--admin-surface)"
                strokeWidth={2}
              >
                {accountStatusData.map((entry, index) => (
                  <Cell key={entry.name || index} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </AdminChart>
        ) : (
          <AdminChart title="Account Status Breakdown">
            <EmptyChartState height="220px" message="No account data yet" />
          </AdminChart>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '32px' }}>
        {loading ? (
          <>
            <ChartSkeleton height={180} />
            <ChartSkeleton height={180} />
          </>
        ) : overview ? (
          <>
            <AdminChart title="Challenge Pass-Rate Funnel">
              <BarChart data={funnelData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" {...chartThemeProps.xAxis} allowDecimals={false} />
                <YAxis dataKey="phase" type="category" {...chartThemeProps.yAxis} />
                <Tooltip {...chartThemeProps.tooltip} />
                <Bar dataKey="count" fill="var(--admin-success)" radius={[0, 4, 4, 0]} barSize={30} name="Accounts" />
              </BarChart>
            </AdminChart>

            <AdminChart title="Platform Risk Exposure (Open Trades)">
              {overview.exposure && overview.exposure.length > 0 ? (
                <BarChart data={overview.exposure.slice(0, 6)}>
                  <CartesianGrid {...chartThemeProps.grid} />
                  <XAxis dataKey="instrument" {...chartThemeProps.xAxis} />
                  <YAxis {...chartThemeProps.yAxis} />
                  <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `${value} lots`} />
                  <Legend wrapperStyle={{ fontSize: '12px', paddingTop: '10px' }} />
                  <Bar dataKey="buy_lots" fill="var(--admin-success)" name="Buy Lots" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="sell_lots" fill="var(--admin-danger)" name="Sell Lots" radius={[4, 4, 0, 0]} />
                </BarChart>
              ) : (
                <EmptyChartState height="180px" message="No open trades" />
              )}
            </AdminChart>
          </>
        ) : null}
      </div>
    </>
  );
}

export function AdminDashboardAttention({ loading, error, overview, quickCounts, navigate }) {
  if (loading || error || !overview) return null;

  return (
    <>
      <h2 className="admin-h2" style={{ marginBottom: '16px' }}>Requires Attention</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '32px' }}>
        <ActionCard title="Pending KYC" count={quickCounts.kyc} color="var(--admin-warning)" link="/admin/kyc" navigate={navigate} />
        <ActionCard title="Pending Payouts" count={quickCounts.payouts} color="var(--admin-gold)" link="/admin/payouts" navigate={navigate} />
        <ActionCard title="Flagged Payouts" count={quickCounts.flagged} color="var(--admin-danger)" link="/admin/payouts" navigate={navigate} />
        <ActionCard title="Banned Users" count={quickCounts.banned} color="var(--admin-text-faint)" link="/admin/users" navigate={navigate} />
      </div>
    </>
  );
}

export function AdminDashboardExposureTable({ loading, error, exposure }) {
  if (loading || error || !exposure?.length) return null;

  return (
    <div className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
        <h2 className="admin-h2" style={{ margin: 0 }}>Live Hedge Exposure</h2>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'var(--admin-surface)' }}>
              {['Instrument', 'Buy Lots', 'Sell Lots', 'Net Lots', 'Direction', 'Floating PnL', 'Open Trades'].map((header) => (
                <th key={header} style={{ padding: '12px 16px', textAlign: 'left', color: 'var(--admin-text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {exposure.map((row, index) => (
              <tr key={`${row.instrument}-${index}`} style={{ borderBottom: '1px solid var(--admin-border)' }}>
                <td style={{ padding: '12px 16px', color: 'var(--admin-text)', fontFamily: 'var(--admin-font-mono)', fontWeight: 600 }}>{row.instrument}</td>
                <td style={{ padding: '12px 16px', color: 'var(--admin-success)' }}>{(row.buy_lots || 0).toFixed(2)}</td>
                <td style={{ padding: '12px 16px', color: 'var(--admin-danger)' }}>{(row.sell_lots || 0).toFixed(2)}</td>
                <td style={{ padding: '12px 16px', color: 'var(--admin-text)', fontFamily: 'var(--admin-font-mono)' }}>{(row.net_lots || 0).toFixed(2)}</td>
                <td style={{ padding: '12px 16px' }}>
                  <span
                    style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: row.net_direction === 'BUY'
                        ? 'rgba(34,197,94,0.12)'
                        : row.net_direction === 'SELL'
                          ? 'rgba(239,68,68,0.12)'
                          : 'rgba(148,163,184,0.12)',
                      color: row.net_direction === 'BUY'
                        ? 'var(--admin-success)'
                        : row.net_direction === 'SELL'
                          ? 'var(--admin-danger)'
                          : 'var(--admin-text-muted)',
                    }}
                  >
                    {row.net_direction || 'FLAT'}
                  </span>
                </td>
                <td
                  style={{
                    padding: '12px 16px',
                    fontFamily: 'var(--admin-font-mono)',
                    color: (row.floating_pnl || 0) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)',
                  }}
                >
                  {(row.floating_pnl || 0) >= 0 ? '+' : ''}${(row.floating_pnl || 0).toFixed(2)}
                </td>
                <td style={{ padding: '12px 16px', color: 'var(--admin-text-muted)' }}>{row.trade_count || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
