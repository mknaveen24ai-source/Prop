import React from 'react';
import {
  AreaChart, Area, BarChart, Bar, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, Cell, ComposedChart
} from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import Card from '../../../components/ui/Card';
import {
  NeedsData, ChartGrid, SectionHeading, SectionNote, MetricRow,
  fmtMoney, fmtNumber, fmtPct, fmtDuration, toneFor
} from '../AdminIntelligence/shared';

// Trader & Risk Intelligence → Edge (G101–G120).

export default function EdgeTab({ data }) {
  const edge = data.edge;

  if (!edge) {
    return (
      <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
        <h3 style={{ color: 'var(--admin-text)', marginBottom: 'var(--space-2)' }}>No closed trades</h3>
        <p style={{ color: 'var(--admin-text-muted)', margin: 0, fontSize: 'var(--fs-base)' }}>
          This trader has not closed a position yet, so there is no edge to decompose.
        </p>
      </Card>
    );
  }

  const ra = data.risk_adjusted;
  const exc = data.excursions;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="trades" label="Closed Trades" value={fmtNumber(edge.total_trades)} />
        <AdminStatCard
          icon="pnl"
          label="Net P&L"
          value={<span style={{ color: toneFor(edge.net_pnl) }}>{fmtMoney(edge.net_pnl, { signed: true })}</span>}
        />
        <AdminStatCard icon="target" label="Win Rate" value={fmtPct(edge.win_rate_pct)} />
        <AdminStatCard icon="activity" label="Profit Factor" value={edge.profit_factor === null ? '—' : fmtNumber(edge.profit_factor, 2)} />
        <AdminStatCard icon="balance" label="Expectancy / Trade" value={fmtMoney(edge.expectancy, { decimals: 2, signed: true })} />
        <AdminStatCard icon="drawdown" label="Max Drawdown" value={fmtMoney(data.equity_curve.max_drawdown_pct === null ? null : ra?.max_drawdown)} />
      </AdminStatGrid>

      {/* G101 */}
      <ChartGrid min={520}>
        <AdminChart title="Equity Curve" eyebrow="G101 · cumulative, by closed trade" height={320}>
          <AreaChart data={data.equity_curve.points}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="trade_index" {...chartThemeProps.xAxis} minTickGap={30} />
            <YAxis {...chartThemeProps.yAxis} domain={['auto', 'auto']} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip
              {...chartThemeProps.tooltip}
              formatter={(value, name) => (name === 'Drawdown' ? fmtPct(value) : fmtMoney(value, { decimals: 2 }))}
              labelFormatter={(v) => `After ${v} closed trades`}
            />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Area type="monotone" dataKey="equity" name="Equity" stroke="var(--admin-accent)" fill="var(--admin-accent)" fillOpacity={0.16} strokeWidth={2} />
          </AreaChart>
        </AdminChart>
      </ChartGrid>

      <ChartGrid>
        {/* G104 */}
        <AdminChart
          title="R-Multiple Distribution"
          eyebrow={`G104 · ${fmtNumber(edge.r_multiple.samples)} risk-normalised trades`}
          height={260}
          empty={edge.r_multiple.samples > 0 ? null : 'No trade carries both a stop loss and a known contract size.'}
        >
          <BarChart data={edge.r_multiple.distribution}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="bucket" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="trades" name="Trades">
              {edge.r_multiple.distribution.map((b) => (
                <Cell key={b.bucket} fill={b.bucket.includes('-') ? 'var(--admin-danger)' : 'var(--admin-success)'} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        {/* G112 */}
        <AdminChart
          title="Rolling 30-Trade Edge"
          eyebrow="G112 · is the edge decaying?"
          height={260}
          empty={edge.rolling_30.length ? null : 'Fewer than 30 closed trades — no rolling window yet.'}
        >
          <ComposedChart data={edge.rolling_30}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="trade_index" {...chartThemeProps.xAxis} minTickGap={30} />
            <YAxis yAxisId="pct" {...chartThemeProps.yAxis} tickFormatter={(v) => `${v}%`} />
            <YAxis yAxisId="money" orientation="right" {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Line yAxisId="pct" type="monotone" dataKey="win_rate_pct" name="Win rate" stroke="var(--admin-accent)" strokeWidth={2} dot={false} />
            <Line yAxisId="money" type="monotone" dataKey="expectancy" name="Expectancy" stroke="var(--admin-success)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </AdminChart>
      </ChartGrid>

      {edge.r_multiple.note ? <SectionNote>{edge.r_multiple.note}</SectionNote> : null}

      {/* G103 */}
      <SectionHeading>Where the Edge Lives</SectionHeading>
      <ChartGrid>
        {[
          { key: 'instrument', title: 'By Instrument' },
          { key: 'session', title: 'By Session' },
          { key: 'weekday', title: 'By Weekday' },
          { key: 'strategy', title: 'By Strategy Tag' }
        ].map(({ key, title }) => {
          const rows = data.breakdowns[key] || [];
          return (
            <AdminChart
              key={key}
              title={title}
              eyebrow="G103 · realised P&L"
              height={240}
              empty={rows.length ? null : 'No closed trades in this bucket.'}
            >
              <BarChart data={rows}>
                <CartesianGrid {...chartThemeProps.grid} />
                <XAxis dataKey="label" {...chartThemeProps.xAxis} />
                <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
                <Tooltip
                  {...chartThemeProps.tooltip}
                  formatter={(value) => fmtMoney(value, { decimals: 2 })}
                  labelFormatter={(label) => {
                    const row = rows.find((r) => r.label === label);
                    return row ? `${label} · ${row.trades} trades · ${fmtPct(row.win_rate)} win rate` : label;
                  }}
                />
                <Bar dataKey="total_pnl" name="P&L">
                  {rows.map((r) => (
                    <Cell key={r.key || r.label} fill={r.total_pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)'} />
                  ))}
                </Bar>
              </BarChart>
            </AdminChart>
          );
        })}
      </ChartGrid>

      {/* G106–G109 */}
      <SectionHeading>Execution Quality</SectionHeading>
      {exc?.available ? (
        <>
          <ChartGrid>
            <Card title="Excursion Summary" eyebrow="G106 · G107 · G109">
              <MetricRow label="Trades measured" value={fmtNumber(exc.trades_measured)} />
              <MetricRow label="Average efficiency" value={fmtPct(exc.avg_efficiency_pct)} tone="var(--admin-accent)" />
              <MetricRow label="Median efficiency" value={fmtPct(exc.median_efficiency_pct)} />
              <MetricRow label="Average favourable excursion" value={fmtNumber(exc.avg_mfe, 5)} />
              <MetricRow label="Average adverse excursion" value={fmtNumber(exc.avg_mae, 5)} tone="var(--admin-warning)" />
              <SectionNote>
                Efficiency is the move captured divided by the best move available while the position was open. Below 50% consistently means exits, not entries, are the problem.
              </SectionNote>
              <SectionNote>{exc.method_note}</SectionNote>
            </Card>

            <Card flush title="Most Left on the Table" eyebrow="G108 · exit quality">
              <AdminDataTable
                columns={[
                  { header: 'Instrument', key: 'instrument', isMono: true },
                  { header: 'Dir', key: 'direction', isMono: true },
                  { header: 'Captured', render: (r) => fmtNumber(r.captured, 5), isMono: true },
                  { header: 'Available', render: (r) => fmtNumber(r.mfe, 5), isMono: true },
                  { header: 'Efficiency', render: (r) => fmtPct(r.efficiency_pct), isMono: true },
                  { header: 'P&L', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.pnl) }}>{fmtMoney(r.pnl)}</span> }
                ]}
                data={exc.worst_exits}
                emptyMessage="No measurable excursions"
                emptyIcon="trades"
              />
            </Card>
          </ChartGrid>
        </>
      ) : (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <NeedsData title="Excursion Analysis (G106–G109)" reason={exc?.reason || 'No price history available for these trades.'} />
        </div>
      )}

      {/* G110, G113, G114, G115, G116, G117, G118 */}
      <SectionHeading>Quality of the Result</SectionHeading>
      <ChartGrid>
        <Card title="Risk-Adjusted Return" eyebrow="G113 · G114 · on daily realised P&L">
          {ra?.samples >= 3 ? (
            <>
              <MetricRow label="Sharpe (daily, unannualised)" value={ra.sharpe === null ? '—' : fmtNumber(ra.sharpe, 3)} />
              <MetricRow label="Sortino" value={ra.sortino === null ? '—' : fmtNumber(ra.sortino, 3)} />
              <MetricRow label="Calmar" value={ra.calmar === null ? '—' : fmtNumber(ra.calmar, 3)} />
              <MetricRow label="Ulcer index" value={fmtNumber(ra.ulcer_index, 2)} />
              <MetricRow label="Recovery factor" value={ra.recovery_factor === null ? '—' : fmtNumber(ra.recovery_factor, 3)} />
              <MetricRow label="Max drawdown" value={fmtMoney(ra.max_drawdown)} tone="var(--admin-danger)" />
              <MetricRow label="Trading days" value={fmtNumber(ra.samples)} />
              <SectionNote>
                Unannualised on purpose: annualising a {ra.samples}-day sample would be theatre.
              </SectionNote>
            </>
          ) : (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>
              {ra?.note || 'Not enough trading days for a meaningful ratio.'}
            </p>
          )}
        </Card>

        <Card title="Robustness &amp; Costs" eyebrow="G115 · G116 · G117 · G118">
          <MetricRow
            label={`P&L excluding best ${edge.outlier_dependence.excluded_trades} trades`}
            value={fmtMoney(edge.outlier_dependence.net_pnl_excluding_top_5_pct, { signed: true })}
            tone={edge.outlier_dependence.survives_without_outliers ? 'var(--admin-success)' : 'var(--admin-danger)'}
          />
          <MetricRow label="Distinct instruments" value={fmtNumber(data.concentration.distinct_instruments)} />
          <MetricRow label="Top instrument share" value={fmtPct(data.concentration.top_instrument_share_pct)} />
          <MetricRow
            label="Concentration (HHI)"
            value={data.concentration.herfindahl_index === null ? '—' : fmtNumber(data.concentration.herfindahl_index, 3)}
            tone={(data.concentration.herfindahl_index ?? 0) > 0.6 ? 'var(--admin-warning)' : undefined}
          />
          <MetricRow label="Peak concurrent positions" value={fmtNumber(data.concentration.max_concurrent_positions)} />
          <MetricRow label="Long trades" value={`${fmtNumber(edge.direction.long.trades)} · ${fmtPct(edge.direction.long.win_rate_pct)} · ${fmtMoney(edge.direction.long.net_pnl, { signed: true })}`} />
          <MetricRow label="Short trades" value={`${fmtNumber(edge.direction.short.trades)} · ${fmtPct(edge.direction.short.win_rate_pct)} · ${fmtMoney(edge.direction.short.net_pnl, { signed: true })}`} />
          <MetricRow label="Commission paid" value={fmtMoney(edge.cost_drag.commission, { decimals: 2 })} tone="var(--admin-warning)" />
          <MetricRow label="Cost as share of gross" value={fmtPct(edge.cost_drag.commission_pct_of_gross)} />
          <SectionNote>
            A strategy that turns negative once its best 5% of trades are removed has no repeatable edge — it has a few lucky trades.
          </SectionNote>
        </Card>
      </ChartGrid>

      {/* G110, G119, G120 */}
      <ChartGrid>
        <Card title="Hold Time" eyebrow="G110">
          <MetricRow label="Median" value={fmtDuration(data.hold_time?.median_mins)} />
          <MetricRow label="Average" value={fmtDuration(data.hold_time?.average_mins)} />
          <MetricRow label="Winners average" value={fmtDuration(data.hold_time?.winners_average_mins)} tone="var(--admin-success)" />
          <MetricRow label="Losers average" value={fmtDuration(data.hold_time?.losers_average_mins)} tone="var(--admin-danger)" />
          <MetricRow label="Quick-exit rate" value={fmtPct(data.hold_time?.quick_exit_rate)} />
          <MetricRow label="Overhold rate" value={fmtPct(data.hold_time?.overhold_rate)} />
          <SectionNote>
            Winners held markedly longer than losers is the healthy pattern. The reverse — cutting winners, nursing losers — is the classic destroyer of an otherwise sound edge.
          </SectionNote>
        </Card>

        <Card title="Execution Mechanics" eyebrow="G119 · G120">
          <MetricRow label="Partial closes" value={`${fmtNumber(data.execution.partials.trades)} (${fmtPct(data.execution.partials.share_pct)})`} />
          <MetricRow label="Average P&L, scaled out" value={fmtMoney(data.execution.partials.avg_pnl, { decimals: 2, signed: true })} />
          <MetricRow label="Average P&L, all-in close" value={fmtMoney(data.execution.partials.full_close_avg_pnl, { decimals: 2, signed: true })} />
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {data.execution.order_types.map((o) => (
              <MetricRow
                key={o.order_type}
                label={`${o.order_type} · ${fmtNumber(o.total)} orders`}
                value={`${fmtPct(o.fill_pct)} filled · ${fmtPct(o.cancel_pct)} cancelled`}
              />
            ))}
          </div>
        </Card>
      </ChartGrid>

      {/* Activity heatmap */}
      <SectionHeading>When They Trade</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart
          title="P&L by Hour of Day"
          eyebrow="G103 · UTC"
          height={260}
          empty={data.heatmap?.hourly_summary?.length ? null : 'No closed trades to plot.'}
        >
          <BarChart data={data.heatmap?.hourly_summary || []}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="hour" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Bar dataKey="pnl" name="P&L">
              {(data.heatmap?.hourly_summary || []).map((h) => (
                <Cell key={h.hour} fill={h.pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)'} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>
      </ChartGrid>
    </>
  );
}
