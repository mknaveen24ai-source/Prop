import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, ChartGrid, SectionHeading, SectionNote,
  MetricRow, LastUpdated, fmtMoney, fmtNumber, fmtPct, fmtDateTime, toneFor
} from './shared';
import { Meter } from './charts';

const POLL_MS = 5000;

// Firm Intelligence → Live Pulse.
//
// The only tab that reads exclusively live tables, never the rollups: this is
// what an operator watches during trading hours, so every figure has to be true
// to the second. Polls every 5s, matching the existing RealTimeMonitoringTab.

export default function PulseTab({ adminAxios, onUpdated }) {
  const { data, loading, error, updatedAt } = useIntelligence(adminAxios, '/api/admin/intelligence/pulse', {
    intervalMs: POLL_MS
  });

  React.useEffect(() => { if (updatedAt) onUpdated?.(updatedAt); }, [updatedAt, onUpdated]);

  if (loading) return <TabLoading stats={6} />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const { today, floating, exposure, drawdown, violations, queue, feed } = data;
  const buyLots = exposure.instruments.reduce((s, i) => s + i.buy_lots, 0);
  const sellLots = exposure.instruments.reduce((s, i) => s + i.sell_lots, 0);
  const totalLots = buyLots + sellLots;
  const buyPct = totalLots > 0 ? Math.round((buyLots / totalLots) * 100) : 50;

  return (
    <>
      <div style={{ marginBottom: 'var(--space-4)' }}>
        <LastUpdated at={updatedAt} intervalMs={POLL_MS} />
      </div>

      <AdminStatGrid>
        <AdminStatCard icon="pnl" label="Revenue Today" value={fmtMoney(today.revenue_today)} />
        <AdminStatCard
          icon="floating_up"
          label="Floating Trader P&L"
          value={<span style={{ color: toneFor(floating.floating_demo_pnl) }}>{fmtMoney(floating.floating_demo_pnl, { signed: true })}</span>}
        />
        <AdminStatCard
          icon="target"
          label="Firm Edge Today"
          value={<span style={{ color: toneFor(today.firm_edge_today) }}>{fmtMoney(today.firm_edge_today, { signed: true })}</span>}
        />
        <AdminStatCard icon="trades" label="Open Positions" value={fmtNumber(floating.open_trades)} />
        <AdminStatCard
          icon="drawdown"
          label={`Near Drawdown (≥${drawdown.warning_threshold_pct}%)`}
          value={fmtNumber(drawdown.at_risk_count)}
          alert={drawdown.at_risk_count > 0}
        />
        <AdminStatCard
          icon="violations"
          label="Open Violations"
          value={fmtNumber(violations.open_total)}
          alert={violations.open_by_severity.some((s) => ['high', 'critical'].includes(s.severity))}
        />
      </AdminStatGrid>

      <ChartGrid>
        <Card title="Today So Far" eyebrow="since 00:00 UTC">
          <MetricRow label="Paid orders" value={fmtNumber(today.orders_today)} />
          <MetricRow label="Revenue" value={fmtMoney(today.revenue_today)} tone="var(--admin-success)" />
          <MetricRow label="Signups" value={fmtNumber(today.signups_today)} />
          <MetricRow label="Trades opened" value={fmtNumber(today.trades_opened_today)} />
          <MetricRow
            label="Realised trader P&L"
            value={fmtMoney(today.realised_trader_pnl_today, { signed: true })}
            tone={toneFor(today.realised_trader_pnl_today)}
          />
          <MetricRow label="Accounts passed" value={fmtNumber(today.passes_today)} tone="var(--admin-success)" />
          <MetricRow label="Accounts failed" value={fmtNumber(today.failures_today)} tone="var(--admin-danger)" />
        </Card>

        <Card title="Waiting on the Firm" eyebrow="live queues">
          <MetricRow
            label="Payouts pending"
            value={`${fmtNumber(queue.payouts_pending)} · ${fmtMoney(queue.payouts_pending_value)}`}
            tone={queue.payouts_pending > 0 ? 'var(--admin-warning)' : undefined}
          />
          <MetricRow label="Payouts flagged" value={fmtNumber(queue.payouts_flagged)} tone={queue.payouts_flagged > 0 ? 'var(--admin-danger)' : undefined} />
          <MetricRow label="KYC pending" value={fmtNumber(queue.kyc_pending)} />
          <MetricRow label="Promotions pending" value={fmtNumber(queue.promotions_pending)} />
          <MetricRow label="Disputes open" value={fmtNumber(queue.disputes_open)} />
          <MetricRow label="Tickets open" value={fmtNumber(queue.tickets_open)} />
          <MetricRow label="Emails queued" value={fmtNumber(queue.emails_queued)} />
          <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow
              label="Price feed instruments"
              value={`${fmtNumber(feed.instruments)}${feed.stale_over_60s > 0 ? ` · ${feed.stale_over_60s} stale` : ''}`}
              tone={feed.stale_over_60s > 0 ? 'var(--admin-danger)' : 'var(--admin-success)'}
            />
          </div>
        </Card>
      </ChartGrid>

      <SectionHeading>Live Exposure</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Open Lots per Instrument"
          eyebrow={`${fmtNumber(exposure.total_positions)} positions · ${fmtNumber(exposure.total_lots, 2)} lots`}
          height={280}
          empty={exposure.instruments.length ? null : 'No open positions right now.'}
        >
          <BarChart data={exposure.instruments}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="instrument" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtNumber(value, 2)} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="buy_lots" stackId="lots" name="Buy" fill="var(--admin-success)" />
            <Bar dataKey="sell_lots" stackId="lots" name="Sell" fill="var(--admin-danger)" />
          </BarChart>
        </AdminChart>

        <Card title="Directional Bias &amp; Concentration" eyebrow="live book">
          <div style={{ display: 'flex', height: '28px', border: '1px solid var(--rule)', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ width: `${buyPct}%`, background: 'var(--admin-success)', opacity: 0.8 }} />
            <div style={{ width: `${100 - buyPct}%`, background: 'var(--admin-danger)', opacity: 0.8 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 'var(--fs-sm)' }}>
            <span style={{ color: 'var(--admin-success)' }}>BUY {buyPct}% · {fmtNumber(buyLots, 2)} lots</span>
            <span style={{ color: 'var(--admin-danger)' }}>SELL {100 - buyPct}% · {fmtNumber(sellLots, 2)} lots</span>
          </div>

          <div style={{ marginTop: 'var(--space-5)' }}>
            {exposure.concentration.length === 0 ? (
              <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No open exposure.</p>
            ) : exposure.concentration.map((c) => (
              <Meter
                key={c.instrument}
                label={c.instrument}
                value={c.share_pct ?? 0}
                caption={`${fmtPct(c.share_pct)} of all open lots`}
              />
            ))}
          </div>
          <SectionNote>
            A single instrument carrying most of the book is the concentration risk that turns one bad print into a firm-wide event.
          </SectionNote>
        </Card>
      </ChartGrid>

      <SectionHeading>Accounts Near the Line</SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Account', render: (r) => r.account_uid || String(r.account_id).slice(0, 8), isMono: true },
            { header: 'Trader', render: (r) => r.trader || '—' },
            { header: 'Type', render: (r) => <AdminBadge bracket status={r.account_type} label={r.account_type} /> },
            { header: 'Equity', render: (r) => fmtMoney(r.equity), isMono: true },
            { header: 'Floor', render: (r) => fmtMoney(r.floor), isMono: true },
            {
              header: 'Headroom',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: r.headroom < 0 ? 'var(--admin-danger)' : toneFor(r.headroom) }}>{fmtMoney(r.headroom)}</span>
            },
            {
              header: 'Allowance used',
              render: (r) => (
                <span style={{
                  fontFamily: 'var(--font-mono)', fontWeight: 700,
                  color: (r.allowance_used_pct ?? 0) >= 90 ? 'var(--admin-danger)' : 'var(--admin-warning)'
                }}>{fmtPct(r.allowance_used_pct)}</span>
              )
            },
            {
              header: 'Floating',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.floating_pnl) }}>{fmtMoney(r.floating_pnl, { signed: true })}</span>
            }
          ]}
          data={drawdown.at_risk}
          emptyMessage={`No active account has consumed ${drawdown.warning_threshold_pct}% of its drawdown allowance`}
          emptyIcon="approve"
        />
      </Card>
      <SectionNote>
        {fmtNumber(drawdown.active_accounts)} active accounts scanned. {fmtNumber(drawdown.breached_now)} are already below their floor.
        Headroom is measured against the same trailing floor the drawdown engine itself maintains, not a second calculation.
      </SectionNote>

      <SectionHeading>Violations Firing Now</SectionHeading>
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-3)' }}>
        {violations.open_by_severity.map((s) => (
          <AdminBadge key={s.severity} bracket status={s.severity} label={`${s.severity} ${s.violations}`} />
        ))}
      </div>
      <Card flush>
        <AdminDataTable
          columns={[
            { header: 'Detected', render: (r) => fmtDateTime(r.last_detected_at), isMono: true },
            { header: 'Type', key: 'violation_type', isMono: true },
            { header: 'Severity', render: (r) => <AdminBadge bracket status={r.severity} label={r.severity} /> },
            { header: 'Trader', render: (r) => r.trader || '—' },
            { header: 'Instrument', render: (r) => r.instrument || '—', isMono: true },
            { header: 'Hits', render: (r) => fmtNumber(r.hit_count), isMono: true },
            { header: 'Message', render: (r) => r.message || '—' }
          ]}
          data={violations.recent}
          emptyMessage="No open violations"
          emptyIcon="approve"
        />
      </Card>
    </>
  );
}
