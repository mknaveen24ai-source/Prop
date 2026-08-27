import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  ChartGrid, SectionHeading, SectionNote, MetricRow,
  fmtMoney, fmtNumber, fmtPct, fmtDate, toneFor
} from '../AdminIntelligence/shared';
import { Meter } from '../AdminIntelligence/charts';

// Trader & Risk Intelligence → Forecast (I133–I142).

export default function ForecastTab({ data }) {
  const f = data.forecast;

  if (!f) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
        <h3 style={{ color: 'var(--admin-text)', marginBottom: 'var(--space-2)' }}>No account to forecast</h3>
        <p style={{ color: 'var(--admin-text-muted)', margin: 0, fontSize: 'var(--fs-base)' }}>
          This trader has no challenge account, so there is no target, deadline or drawdown to project against.
        </p>
      </Card>
    );
  }

  const drawdownUsedPct = f.drawdown_headroom.headroom_pct_of_allowance === null
    ? null
    : 100 - f.drawdown_headroom.headroom_pct_of_allowance;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard
          icon="target"
          label="Target Progress"
          value={<span style={{ color: (f.target.progress_pct ?? 0) >= 100 ? 'var(--admin-success)' : 'var(--admin-text)' }}>{fmtPct(f.target.progress_pct)}</span>}
        />
        <AdminStatCard
          icon="pnl"
          label="Current Profit"
          value={<span style={{ color: toneFor(f.target.current_profit) }}>{fmtMoney(f.target.current_profit, { signed: true })}</span>}
        />
        <AdminStatCard icon="calendar" label="Days Remaining" value={f.time.days_remaining === null ? '—' : fmtNumber(f.time.days_remaining)} />
        <AdminStatCard
          icon="activity"
          label="Pass Probability"
          value={f.pass_probability.probability_pct === null ? '—' : fmtPct(f.pass_probability.probability_pct)}
        />
        <AdminStatCard
          icon="drawdown"
          label="Drawdown Headroom"
          value={fmtMoney(f.drawdown_headroom.headroom)}
          alert={(drawdownUsedPct ?? 0) >= 75}
        />
        <AdminStatCard
          icon="approve"
          label="Qualifying Days"
          value={`${fmtNumber(f.qualifying_days.achieved)} / ${fmtNumber(f.qualifying_days.required)}`}
          alert={!f.qualifying_days.satisfied}
        />
      </AdminStatGrid>

      {/* I133, I135, I141 */}
      <ChartGrid>
        <Card title="Progress against Target" eyebrow={`I133 · I135 · ${f.model_slug || 'unknown model'} ${f.account_type}`}>
          <Meter
            label="Profit target"
            value={Math.min(f.target.progress_pct ?? 0, 100)}
            tone={(f.target.progress_pct ?? 0) >= 100 ? 'var(--admin-success)' : 'var(--admin-accent)'}
            caption={`${fmtMoney(f.target.current_profit)} of ${fmtMoney(f.target.profit_target)} — ${fmtMoney(f.target.remaining)} to go`}
          />
          <MetricRow label="Phase started" value={fmtDate(f.time.phase_start)} />
          <MetricRow label="Phase ends" value={fmtDate(f.time.phase_end)} />
          <MetricRow label="Trading days used" value={fmtNumber(f.time.trading_days_used)} />
          <MetricRow
            label="Required daily P&L"
            value={f.time.required_daily_pnl === null ? '—' : fmtMoney(f.time.required_daily_pnl)}
          />
          <MetricRow
            label="Projected days to target"
            value={f.time.projected_days_to_target === null ? 'not on a profitable pace' : fmtNumber(f.time.projected_days_to_target, 1)}
          />
          <MetricRow
            label="On pace"
            value={f.time.on_pace === null
              ? '—'
              : <AdminBadge bracket status={f.time.on_pace ? 'approved' : 'danger'} label={f.time.on_pace ? 'yes' : 'no'} />}
          />
        </Card>

        {/* I134 */}
        <Card title="Pass Probability" eyebrow="I134 · empirical, not modelled">
          <div style={{
            fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
            fontSize: 'clamp(28px, 5vw, 44px)', fontWeight: 700,
            color: (f.pass_probability.probability_pct ?? 0) >= 50 ? 'var(--admin-success)' : 'var(--admin-warning)',
            lineHeight: 1, marginBottom: 'var(--space-3)'
          }}>
            {f.pass_probability.probability_pct === null ? '—' : fmtPct(f.pass_probability.probability_pct)}
          </div>
          <MetricRow label="Comparable historical accounts" value={fmtNumber(f.pass_probability.peers)} />
          <MetricRow label="Of those, passed" value={fmtNumber(f.pass_probability.peers_passed)} tone="var(--admin-success)" />
          <SectionNote>{f.pass_probability.note}</SectionNote>
        </Card>
      </ChartGrid>

      {/* I136, I137, I138 */}
      <SectionHeading>Headroom on Every Rule</SectionHeading>
      <ChartGrid>
        <Card title="Drawdown" eyebrow="I138">
          <Meter
            label="Allowance consumed"
            value={drawdownUsedPct ?? 0}
            caption={`Floor at ${fmtMoney(f.drawdown_headroom.floor)}`}
          />
          <MetricRow label="Headroom" value={fmtMoney(f.drawdown_headroom.headroom)} tone={toneFor(f.drawdown_headroom.headroom)} />
          <MetricRow
            label="Average losing trade"
            value={f.drawdown_headroom.avg_losing_trade === null ? '—' : fmtMoney(f.drawdown_headroom.avg_losing_trade)}
          />
          <MetricRow
            label="Losing trades to the floor"
            value={f.drawdown_headroom.losing_trades_to_floor === null ? '—' : fmtNumber(f.drawdown_headroom.losing_trades_to_floor, 1)}
            tone={(f.drawdown_headroom.losing_trades_to_floor ?? 99) < 3 ? 'var(--admin-danger)' : undefined}
          />
          <SectionNote>
            Headroom expressed in this trader&apos;s own average losing trades is the version they actually feel: &quot;three more losses like your usual one&quot;.
          </SectionNote>
        </Card>

        <Card title="Consistency &amp; Qualifying Days" eyebrow="I136 · I137">
          <MetricRow label="Consistency cap" value={f.consistency_headroom.cap_pct === null ? 'none' : fmtPct(f.consistency_headroom.cap_pct)} />
          <MetricRow label="Best day so far" value={fmtMoney(f.consistency_headroom.best_day_so_far)} />
          <MetricRow
            label="Largest day still allowed"
            value={f.consistency_headroom.max_allowed_single_day === null ? '—' : fmtMoney(f.consistency_headroom.max_allowed_single_day)}
            tone="var(--admin-accent)"
          />
          <SectionNote>{f.consistency_headroom.note}</SectionNote>

          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <Meter
              label="Qualifying days"
              value={f.qualifying_days.required > 0 ? Math.min((f.qualifying_days.achieved / f.qualifying_days.required) * 100, 100) : 100}
              caption={`${f.qualifying_days.achieved} of ${f.qualifying_days.required} · ${f.qualifying_days.remaining} to go`}
              tone={f.qualifying_days.satisfied ? 'var(--admin-success)' : undefined}
            />
          </div>
        </Card>
      </ChartGrid>

      {/* I142 */}
      <SectionHeading>If Nothing Changes</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart
          title="Projected Equity at Current Expectancy"
          eyebrow="I142 · what-if over the next N trades"
          height={260}
          empty={f.what_if.some((w) => w.projected_equity !== null) ? null : 'No closed trades to derive an expectancy from.'}
        >
          <BarChart data={f.what_if}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="next_trades" {...chartThemeProps.xAxis} tickFormatter={(v) => `+${v}`} />
            <YAxis {...chartThemeProps.yAxis} domain={['auto', 'auto']} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip
              {...chartThemeProps.tooltip}
              formatter={(value) => fmtMoney(value)}
              labelFormatter={(v) => `After ${v} more trades`}
            />
            <ReferenceLine
              y={f.target.profit_target + (f.target.current_profit - f.target.current_profit)}
              stroke="var(--admin-success)"
              strokeDasharray="4 4"
            />
            <Bar dataKey="projected_equity" name="Projected equity">
              {f.what_if.map((w) => (
                <Cell key={w.next_trades} fill={w.reaches_target ? 'var(--admin-success)' : 'var(--admin-accent)'} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>
      </ChartGrid>

      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Next trades', render: (r) => `+${r.next_trades}`, isMono: true },
            {
              header: 'Projected P&L',
              render: (r) => (r.projected_pnl === null ? '—' : <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.projected_pnl) }}>{fmtMoney(r.projected_pnl, { signed: true })}</span>)
            },
            { header: 'Projected equity', render: (r) => fmtMoney(r.projected_equity), isMono: true },
            {
              header: 'Reaches target',
              render: (r) => (r.reaches_target === null
                ? '—'
                : <AdminBadge bracket status={r.reaches_target ? 'approved' : 'muted'} label={r.reaches_target ? 'yes' : 'no'} />)
            }
          ]}
          data={f.what_if}
          emptyMessage="No expectancy available"
          emptyIcon="target"
        />
      </Card>
      <SectionNote>
        A straight-line extrapolation of the trader&apos;s current per-trade expectancy. It assumes the distribution holds, which is exactly the assumption that fails when it matters — read it as a sanity check, not a prediction.
      </SectionNote>

      {/* I140 */}
      <SectionHeading>Scaling</SectionHeading>
      <ChartGrid>
        <Card title="Milestone Tracker" eyebrow="I140">
          <MetricRow label="Current multiplier" value={`${fmtNumber(f.scaling.multiplier, 2)}×`} />
          <MetricRow label="Milestones claimed" value={fmtNumber(f.scaling.milestones_claimed)} />
          <MetricRow label="Scaling target" value={f.scaling.target_pct === null ? '—' : fmtPct(f.scaling.target_pct)} />
          {/* Was "Next tier multiplier", read from challenge_models.scaling_multiplier
              — a second, unused scaling semantic. The engine grants a LINEAR
              increase per milestone, so that figure was fiction. */}
          <MetricRow label="Next milestone increase" value={f.scaling.next_increase_pct === null ? '—' : `${fmtNumber(f.scaling.next_increase_pct, 2)}%`} />
          <MetricRow label="Next milestone amount" value={f.scaling.next_increase_amount == null ? '—' : fmtMoney(f.scaling.next_increase_amount)} />
          <MetricRow label="Scaling ceiling" value={f.scaling.max_account_size == null ? '—' : fmtMoney(f.scaling.max_account_size)} />
        </Card>

        <Card title="Accounts on File" eyebrow="every account this trader holds">
          {data.accounts.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No accounts.</p>
          ) : data.accounts.map((a) => (
            <div key={a.id} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-1)' }}>
                <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>
                  {a.account_uid || String(a.id).slice(0, 8)}
                </strong>
                <span style={{ display: 'inline-flex', gap: 'var(--space-1)' }}>
                  <AdminBadge bracket status={a.account_type} label={a.account_type} />
                  <AdminBadge bracket status={a.status} label={a.status} />
                </span>
              </div>
              <MetricRow label="Balance" value={fmtMoney(a.current_balance)} />
              <MetricRow
                label="P&L"
                value={fmtMoney(Number(a.current_balance) - Number(a.starting_balance), { signed: true })}
                tone={toneFor(Number(a.current_balance) - Number(a.starting_balance))}
              />
              {a.flagged ? <AdminBadge status="danger" label={a.flag_reason || 'flagged'} /> : null}
            </div>
          ))}
        </Card>
      </ChartGrid>
    </>
  );
}
