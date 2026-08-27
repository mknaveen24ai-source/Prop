import React from 'react';
import {
  BarChart, Bar, ScatterChart, Scatter, XAxis, YAxis, ZAxis,
  CartesianGrid, Tooltip, Legend, Cell
} from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, ChartGrid, SectionHeading, SectionNote,
  MetricRow, fmtMoney, fmtNumber, fmtPct, fmtDate, toneFor, seriesColor
} from './shared';
import { SurvivalCurve, Funnel } from './charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Firm Intelligence → Models & Pricing (B26–B40).
//
// The tab that answers "are our challenges priced and ruled correctly". Its
// centrepiece is the bind-rate table: of the accounts that failed, how many were
// killed by a specific rule rather than by losing money. That distinction is the
// difference between a rule that protects the firm and one that just harvests
// fees, and nothing in the product exposed it before.

export default function ModelsTab({ adminAxios, dateRange, onUpdated }) {
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/models', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const waterfall = data.pass_rates.waterfall;
  const totalAccounts = waterfall.reduce((s, w) => s + w.accounts, 0);
  const totalPassed = waterfall.reduce((s, w) => s + w.passed, 0);
  const totalResolved = waterfall.reduce((s, w) => s + w.resolved, 0);

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="challenges" label="Accounts Started" value={fmtNumber(totalAccounts)} />
        <AdminStatCard icon="approve" label="Passed" value={fmtNumber(totalPassed)} />
        <AdminStatCard
          icon="target"
          label="Overall Pass Rate"
          value={fmtPct(totalResolved > 0 ? (totalPassed / totalResolved) * 100 : null)}
        />
        <AdminStatCard icon="funded" label="Funded Accounts" value={fmtNumber(waterfall.find((w) => w.phase === 'funded')?.accounts || 0)} />
      </AdminStatGrid>

      {/* B35, B26 */}
      <ChartGrid>
        <Funnel
          title="Phase Waterfall"
          eyebrow="B35 · accounts started per phase"
          stages={waterfall.map((w) => ({ stage: w.phase, count: w.accounts }))}
        />

        <AdminChart
          title="Pass Rate by Model"
          eyebrow="B26 · passed over resolved"
          height={280}
          empty={data.pass_rates.models.length ? null : 'No accounts created in this window.'}
        >
          <BarChart data={data.pass_rates.models.map((m) => ({ model: m.model_slug, pass_rate: m.totals.pass_rate_pct, accounts: m.totals.accounts }))}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="model" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `${v}%`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value, name) => (name === 'Pass rate' ? fmtPct(value) : fmtNumber(value))} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="pass_rate" name="Pass rate" fill="var(--admin-success)" />
          </BarChart>
        </AdminChart>
      </ChartGrid>

      {/* B27 */}
      <SectionHeading>Why Accounts Fail</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Fail-Cause Decomposition"
          eyebrow={`B27 · ${fmtNumber(data.fail_causes.total_failed)} failed accounts`}
          height={280}
          empty={data.fail_causes.causes.length ? null : 'No failed accounts in this window.'}
        >
          <BarChart data={data.fail_causes.causes} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
            <XAxis type="number" {...chartThemeProps.xAxis} allowDecimals={false} />
            <YAxis type="category" dataKey="cause" {...chartThemeProps.yAxis} width={140} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="accounts" name="Accounts" fill="var(--admin-danger)">
              {data.fail_causes.causes.map((entry, index) => (
                <Cell key={entry.cause} fill={seriesColor(index)} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        <Card title="Time to Outcome" eyebrow="B28 · median days from phase start">
          <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
            {data.time_to_outcome.length === 0 ? (
              <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No resolved accounts in this window.</p>
            ) : data.time_to_outcome.map((row) => (
              <MetricRow
                key={`${row.model_slug}-${row.account_type}`}
                label={`${row.model_slug} · ${row.account_type}`}
                value={
                  <>
                    <span style={{ color: 'var(--admin-success)' }}>{row.median_days_to_pass === null ? '—' : `${row.median_days_to_pass}d pass`}</span>
                    {' / '}
                    <span style={{ color: 'var(--admin-danger)' }}>{row.median_days_to_fail === null ? '—' : `${row.median_days_to_fail}d fail`}</span>
                  </>
                }
              />
            ))}
          </div>
          <SectionNote>One cause is assigned per failed account in fixed precedence, so the buckets above sum to the failure count rather than double-counting.</SectionNote>
        </Card>
      </ChartGrid>

      {/* B29 */}
      <SectionHeading>Account Survival</SectionHeading>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <SurvivalCurve
          title="Share of Accounts Still Alive"
          eyebrow="B29 · by days since creation"
          models={data.survival}
        />
      </div>

      {/* B31, B32, B33 — the heart of the tab */}
      <SectionHeading
        action={
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => downloadCsv('rule-bind-rates.csv', data.bind_rates, [
              { header: 'Model', value: (r) => r.model_slug },
              { header: 'Accounts', value: (r) => r.accounts },
              { header: 'Reached target', value: (r) => r.reached_target },
              { header: 'Blocked by min days', value: (r) => r.blocked_by_min_days },
              { header: 'Blocked by consistency', value: (r) => r.blocked_by_consistency },
              { header: 'Expired in profit', value: (r) => r.expired_in_profit }
            ])}
          >
            Export CSV
          </button>
        }
      >
        Which Rule Actually Bound
      </SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Accounts', render: (r) => fmtNumber(r.accounts), isMono: true },
            { header: 'Reached target', render: (r) => fmtNumber(r.reached_target), isMono: true },
            {
              header: 'Blocked: min days',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: r.min_days_bind_pct > 20 ? 'var(--admin-warning)' : 'var(--admin-text)' }}>{fmtNumber(r.blocked_by_min_days)} ({fmtPct(r.min_days_bind_pct)})</span>
            },
            {
              header: 'Blocked: consistency',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: r.consistency_bind_pct > 20 ? 'var(--admin-warning)' : 'var(--admin-text)' }}>{fmtNumber(r.blocked_by_consistency)} ({fmtPct(r.consistency_bind_pct)})</span>
            },
            {
              header: 'Expired in profit',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: r.time_limit_bind_pct > 10 ? 'var(--admin-danger)' : 'var(--admin-text)' }}>{fmtNumber(r.expired_in_profit)} ({fmtPct(r.time_limit_bind_pct)})</span>
            }
          ]}
          data={data.bind_rates}
          emptyMessage="No accounts in this window"
          emptyIcon="rules"
        />
      </Card>
      <SectionNote>
        A high bind rate means the rule, not the market, is deciding outcomes on that model. &quot;Expired in profit&quot; counts accounts that ran out of time while still up — the cohort most likely to open a dispute.
      </SectionNote>

      {/* B30 */}
      <SectionHeading>Daily Drawdown Sensitivity</SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Threshold', render: (r) => fmtPct(r.threshold_pct), isMono: true },
            { header: 'Accounts', render: (r) => fmtNumber(r.accounts), isMono: true },
            { header: 'Breaching now', render: (r) => `${fmtNumber(r.breached_now)} (${fmtPct(r.breach_rate_pct)})`, isMono: true },
            {
              header: '1pt looser',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-success)' }}>{r.delta_if_1pct_looser > 0 ? '+' : ''}{fmtNumber(r.delta_if_1pct_looser)}</span>
            },
            {
              header: '1pt tighter',
              render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-danger)' }}>{r.delta_if_1pct_tighter > 0 ? '+' : ''}{fmtNumber(r.delta_if_1pct_tighter)}</span>
            }
          ]}
          data={data.rule_sensitivity}
          emptyMessage="No daily P&L records in this window"
          emptyIcon="drawdown"
        />
      </Card>
      <SectionNote>
        A real counterfactual, not a model: each account&apos;s single worst day is compared against thresholds one point either side of the current one. These are the accounts whose outcome the change would have flipped.
      </SectionNote>

      {/* B34 */}
      <SectionHeading>Difficulty against Price</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart
          title="Is Difficulty Priced Correctly?"
          eyebrow="B34 · each point is a model"
          height={320}
          empty={data.difficulty.models.some((m) => m.avg_price !== null) ? null : 'No active pricing rows to compare against.'}
        >
          <ScatterChart margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
            <CartesianGrid {...chartThemeProps.grid} vertical />
            <XAxis type="number" dataKey="difficulty_score" name="Difficulty" {...chartThemeProps.xAxis} />
            <YAxis type="number" dataKey="avg_price" name="Price" {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <ZAxis type="number" dataKey="accounts" range={[60, 400]} name="Accounts" />
            <Tooltip
              {...chartThemeProps.tooltip}
              cursor={{ strokeDasharray: '3 3' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload;
                return (
                  <div style={{ ...chartThemeProps.tooltip.contentStyle, padding: 'var(--space-3)', border: '1px solid var(--admin-border-strong)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 'var(--space-1)' }}>{p.model_name}</div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>
                      Difficulty {p.difficulty_score}<br />
                      Price {fmtMoney(p.avg_price)}<br />
                      Pass rate {fmtPct(p.pass_rate_pct)}<br />
                      {fmtNumber(p.accounts)} accounts
                    </div>
                  </div>
                );
              }}
            />
            <Scatter data={data.difficulty.models.filter((m) => m.avg_price !== null)} fill="var(--admin-accent)">
              {data.difficulty.models.filter((m) => m.avg_price !== null).map((m, index) => (
                <Cell key={m.model_slug} fill={m.is_active ? seriesColor(index) : 'var(--admin-text-faint)'} />
              ))}
            </Scatter>
          </ScatterChart>
        </AdminChart>
      </ChartGrid>
      <SectionNote>
        Difficulty is a composite of the model&apos;s own rule matrix, weighted as {Object.entries(data.difficulty.weights).map(([k, v]) => `${k.replace(/_/g, ' ')} ×${v}`).join(', ')}. It is the platform&apos;s judgement, exposed here so it can be argued with rather than trusted blindly.
      </SectionNote>

      {/* B37, B36, B38 */}
      <SectionHeading>Unit Economics per Model</SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={[
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Orders', render: (r) => fmtNumber(r.orders), isMono: true },
            { header: 'Avg fee', render: (r) => fmtMoney(r.avg_fee, { decimals: 2 }), isMono: true },
            { header: 'Pass probability', render: (r) => fmtPct(r.pass_probability_pct), isMono: true },
            { header: 'Avg payout', render: (r) => fmtMoney(r.avg_payout), isMono: true },
            {
              header: 'Expected value',
              render: (r) => (r.expected_value === null
                ? <span style={{ color: 'var(--admin-text-faint)' }}>no resolved accounts</span>
                : <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.expected_value), fontWeight: 600 }}>{fmtMoney(r.expected_value, { decimals: 2 })}</span>)
            }
          ]}
          data={data.expected_value}
          emptyMessage="No orders in this window"
          emptyIcon="pnl"
        />
      </Card>

      <ChartGrid>
        <Card title="Funded Lifecycle" eyebrow="B36">
          {data.funded_lifecycle.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No funded accounts created in this window.</p>
          ) : data.funded_lifecycle.map((row) => (
            <div key={row.model_slug} style={{ marginBottom: 'var(--space-4)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-1)' }}>
                <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{row.model_slug}</strong>
                <AdminBadge bracket status={row.survival_pct >= 50 ? 'approved' : 'warn'} label={`${fmtNumber(row.funded_accounts)} funded`} />
              </div>
              <MetricRow label="Still active" value={fmtPct(row.survival_pct)} />
              <MetricRow label="Reached a payout" value={fmtPct(row.payout_conversion_pct)} />
              <MetricRow label="Days to first payout" value={row.avg_days_to_first_payout === null ? '—' : fmtNumber(row.avg_days_to_first_payout, 1)} />
            </div>
          ))}
        </Card>

        <Card title="Scaling &amp; Retries" eyebrow="B38 · B39">
          {data.scaling.map((row) => (
            <div key={row.model_slug} style={{ marginBottom: 'var(--space-3)' }}>
              <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{row.model_slug}</strong>
              <MetricRow label="Scaling uptake" value={fmtPct(row.uptake_pct)} />
              <MetricRow label="Average multiplier" value={`${fmtNumber(row.avg_multiplier, 2)}×`} />
              <MetricRow label="Added notional" value={fmtMoney(row.added_notional)} />
            </div>
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Pass rate with retry left" value={fmtPct(data.retry_impact.with_retry_remaining.pass_rate_pct)} />
            <MetricRow label="Pass rate, retry exhausted" value={fmtPct(data.retry_impact.retry_exhausted.pass_rate_pct)} />
            <SectionNote>{data.retry_impact.note}</SectionNote>
          </div>
        </Card>
      </ChartGrid>

      {/* B40 */}
      <SectionHeading>Rule Changes and What Followed</SectionHeading>
      <Card flush>
        <AdminDataTable
          columns={[
            { header: 'Changed', render: (r) => fmtDate(r.changed_at), isMono: true },
            { header: 'Setting', key: 'key', isMono: true },
            { header: 'From → To', render: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{r.old_value ?? '—'} → {r.new_value ?? '—'}</span> },
            { header: 'Accounts before', render: (r) => fmtNumber(r.accounts_before), isMono: true },
            { header: 'Accounts after', render: (r) => fmtNumber(r.accounts_after), isMono: true },
            { header: 'Pass rate before', render: (r) => fmtPct(r.pass_rate_before_pct), isMono: true },
            { header: 'Pass rate after', render: (r) => fmtPct(r.pass_rate_after_pct), isMono: true }
          ]}
          data={data.rule_changes}
          emptyMessage="No settings changed in this window"
          emptyIcon="settings"
        />
      </Card>
      <SectionNote>Fourteen days either side of each change. Correlational — other things move in a fortnight too.</SectionNote>
    </>
  );
}
