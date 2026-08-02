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
import AdminStatGrid from '../AdminStatGrid';
import AdminChart, { chartThemeProps } from '../AdminChart';
import AdminDataTable from '../AdminDataTable';
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

export function AdminDashboardStats({ loading, error, overview, navigate }) {
  if (loading || error || !overview) return null;

  return (
    <AdminStatGrid gap={20}>
      <AdminStatCard icon="users" label="Total Users" value={(overview.users?.total || 0).toLocaleString()} onClick={() => navigate('/admin/users')} />
      <AdminStatCard
        icon="challenges"
        label="Active Challenges"
        value={((overview.accounts?.phase1 || 0) + (overview.accounts?.phase2 || 0)).toLocaleString()}
        onClick={() => navigate('/admin/challenges')}
      />
      <AdminStatCard icon="funded" label="Funded Traders" value={(overview.accounts?.funded || 0).toLocaleString()} onClick={() => navigate('/admin/funded')} />
      <AdminStatCard
        icon="payouts"
        label="Total Paid Out"
        value={`$${(overview.payouts?.total_paid || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/payouts')}
      />
      <AdminStatCard
        icon="pnl"
        label="Platform PnL (all trades)"
        value={`$${(overview.trades?.total_pnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/pnl')}
      />
      <AdminStatCard icon="kyc" label="Pending KYC" value={overview.users?.pending_kyc || 0} onClick={() => navigate('/admin/kyc')} />
    </AdminStatGrid>
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
                <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--rule)" />
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
      <AdminStatGrid minColumnWidth={190} style={{ marginBottom: '32px' }}>
        <AdminStatCard icon="kyc" label="Pending KYC" value={quickCounts.kyc} alert={quickCounts.kyc > 0} alertColor="var(--admin-warning)" onClick={() => navigate('/admin/kyc')} />
        <AdminStatCard icon="payouts" label="Pending Payouts" value={quickCounts.payouts} alert={quickCounts.payouts > 0} alertColor="var(--admin-gold)" onClick={() => navigate('/admin/payouts')} />
        <AdminStatCard icon="payouts" label="Flagged Payouts" value={quickCounts.flagged} alert={quickCounts.flagged > 0} alertColor="var(--admin-danger)" onClick={() => navigate('/admin/payouts')} />
        <AdminStatCard icon="users" label="Banned Users" value={quickCounts.banned} alert={quickCounts.banned > 0} alertColor="var(--admin-text-faint)" onClick={() => navigate('/admin/users')} />
      </AdminStatGrid>
    </>
  );
}

const EXPOSURE_COLUMNS = [
  { header: 'Instrument', key: 'instrument', isMono: true },
  { header: 'Buy Lots', render: (row) => <span style={{ color: 'var(--admin-success)' }}>{(row.buy_lots || 0).toFixed(2)}</span> },
  { header: 'Sell Lots', render: (row) => <span style={{ color: 'var(--admin-danger)' }}>{(row.sell_lots || 0).toFixed(2)}</span> },
  { header: 'Net Lots', isMono: true, render: (row) => (row.net_lots || 0).toFixed(2) },
  {
    header: 'Direction',
    render: (row) => (
      <span
        style={{
          padding: '2px 8px',
          borderRadius: 'var(--radius-pill)',
          fontSize: '11px',
          fontWeight: 700,
          background: row.net_direction === 'BUY'
            ? 'color-mix(in srgb, var(--admin-success) 12%, transparent)'
            : row.net_direction === 'SELL'
              ? 'color-mix(in srgb, var(--admin-danger) 12%, transparent)'
              : 'color-mix(in srgb, var(--admin-text-faint) 12%, transparent)',
          color: row.net_direction === 'BUY'
            ? 'var(--admin-success)'
            : row.net_direction === 'SELL'
              ? 'var(--admin-danger)'
              : 'var(--admin-text-muted)',
        }}
      >
        {row.net_direction || 'FLAT'}
      </span>
    )
  },
  {
    header: 'Floating PnL',
    isMono: true,
    render: (row) => (
      <span style={{ color: (row.floating_pnl || 0) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
        {(row.floating_pnl || 0) >= 0 ? '+' : ''}${(row.floating_pnl || 0).toFixed(2)}
      </span>
    )
  },
  { header: 'Open Trades', key: 'trade_count' }
];

export function AdminDashboardExposureTable({ loading, error, exposure }) {
  if (loading || error || !exposure?.length) return null;

  return (
    <div className="admin-card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--admin-border)' }}>
        <h2 className="admin-h2" style={{ margin: 0 }}>Live Hedge Exposure</h2>
      </div>
      <AdminDataTable columns={EXPOSURE_COLUMNS} data={exposure} emptyMessage="No open trades" />
    </div>
  );
}
