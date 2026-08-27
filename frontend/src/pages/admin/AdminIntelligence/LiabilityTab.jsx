import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart, Line, Cell
} from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, ChartGrid, SectionHeading, SectionNote,
  MetricRow, fmtMoney, fmtNumber, fmtPct, fmtDuration, seriesColor
} from './shared';
import { Meter } from './charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Firm Intelligence → Payouts & Liability (C41–C52).
//
// The solvency view. Forecast liability (what we would owe if everyone withdrew
// today) is kept strictly separate from committed liability (what has already
// been requested), because they are different kinds of obligation and summing
// them into one headline would overstate the immediate call on cash.

export default function LiabilityTab({ adminAxios, dateRange, onUpdated }) {
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/liability', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const f = data.forecast;
  const ratio = data.payout_to_revenue;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard
          icon="drawdown"
          label="Forecast Liability"
          value={fmtMoney(f.forecast_liability)}
          alert={ratio.rolling_30d.ratio_pct !== null && ratio.rolling_30d.ratio_pct > 80}
        />
        <AdminStatCard icon="payouts" label="Already Requested" value={fmtMoney(f.committed.amount_payable)} />
        <AdminStatCard icon="funded" label="Funded Accounts Live" value={fmtNumber(f.funded_active)} />
        <AdminStatCard icon="target" label="In Profit" value={fmtNumber(f.accounts_in_profit)} />
        <AdminStatCard
          icon="pnl"
          label="Payout : Revenue (30d)"
          value={<span style={{ color: (ratio.rolling_30d.ratio_pct ?? 0) > 80 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>{fmtPct(ratio.rolling_30d.ratio_pct)}</span>}
        />
        <AdminStatCard icon="timer" label="Open Queue" value={fmtNumber(data.pipeline.open_queue.count)} />
      </AdminStatGrid>

      {/* C50 */}
      <ChartGrid min={520}>
        <AdminChart title="Revenue against Payouts" eyebrow="C50 · last 90 days" height={300}>
          <ComposedChart data={ratio.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="revenue" name="Revenue" fill="var(--admin-accent)" />
            <Line type="monotone" dataKey="payouts" name="Payouts" stroke="var(--admin-danger)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </AdminChart>
      </ChartGrid>

      <ChartGrid>
        <Card title="Solvency Ratios" eyebrow="C50 · payouts as a share of revenue">
          <Meter
            label="Rolling 30 days"
            value={ratio.rolling_30d.ratio_pct ?? 0}
            caption={`${fmtMoney(ratio.rolling_30d.payouts)} paid against ${fmtMoney(ratio.rolling_30d.revenue)} earned`}
          />
          <Meter
            label="Rolling 90 days"
            value={ratio.rolling_90d.ratio_pct ?? 0}
            caption={`${fmtMoney(ratio.rolling_90d.payouts)} paid against ${fmtMoney(ratio.rolling_90d.revenue)} earned`}
          />
          <Meter
            label="All time in rollup"
            value={ratio.all_time_in_rollup.ratio_pct ?? 0}
            caption={`${fmtMoney(ratio.all_time_in_rollup.payouts)} paid against ${fmtMoney(ratio.all_time_in_rollup.revenue)} earned`}
          />
        </Card>

        <Card title="Payout Queue Aging" eyebrow="C42 · open requests">
          <MetricRow label="Open requests" value={fmtNumber(data.pipeline.open_queue.count)} />
          <MetricRow
            label="Oldest waiting"
            value={data.pipeline.open_queue.oldest_days === null ? '—' : `${fmtNumber(data.pipeline.open_queue.oldest_days, 1)} days`}
            tone={(data.pipeline.open_queue.oldest_days ?? 0) > 7 ? 'var(--admin-danger)' : undefined}
          />
          <MetricRow label="Median age" value={data.pipeline.open_queue.median_age_days === null ? '—' : `${fmtNumber(data.pipeline.open_queue.median_age_days, 1)} days`} />
          <MetricRow label="Median turnaround" value={fmtDuration(data.pipeline.turnaround_hours.median === null ? null : data.pipeline.turnaround_hours.median * 60)} />
          <MetricRow label="p90 turnaround" value={fmtDuration(data.pipeline.turnaround_hours.p90 === null ? null : data.pipeline.turnaround_hours.p90 * 60)} />
          <MetricRow label="Rejection rate" value={fmtPct(data.pipeline.decisions.rejection_pct)} tone="var(--admin-warning)" />
          <div style={{ marginTop: 'var(--space-4)' }}>
            {data.pipeline.open_queue.buckets.map((b) => (
              <MetricRow key={b.label} label={b.label} value={fmtNumber(b.payouts)} />
            ))}
          </div>
        </Card>
      </ChartGrid>

      {/* C41 */}
      <SectionHeading
        action={
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => downloadCsv('liability-exposure.csv', f.top_exposures, [
              { header: 'Account', value: (r) => r.account_uid || r.account_id },
              { header: 'Trader', value: (r) => r.trader },
              { header: 'Model', value: (r) => r.model_slug },
              { header: 'Unrealised profit', value: (r) => r.unrealised_profit },
              { header: 'Split %', value: (r) => r.profit_split_pct },
              { header: 'Trader share', value: (r) => r.trader_share }
            ])}
          >
            Export CSV
          </button>
        }
      >
        Largest Live Exposures
      </SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Account', render: (r) => r.account_uid || String(r.account_id).slice(0, 8), isMono: true },
            { header: 'Trader', render: (r) => r.trader || '—' },
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Account size', render: (r) => fmtMoney(r.account_size), isMono: true },
            { header: 'Unrealised profit', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-success)' }}>{fmtMoney(r.unrealised_profit)}</span> },
            { header: 'Split', render: (r) => fmtPct(r.profit_split_pct, 0), isMono: true },
            { header: 'Firm would owe', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtMoney(r.trader_share)}</span> }
          ]}
          data={f.top_exposures}
          emptyMessage="No funded account is currently in profit"
          emptyIcon="funded"
        />
      </Card>
      <SectionNote>
        Forecast liability is what the firm would owe if every funded account withdrew its full profit today. It is deliberately not added to the {fmtMoney(f.committed.amount_payable)} already requested — those are different obligations.
      </SectionNote>

      {/* C52 */}
      <SectionHeading>Stress Test</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Liability if Evaluations Pass"
          eyebrow="C52 · scenarios"
          height={260}
          empty={data.stress.scenarios.some((s) => s.liability > 0) ? null : 'No payout history to scale scenarios against.'}
        >
          <BarChart data={data.stress.scenarios}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="pass_share_pct" {...chartThemeProps.xAxis} tickFormatter={(v) => `${v}%`} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip
              {...chartThemeProps.tooltip}
              formatter={(value) => fmtMoney(value)}
              labelFormatter={(v) => `If ${v}% of active evaluations passed`}
            />
            <Bar dataKey="liability" name="Liability">
              {data.stress.scenarios.map((s) => (
                <Cell key={s.pass_share_pct} fill={(s.coverage_vs_90d_revenue_pct ?? 0) > 100 ? 'var(--admin-danger)' : 'var(--admin-warning)'} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        <Card title="Coverage" eyebrow="C52 · against 90 days of sales">
          <MetricRow label="Revenue, last 90 days" value={fmtMoney(data.stress.revenue_90d)} />
          {data.stress.scenarios.map((s) => (
            <MetricRow
              key={s.pass_share_pct}
              label={`${s.pass_share_pct}% pass (${fmtNumber(s.accounts)} accounts)`}
              value={`${fmtMoney(s.liability)} · ${fmtPct(s.coverage_vs_90d_revenue_pct)}`}
              tone={(s.coverage_vs_90d_revenue_pct ?? 0) > 100 ? 'var(--admin-danger)' : undefined}
            />
          ))}
          <SectionNote>
            Coverage compares against the last 90 days of sales, the only cash figure the database holds. It is not a treasury balance.
            {data.stress.note ? ` ${data.stress.note}` : ''}
          </SectionNote>
        </Card>
      </ChartGrid>

      {/* C44, C45, C46, C47 */}
      <SectionHeading>Payout Behaviour</SectionHeading>
      <ChartGrid>
        <Card title="Size &amp; Cadence" eyebrow="C44 · C45 · C46">
          <MetricRow label="Payouts settled" value={fmtNumber(data.distribution.payouts)} />
          <MetricRow label="Total paid" value={fmtMoney(data.distribution.total_paid)} />
          <MetricRow label="Median payout" value={fmtMoney(data.distribution.median)} />
          <MetricRow label="Mean payout" value={fmtMoney(data.distribution.mean)} />
          <MetricRow label="p90 payout" value={fmtMoney(data.distribution.p90)} />
          <MetricRow label="Largest" value={fmtMoney(data.distribution.largest)} tone="var(--admin-warning)" />
          <MetricRow label="Median days to first payout" value={data.cadence.time_to_first_payout_days.median === null ? '—' : fmtNumber(data.cadence.time_to_first_payout_days.median, 1)} />
          <MetricRow label="Repeat payout rate" value={fmtPct(data.cadence.repeat_pct)} />
          <MetricRow label="Payouts per paying account" value={fmtNumber(data.cadence.avg_payouts_per_account, 2)} />
        </Card>

        <Card title="Concentration" eyebrow="C47 · share of all payout value">
          <Meter label="Top 1% of traders" value={data.distribution.concentration.top_1_pct_share ?? 0} />
          <Meter label="Top 5% of traders" value={data.distribution.concentration.top_5_pct_share ?? 0} />
          <Meter label="Top 10% of traders" value={data.distribution.concentration.top_10_pct_share ?? 0} />
          <SectionNote>
            {fmtNumber(data.distribution.concentration.traders)} distinct traders received a payout in this window. Heavy concentration means the firm&apos;s payout cost is driven by a handful of relationships.
          </SectionNote>
        </Card>
      </ChartGrid>

      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={[
            { header: 'Trader', render: (r) => r.trader || '—' },
            { header: 'Payouts', render: (r) => fmtNumber(r.payouts), isMono: true },
            { header: 'Total received', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{fmtMoney(r.amount)}</span> }
          ]}
          data={data.distribution.top_earners}
          emptyMessage="No settled payouts in this window"
          emptyIcon="payouts"
        />
      </Card>

      {/* C48, C49, C51 */}
      <SectionHeading>Split Integrity, Flags and Methods</SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Payouts', render: (r) => fmtNumber(r.payouts), isMono: true },
            { header: 'Requested', render: (r) => fmtMoney(r.requested), isMono: true },
            { header: 'Paid to trader', render: (r) => fmtMoney(r.payable), isMono: true },
            { header: 'Firm cut', render: (r) => fmtMoney(r.firm_cut), isMono: true },
            { header: 'Configured split', render: (r) => fmtPct(r.configured_split_pct, 0), isMono: true },
            { header: 'Realised split', render: (r) => fmtPct(r.realised_split_pct), isMono: true },
            {
              header: 'Drift',
              render: (r) => (r.drift_pct_points === null
                ? '—'
                : <span style={{ fontFamily: 'var(--font-mono)', color: Math.abs(r.drift_pct_points) > 1 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>
                  {r.drift_pct_points > 0 ? '+' : ''}{fmtNumber(r.drift_pct_points, 1)}pt
                </span>)
            }
          ]}
          data={data.split_leakage}
          emptyMessage="No settled payouts in this window"
          emptyIcon="payouts"
        />
      </Card>
      <SectionNote>Drift is realised trader share minus the split the model configures. Anything beyond a point in either direction is worth an explanation.</SectionNote>

      <ChartGrid>
        <Card title="Flagged Payouts" eyebrow="C49">
          <MetricRow label="Requests in window" value={fmtNumber(data.flagged.total)} />
          <MetricRow label="Flagged" value={`${fmtNumber(data.flagged.flagged)} (${fmtPct(data.flagged.flag_rate_pct)})`} tone="var(--admin-warning)" />
          <MetricRow label="Flagged then paid" value={fmtNumber(data.flagged.flagged_paid)} />
          <MetricRow label="Flagged then rejected" value={fmtNumber(data.flagged.flagged_rejected)} tone="var(--admin-danger)" />
          <MetricRow label="Flags upheld at decision" value={fmtPct(data.flagged.upheld_pct)} />
          <MetricRow label="Value flagged" value={fmtMoney(data.flagged.flagged_value)} />
          <div style={{ marginTop: 'var(--space-3)' }}>
            {data.flagged.reasons.map((r) => (
              <MetricRow key={r.reason} label={r.reason} value={fmtNumber(r.payouts)} mono={false} />
            ))}
          </div>
          <SectionNote>A low upheld rate means the flag rule is noisy and costing review time; a high one means it is earning its place.</SectionNote>
        </Card>

        <Card title="Withdrawal Methods" eyebrow="C51">
          {data.payment_methods.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No payout requests in this window.</p>
          ) : data.payment_methods.map((mth) => (
            <div key={mth.method} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-1)' }}>
                <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{mth.method}</strong>
                <AdminBadge bracket status={mth.success_pct >= 90 ? 'approved' : 'warn'} label={fmtPct(mth.success_pct)} />
              </div>
              <MetricRow label="Requests" value={fmtNumber(mth.requests)} />
              <MetricRow label="Paid value" value={fmtMoney(mth.paid_amount)} />
              <MetricRow label="Average turnaround" value={fmtDuration(mth.avg_turnaround_hours === null ? null : mth.avg_turnaround_hours * 60)} />
            </div>
          ))}
        </Card>
      </ChartGrid>

      <SectionHeading>Pipeline by Status</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart
          title="Requests and Value by Status"
          eyebrow="C42"
          height={240}
          empty={data.pipeline.statuses.length ? null : 'No payout requests in this window.'}
        >
          <BarChart data={data.pipeline.statuses}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="status" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Bar dataKey="payable" name="Payable">
              {data.pipeline.statuses.map((s, index) => (
                <Cell key={s.status} fill={seriesColor(index)} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>
      </ChartGrid>
    </>
  );
}
