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
  fmtMoney, fmtNumber, fmtPct, fmtDuration, fmtDate, toneFor
} from '../AdminIntelligence/shared';
import { Meter, Versus } from '../AdminIntelligence/charts';

// Trader & Risk Intelligence → Discipline (H121–H132).
//
// The same discipline and risk-consistency scores the trader sees on their own
// dashboard, computed by the same functions in services/tradeAnalytics.js — so
// an admin and a trader in a support conversation are looking at one number,
// not two that disagree.

export default function DisciplineTab({ data }) {
  const { discipline, risk_consistency: consistency, behaviour, risk_behaviour: risk } = data;

  if (!behaviour || !risk) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
        <h3 style={{ color: 'var(--admin-text)', marginBottom: 'var(--space-2)' }}>Nothing to assess yet</h3>
        <p style={{ color: 'var(--admin-text-muted)', margin: 0, fontSize: 'var(--fs-base)' }}>
          This trader has no closed positions, so there is no behaviour to score.
        </p>
      </Card>
    );
  }

  const ruin = risk.risk_of_ruin;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard
          icon="approve"
          label="Discipline Score"
          value={<span style={{ color: discipline?.score >= 70 ? 'var(--admin-success)' : 'var(--admin-warning)' }}>{discipline?.score ?? '—'}<span style={{ fontSize: '0.6em', opacity: 0.6 }}>/100</span></span>}
        />
        <AdminStatCard
          icon="rules"
          label="Risk Consistency"
          value={<span style={{ color: consistency?.score >= 70 ? 'var(--admin-success)' : 'var(--admin-warning)' }}>{consistency?.score ?? '—'}<span style={{ fontSize: '0.6em', opacity: 0.6 }}>/100</span></span>}
        />
        <AdminStatCard
          icon="warning"
          label="Revenge Sequences"
          value={fmtNumber(behaviour.revenge_trading.sequences)}
          alert={behaviour.revenge_trading.sequences > 3}
        />
        <AdminStatCard
          icon="activity"
          label="Overtrading Days"
          value={fmtNumber(behaviour.overtrading.days)}
          alert={behaviour.overtrading.days > 0}
        />
        <AdminStatCard
          icon="drawdown"
          label="Days Near Daily Limit"
          value={fmtNumber(risk.near_limit_days)}
          alert={risk.near_limit_days > 2}
        />
        <AdminStatCard
          icon="target"
          label="Risk of Ruin"
          value={ruin ? fmtPct(ruin.probability_pct) : '—'}
          alert={(ruin?.probability_pct ?? 0) > 25}
        />
      </AdminStatGrid>

      {/* H121, H122 */}
      <ChartGrid>
        <Card title="Discipline Breakdown" eyebrow={`H121 · grade ${discipline?.grade || '—'}`}>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginTop: 0 }}>{discipline?.summary}</p>
          {Object.entries(discipline?.components || {}).map(([key, value]) => (
            <Meter key={key} label={key.replace(/_/g, ' ')} value={value} />
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {Object.entries(discipline?.metrics || {}).map(([key, value]) => (
              <MetricRow key={key} label={key.replace(/_/g, ' ')} value={fmtNumber(value, 2)} />
            ))}
          </div>
        </Card>

        <Card title="Risk Consistency" eyebrow={`H122 · grade ${consistency?.grade || '—'}`}>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginTop: 0 }}>{consistency?.summary}</p>
          {Object.entries(consistency?.components || {}).map(([key, value]) => (
            <Meter key={key} label={key.replace(/_/g, ' ')} value={value} />
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Lot size CV" value={behaviour.lot_consistency_cv === null ? '—' : fmtNumber(behaviour.lot_consistency_cv, 3)} />
            <MetricRow label="Stop loss used" value={fmtPct(behaviour.protection.stop_loss_usage_pct)} />
            <MetricRow label="Take profit used" value={fmtPct(behaviour.protection.take_profit_usage_pct)} />
            <SectionNote>
              Coefficient of variation on position size: near zero means every trade risks the same amount, which is what a repeatable process looks like.
            </SectionNote>
          </div>
        </Card>
      </ChartGrid>

      {/* H127 */}
      <SectionHeading>Daily Loss-Limit Proximity</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart
          title="How Close Each Day Came to the Limit"
          eyebrow={`H127 · daily limit ${risk.daily_limit_pct === null ? 'not configured' : fmtPct(risk.daily_limit_pct)}`}
          height={280}
          empty={risk.daily_risk.length ? null : 'No daily P&L records for this trader.'}
        >
          <BarChart data={risk.daily_risk}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={24} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `${v}%`} />
            <Tooltip
              {...chartThemeProps.tooltip}
              formatter={(value, name) => (name === 'Limit used' ? fmtPct(value) : fmtPct(value))}
              labelFormatter={(label) => {
                const row = risk.daily_risk.find((d) => d.date === label);
                return row ? `${label} · ${fmtMoney(row.realized_pnl, { signed: true })}` : label;
              }}
            />
            <ReferenceLine y={100} stroke="var(--admin-danger)" strokeDasharray="4 4" />
            <ReferenceLine y={70} stroke="var(--admin-warning)" strokeDasharray="3 3" />
            <Bar dataKey="limit_used_pct" name="Limit used">
              {risk.daily_risk.map((d) => (
                <Cell
                  key={d.date}
                  fill={(d.limit_used_pct ?? 0) >= 90 ? 'var(--admin-danger)' : (d.limit_used_pct ?? 0) >= 70 ? 'var(--admin-warning)' : 'var(--admin-accent)'}
                />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>
      </ChartGrid>
      <SectionNote>
        Only losing days consume the allowance, so profitable days show no bar. A trader repeatedly touching 90% is one bad tick from a breach, however healthy the equity curve looks.
      </SectionNote>

      {/* H124, H125, H126 */}
      <SectionHeading>Behavioural Flags</SectionHeading>
      <ChartGrid>
        <Card title="Revenge, Overtrading and Impulse" eyebrow="H124 · H125 · H126">
          <MetricRow
            label="Revenge sequences"
            value={fmtNumber(behaviour.revenge_trading.sequences)}
            tone={behaviour.revenge_trading.sequences > 0 ? 'var(--admin-warning)' : undefined}
          />
          <MetricRow
            label="P&L on those trades"
            value={fmtMoney(behaviour.revenge_trading.net_pnl, { signed: true })}
            tone={toneFor(behaviour.revenge_trading.net_pnl)}
          />
          <MetricRow
            label={`Overtrading days (≥${behaviour.overtrading.threshold_trades_per_day} trades)`}
            value={fmtNumber(behaviour.overtrading.days)}
          />
          <MetricRow
            label="P&L on overtrading days"
            value={fmtMoney(behaviour.overtrading.net_pnl_on_those_days, { signed: true })}
            tone={toneFor(behaviour.overtrading.net_pnl_on_those_days)}
          />
          <MetricRow
            label={`Closed inside ${behaviour.quick_exits.threshold_minutes} minutes`}
            value={`${fmtNumber(behaviour.quick_exits.trades)} (${fmtPct(behaviour.quick_exits.share_pct)})`}
          />
          <MetricRow label="Best win streak" value={fmtNumber(behaviour.streaks.best_win_streak)} tone="var(--admin-success)" />
          <MetricRow label="Worst loss streak" value={fmtNumber(behaviour.streaks.worst_loss_streak)} tone="var(--admin-danger)" />
          <MetricRow label="Median hold" value={fmtDuration(behaviour.hold_time.median_minutes)} />
          <SectionNote>{behaviour.revenge_trading.definition}</SectionNote>
        </Card>

        {/* H131 */}
        <Card title="Behaviour After a Warning" eyebrow="H131">
          {risk.behaviour_change ? (
            <>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginTop: 0 }}>
                First violation raised {fmtDate(risk.behaviour_change.first_violation_at)}.
              </p>
              <Versus
                label="Trades"
                left={risk.behaviour_change.before.trades}
                right={risk.behaviour_change.after.trades}
                leftLabel="Before"
                rightLabel="After"
              />
              <MetricRow label="Average lot before" value={fmtNumber(risk.behaviour_change.before.avg_lot, 3)} />
              <MetricRow label="Average lot after" value={fmtNumber(risk.behaviour_change.after.avg_lot, 3)} />
              <MetricRow label="Win rate before" value={fmtPct(risk.behaviour_change.before.win_rate_pct)} />
              <MetricRow label="Win rate after" value={fmtPct(risk.behaviour_change.after.win_rate_pct)} />
              <MetricRow
                label="Average P&L before"
                value={fmtMoney(risk.behaviour_change.before.avg_pnl, { decimals: 2, signed: true })}
                tone={toneFor(risk.behaviour_change.before.avg_pnl)}
              />
              <MetricRow
                label="Average P&L after"
                value={fmtMoney(risk.behaviour_change.after.avg_pnl, { decimals: 2, signed: true })}
                tone={toneFor(risk.behaviour_change.after.avg_pnl)}
              />
              <SectionNote>
                Whether a warning changed anything is the only real measure of whether warnings are worth issuing.
              </SectionNote>
            </>
          ) : (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>
              No violation has ever been raised against this trader, so there is no before-and-after to compare.
            </p>
          )}
        </Card>
      </ChartGrid>

      {/* H128, H129, H130, H132 */}
      <SectionHeading>Exposure &amp; Ruin</SectionHeading>
      <ChartGrid>
        <Card title="Consistency &amp; Exposure" eyebrow="H128 · H129 · H130">
          <MetricRow label="Best single day" value={fmtMoney(risk.consistency.best_day_pnl)} />
          <MetricRow label="Total profit from winning days" value={fmtMoney(risk.consistency.total_profit)} />
          <MetricRow
            label="Best day as share of profit"
            value={fmtPct(risk.consistency.best_day_share_pct)}
            tone={risk.consistency.breaches_cap ? 'var(--admin-danger)' : undefined}
          />
          <MetricRow label="Consistency cap" value={risk.consistency.cap_pct === null ? 'none' : fmtPct(risk.consistency.cap_pct)} />
          {risk.consistency.breaches_cap ? (
            <div style={{ marginTop: 'var(--space-2)' }}>
              <AdminBadge status="danger" label="Currently over the consistency cap" />
            </div>
          ) : null}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Overnight trades" value={`${fmtNumber(risk.overnight.trades)} (${fmtPct(risk.overnight.share_pct)})`} />
            <MetricRow label="P&L held overnight" value={fmtMoney(risk.overnight.net_pnl, { signed: true })} tone={toneFor(risk.overnight.net_pnl)} />
            <MetricRow label="Weekend-opened trades" value={`${fmtNumber(risk.weekend.trades)} (${fmtPct(risk.weekend.share_pct)})`} />
            <MetricRow label="Max leverage allowed" value={risk.leverage.max_allowed === null ? '—' : `${risk.leverage.max_allowed}×`} />
            <MetricRow label="Average utilisation" value={risk.leverage.avg_utilisation === null ? '—' : `${fmtNumber(risk.leverage.avg_utilisation, 2)}×`} />
            <MetricRow label="Peak utilisation" value={risk.leverage.peak_utilisation === null ? '—' : `${fmtNumber(risk.leverage.peak_utilisation, 2)}×`} />
          </div>
          <SectionNote>{risk.leverage.note}</SectionNote>
        </Card>

        <Card title="Risk of Ruin" eyebrow="H132">
          {ruin ? (
            <>
              <div style={{
                fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                fontSize: 'clamp(28px, 5vw, 44px)', fontWeight: 700,
                color: ruin.probability_pct > 50 ? 'var(--admin-danger)' : ruin.probability_pct > 20 ? 'var(--admin-warning)' : 'var(--admin-success)',
                lineHeight: 1, marginBottom: 'var(--space-3)'
              }}>
                {fmtPct(ruin.probability_pct)}
              </div>
              {ruin.losing_trades_to_floor !== undefined ? (
                <MetricRow label="Average losing trades to the floor" value={fmtNumber(ruin.losing_trades_to_floor, 1)} />
              ) : null}
              <SectionNote>{ruin.note}</SectionNote>
            </>
          ) : (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>
              Not enough wins and losses on record to estimate a ruin probability.
            </p>
          )}
        </Card>
      </ChartGrid>

      {/* H127 detail */}
      {risk.near_limit_detail.length > 0 ? (
        <>
          <SectionHeading>Days That Came Closest</SectionHeading>
          <Card flush>
            <AdminDataTable
              columns={[
                { header: 'Date', key: 'date', isMono: true },
                { header: 'Realised P&L', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.realized_pnl) }}>{fmtMoney(r.realized_pnl, { signed: true })}</span> },
                { header: 'As % of equity', render: (r) => fmtPct(r.pnl_pct, 2), isMono: true },
                {
                  header: 'Limit used',
                  render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: (r.limit_used_pct ?? 0) >= 90 ? 'var(--admin-danger)' : 'var(--admin-warning)' }}>{fmtPct(r.limit_used_pct)}</span>
                },
                { header: 'Qualifying day', render: (r) => (r.is_qualifying_day ? <AdminBadge bracket status="approved" label="yes" /> : '—') }
              ]}
              data={risk.near_limit_detail}
              emptyMessage="No day came close to the limit"
              emptyIcon="approve"
            />
          </Card>
        </>
      ) : null}
    </>
  );
}
