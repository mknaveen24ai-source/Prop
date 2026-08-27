import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import AdminStatCard from '../AdminStatCard';
import AdminStatGrid from '../AdminStatGrid';
import AdminChart, { chartThemeProps, renderActiveDonutArc, dimUnlessActive } from '../AdminChart';
import AdminDataTable from '../AdminDataTable';
import { ChartSkeleton } from './AdminDashboardFeedback';
import Card from '../../ui/Card';
import { renderIcon } from '../../../utils/iconMap';

function EmptyChartState({ height, message }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height,
        color: 'var(--admin-text-muted)',
        fontSize: 'var(--fs-base)',
      }}
    >
      {message}
    </div>
  );
}

// Alerts row — Modern Gazette handoff spec: the top 1-3 most urgent
// conditions only, distinct from the fuller "Needs Attention" queue below.
// Renders nothing when there's nothing urgent (no fabricated filler cards).
export const ALERT_ROUTES = {
  violations: '/admin/violations',
  payouts: '/admin/payouts',
  disputes: '/admin/disputes',
};

export function AdminDashboardAlerts({ loading, error, alerts, navigate }) {
  if (loading || error || !alerts?.length) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${alerts.length}, minmax(0,1fr))`, gap: 'var(--space-3)', marginBottom: 'var(--space-6)' }}>
      {alerts.map((a) => (
        <div
          key={a.kicker}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2-5)', padding: 'var(--space-3-5) var(--space-4)',
            border: `1px solid var(--${a.tone})`, borderRadius: '4px',
            background: 'var(--glass-2)', backdropFilter: 'blur(16px) saturate(140%)',
          }}
        >
          <span style={{ display: 'inline-flex', color: `var(--${a.tone})`, marginTop: 'var(--space-1)' }}>
            {renderIcon('warning', { size: 16, color: `var(--${a.tone})` })}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.15em', textTransform: 'uppercase', color: `var(--${a.tone})` }}>{a.kicker}</div>
            <div style={{ fontSize: 'var(--fs-md)', marginTop: 'var(--space-1)', lineHeight: 1.45 }}>{a.text}</div>
          </div>
          <button
            onClick={() => navigate(ALERT_ROUTES[a.go] ? ALERT_ROUTES[a.go] : `/admin/${a.go}`)}
            style={{ alignSelf: 'center', padding: 'var(--space-1-5) var(--space-3)', border: `1px solid var(--${a.tone})`, borderRadius: '4px', background: 'transparent', color: `var(--${a.tone})`, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', whiteSpace: 'nowrap', cursor: 'pointer' }}
          >
            {a.cta}
          </button>
        </div>
      ))}
    </div>
  );
}

export function AdminDashboardStats({ loading, error, overview, kpiTrends, navigate }) {
  if (loading || error || !overview) return null;

  return (
    <AdminStatGrid gap={20}>
      <AdminStatCard
        icon="users" label="Total Users" value={(overview.users?.total || 0).toLocaleString()}
        onClick={() => navigate('/admin/users')}
        trend={kpiTrends?.users?.delta?.label} trendDirection={kpiTrends?.users?.delta?.pct > 0 ? 'up' : kpiTrends?.users?.delta?.pct < 0 ? 'down' : 'neutral'}
        spark={kpiTrends?.users?.spark}
      />
      <AdminStatCard
        icon="challenges"
        label="Active Challenges"
        value={((overview.accounts?.phase1 || 0) + (overview.accounts?.phase2 || 0)).toLocaleString()}
        onClick={() => navigate('/admin/challenges')}
      />
      <AdminStatCard
        icon="funded" label="Funded Traders" value={(overview.accounts?.funded || 0).toLocaleString()}
        onClick={() => navigate('/admin/funded')}
        trend={kpiTrends?.funded?.delta?.label} trendDirection={kpiTrends?.funded?.delta?.pct > 0 ? 'up' : kpiTrends?.funded?.delta?.pct < 0 ? 'down' : 'neutral'}
        spark={kpiTrends?.funded?.spark}
      />
      <AdminStatCard
        icon="payouts"
        label="Total Paid Out"
        value={`$${(overview.payouts?.total_paid || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/payouts')}
        trend={kpiTrends?.payouts_paid?.delta?.label} trendDirection={kpiTrends?.payouts_paid?.delta?.pct > 0 ? 'up' : kpiTrends?.payouts_paid?.delta?.pct < 0 ? 'down' : 'neutral'}
        spark={kpiTrends?.payouts_paid?.spark}
      />
      <AdminStatCard
        icon="pnl"
        label="Platform PnL (all trades)"
        value={`$${(overview.trades?.total_pnl || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onClick={() => navigate('/admin/pnl')}
        trend={kpiTrends?.pnl?.delta?.label} trendDirection={kpiTrends?.pnl?.delta?.pct > 0 ? 'up' : kpiTrends?.pnl?.delta?.pct < 0 ? 'down' : 'neutral'}
        spark={kpiTrends?.pnl?.spark}
      />
      <AdminStatCard icon="kyc" label="Pending KYC" value={overview.users?.pending_kyc || 0} onClick={() => navigate('/admin/kyc')} />
    </AdminStatGrid>
  );
}

export function AdminDashboardCharts({
  loading,
  error,
  overview,
  revenueByMonth,
  accountStatusData,
}) {
  const [statusActiveIndex, setStatusActiveIndex] = React.useState(null);
  const [revenueActiveIndex, setRevenueActiveIndex] = React.useState(null);

  if (error) return null;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        {loading ? (
          <ChartSkeleton height={220} />
        ) : (
          <AdminChart title="Gross Revenue by Month — Challenge Fees">
            {revenueByMonth?.length > 0 ? (
              <BarChart data={revenueByMonth} onMouseMove={(state) => setRevenueActiveIndex(state?.isTooltipActive ? state.activeTooltipIndex : null)} onMouseLeave={() => setRevenueActiveIndex(null)}>
                <CartesianGrid {...chartThemeProps.grid} />
                <XAxis dataKey="month" {...chartThemeProps.xAxis} />
                <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip {...chartThemeProps.tooltip} formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Challenge Fees']} />
                <Bar dataKey="revenue" fill="var(--admin-accent)" radius={[4, 4, 0, 0]} name="Challenge Fees">
                  {revenueByMonth.map((_, index) => (
                    <Cell key={index} fill="var(--admin-accent)" fillOpacity={dimUnlessActive(revenueActiveIndex, index)} />
                  ))}
                </Bar>
              </BarChart>
            ) : (
              <EmptyChartState height="220px" message="No paid challenge orders in the last 6 months" />
            )}
          </AdminChart>
        )}

        {loading ? (
          <ChartSkeleton height={220} />
        ) : accountStatusData.length > 0 ? (
          <AdminChart title={`Account Status · ${accountStatusData.reduce((sum, e) => sum + e.value, 0).toLocaleString()} accounts`}>
            <PieChart>
              <Tooltip {...chartThemeProps.tooltip} />
              <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
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
                activeIndex={statusActiveIndex}
                activeShape={renderActiveDonutArc}
                onMouseEnter={(_, index) => setStatusActiveIndex(index)}
                onMouseLeave={() => setStatusActiveIndex(null)}
              >
                {accountStatusData.map((entry, index) => (
                  <Cell
                    key={entry.name || index}
                    fill={entry.color}
                    fillOpacity={dimUnlessActive(statusActiveIndex, index)}
                    style={{ transition: 'fill-opacity 160ms ease' }}
                  />
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
    </>
  );
}

const ATTENTION_ICONS = { kyc: 'kyc', payouts: 'payouts', flagged: 'payouts', violations: 'violations', disputes: 'dispute', banned: 'users' };
const ATTENTION_ROUTES = { kyc: '/admin/kyc', payouts: '/admin/payouts', flagged: '/admin/payouts', violations: '/admin/violations', disputes: '/admin/disputes', banned: '/admin/users' };

// Challenge Pipeline funnel + Needs Attention queue — paired in one row per
// the prototype (isAdminDash: minmax(0,1fr) minmax(0,1.2fr)). The queue is a
// real sorted list (busiest first), not a static stat grid — each row is
// clickable and only appears when its count is > 0 (no fabricated zero rows).
export function AdminDashboardAttention({ loading, error, overview, funnelData, attentionQueue, attentionTotal, navigate }) {
  const [funnelActiveIndex, setFunnelActiveIndex] = React.useState(null);
  if (loading || error || !overview) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.2fr)', gap: 'var(--space-4)', alignItems: 'start', marginBottom: 'var(--space-7)' }}>
      <AdminChart title="Challenge Pipeline" eyebrow="Last 90 days · conversion at each gate">
        <BarChart data={funnelData} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--rule)" />
            <XAxis type="number" {...chartThemeProps.xAxis} allowDecimals={false} />
            <YAxis dataKey="phase" type="category" {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value, name, item) => [`${value} (${item?.payload?.pct ?? 0}%)`, 'Accounts']} cursor={{ fill: 'var(--admin-success)', fillOpacity: 0.08 }} />
            <Bar
              dataKey="count"
              fill="var(--admin-success)"
              radius={[0, 4, 4, 0]}
              barSize={30}
              name="Accounts"
              onMouseEnter={(_, index) => setFunnelActiveIndex(index)}
              onMouseLeave={() => setFunnelActiveIndex(null)}
            >
              <LabelList
                dataKey="pct"
                position="right"
                formatter={(pct) => `${pct}%`}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, fill: 'var(--admin-text-muted)' }}
              />
              {funnelData.map((_, index) => (
                <Cell
                  key={index}
                  fill="var(--admin-success)"
                  style={{
                    filter: index === funnelActiveIndex ? 'drop-shadow(0 0 6px var(--admin-success))' : 'none',
                    transition: 'filter 160ms ease',
                    cursor: 'pointer',
                  }}
                />
              ))}
            </Bar>
          </BarChart>
      </AdminChart>

      <Card
        title="Needs Attention"
        actions={attentionTotal > 0 && (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--loss)', border: '1px solid var(--loss)', borderRadius: '99px', padding: 'var(--space-1) var(--space-2-5)' }}>
            {attentionTotal} open
          </span>
        )}
      >
        {attentionQueue.length === 0 ? (
          <div style={{ padding: 'var(--space-6) var(--space-1)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-base)' }}>Nothing needs attention right now.</div>
        ) : (
          attentionQueue.map((q) => (
            <button
              key={q.key}
              onClick={() => navigate(ATTENTION_ROUTES[q.key] || '/admin')}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%', padding: 'var(--space-3) var(--space-1-5)', border: 'none', borderBottom: '1px solid var(--rule-soft)', background: 'transparent', color: 'var(--ink)', textAlign: 'left', cursor: 'pointer' }}
            >
              <span style={{ display: 'inline-flex', color: 'var(--warn)' }}>{renderIcon(ATTENTION_ICONS[q.key] || 'flag', { size: 16, color: 'var(--warn)' })}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--fs-base)' }}>{q.label}</span>
                <span style={{ display: 'block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 'var(--space-1)' }}>{q.meta}</span>
              </span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-lg)', color: 'var(--warn)' }}>{q.n}</span>
            </button>
          ))
        )}
      </Card>
    </div>
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
          padding: 'var(--space-1) var(--space-2)',
          borderRadius: 'var(--radius-pill)',
          fontSize: 'var(--fs-xs)',
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

export function AdminDashboardExposureTable({ loading, error, exposure, totalActiveAccounts }) {
  if (loading || error || !exposure?.length) return null;

  return (
    <Card
      ruled flush title="Aggregate Exposure"
      actions={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.13em', textTransform: 'uppercase', color: 'var(--muted)' }}>Net across {totalActiveAccounts.toLocaleString()} accounts · refreshes 30s</span>}
    >
      <AdminDataTable columns={EXPOSURE_COLUMNS} data={exposure} emptyMessage="No open trades" />
    </Card>
  );
}
