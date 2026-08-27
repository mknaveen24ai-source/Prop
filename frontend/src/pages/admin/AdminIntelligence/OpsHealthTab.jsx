import React from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, ChartGrid, SectionHeading, SectionNote,
  MetricRow, fmtNumber, fmtPct, fmtDuration, seriesColor
} from './shared';
import { Heatmap } from './charts';

// Firm Intelligence → Ops Health (F96–F100).
//
// Operational strain shows up here before it shows up in revenue: a spike in
// payout tickets or a diverging price source is the leading indicator of the
// disputes and chargebacks that arrive a fortnight later.

export default function OpsHealthTab({ adminAxios, dateRange, onUpdated }) {
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/ops', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const totalTickets = data.support.categories.reduce((s, c) => s + c.tickets, 0);
  const totalBreached = data.support.categories.reduce((s, c) => s + c.sla_breached, 0);
  const staleFeeds = data.price_feed.stale_over_60s;
  const emailBacklog = data.engine.email_queue
    .filter((q) => ['pending', 'retry'].includes(q.status))
    .reduce((s, q) => s + q.jobs, 0);

  // Context heatmap: which ticket categories come from which kind of trader.
  const contextRows = data.ticket_context.map((c) => c.category);
  const contextColumns = ['Failed', 'Funded', 'Awaiting payout', 'KYC pending'];
  const contextCells = data.ticket_context.flatMap((c) => ([
    { row: c.category, column: 'Failed', value: c.from_failed_traders },
    { row: c.category, column: 'Funded', value: c.from_funded_traders },
    { row: c.category, column: 'Awaiting payout', value: c.awaiting_payout },
    { row: c.category, column: 'KYC pending', value: c.kyc_pending }
  ]));

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="support" label="Tickets" value={fmtNumber(totalTickets)} />
        <AdminStatCard icon="warning" label="SLA Breached" value={fmtNumber(totalBreached)} alert={totalBreached > 0} />
        <AdminStatCard icon="dispute" label="Disputes" value={fmtNumber(data.disputes.total)} />
        <AdminStatCard
          icon="activity"
          label="Disputes / 100 Failures"
          value={data.disputes.disputes_per_100_failures === null ? '—' : fmtNumber(data.disputes.disputes_per_100_failures, 1)}
        />
        <AdminStatCard icon="globe" label="Stale Feeds" value={fmtNumber(staleFeeds)} alert={staleFeeds > 0} />
        <AdminStatCard icon="mail" label="Email Backlog" value={fmtNumber(emailBacklog)} alert={emailBacklog > 50} />
      </AdminStatGrid>

      {/* F96 */}
      <ChartGrid min={520}>
        <AdminChart
          title="Ticket Volume"
          eyebrow="F96 · daily"
          height={240}
          empty={data.support.daily.length ? null : 'No tickets in this window.'}
        >
          <LineChart data={data.support.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Line type="monotone" dataKey="tickets" name="Tickets" stroke="var(--admin-accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </AdminChart>
      </ChartGrid>

      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Category', key: 'category' },
            { header: 'Tickets', render: (r) => fmtNumber(r.tickets), isMono: true },
            {
              header: 'SLA breached',
              render: (r) => (r.sla_breached > 0
                ? <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-danger)' }}>{fmtNumber(r.sla_breached)}</span>
                : <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-text-faint)' }}>0</span>)
            },
            { header: 'First response', render: (r) => fmtDuration(r.avg_first_response_hours === null ? null : r.avg_first_response_hours * 60), isMono: true },
            { header: 'Resolution', render: (r) => fmtDuration(r.avg_resolution_hours === null ? null : r.avg_resolution_hours * 60), isMono: true },
            {
              header: 'By status',
              render: (r) => (
                <span style={{ display: 'inline-flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
                  {Object.entries(r.by_status).map(([status, count]) => (
                    <AdminBadge key={status} bracket status={status} label={`${status} ${count}`} />
                  ))}
                </span>
              )
            }
          ]}
          data={data.support.categories}
          emptyMessage="No tickets in this window"
          emptyIcon="support"
        />
      </Card>
      <SectionNote>
        Resolution time is measured to the last message on a resolved or closed ticket — `support_tickets` records no status-change timestamp, so this is the closest honest proxy rather than an invented one.
      </SectionNote>

      {/* F98 */}
      <SectionHeading>Who Is Opening Tickets</SectionHeading>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <Heatmap
          title="Ticket Category against Trader State"
          eyebrow="F98 · tickets"
          rows={contextRows}
          columns={contextColumns}
          cells={contextCells}
          valueLabel="tickets"
        />
      </div>
      <SectionNote>
        &quot;Most of our tickets come from traders who just breached drawdown&quot; is a different operational problem from &quot;most come from traders waiting on KYC&quot;, and raw category counts cannot tell them apart.
      </SectionNote>

      {/* F97 */}
      <SectionHeading>Disputes</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Disputes by Status"
          eyebrow="F97"
          height={240}
          empty={data.disputes.statuses.length ? null : 'No disputes in this window.'}
        >
          <BarChart data={data.disputes.statuses}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="status" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="disputes" name="Disputes">
              {data.disputes.statuses.map((s, index) => (
                <Cell key={s.status} fill={seriesColor(index)} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        <Card title="Dispute Load" eyebrow="F97">
          <MetricRow label="Disputes raised" value={fmtNumber(data.disputes.total)} />
          <MetricRow label="Account failures in window" value={fmtNumber(data.disputes.failed_accounts)} />
          <MetricRow
            label="Disputes per 100 failures"
            value={data.disputes.disputes_per_100_failures === null ? '—' : fmtNumber(data.disputes.disputes_per_100_failures, 1)}
            tone={(data.disputes.disputes_per_100_failures ?? 0) > 10 ? 'var(--admin-danger)' : undefined}
          />
          {data.disputes.statuses.map((s) => (
            <MetricRow
              key={s.status}
              label={`${s.status} · ${fmtPct(s.share_pct)}`}
              value={s.avg_days_open === null ? '—' : `${fmtNumber(s.avg_days_open, 1)} days open`}
            />
          ))}
          <SectionNote>Raw dispute count rises with volume and says nothing on its own. Per 100 failures is the number an operator can act on.</SectionNote>
        </Card>
      </ChartGrid>

      {/* F99 */}
      <SectionHeading>Price Feed</SectionHeading>
      <ChartGrid>
        <Card flush title="Instrument Staleness" eyebrow="F99">
          <AdminDataTable
            columns={[
              { header: 'Instrument', key: 'instrument', isMono: true },
              {
                header: 'Last tick',
                render: (r) => (r.stale_seconds === null
                  ? '—'
                  : <span style={{ fontFamily: 'var(--font-mono)', color: r.stale_seconds > 60 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>{fmtNumber(r.stale_seconds, 1)}s ago</span>)
              },
              { header: 'Bid', render: (r) => (r.bid === null ? '—' : r.bid), isMono: true },
              { header: 'Ask', render: (r) => (r.ask === null ? '—' : r.ask), isMono: true },
              { header: 'Spread', render: (r) => (r.spread === null ? '—' : r.spread), isMono: true }
            ]}
            data={data.price_feed.instruments}
            emptyMessage="No instruments in the price feed"
            emptyIcon="globe"
          />
        </Card>

        <Card title="Sources &amp; Divergence" eyebrow="F99">
          {data.price_feed.sources.map((s) => (
            <div key={s.source_key} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{s.source_name || s.source_key}</strong>
                <AdminBadge bracket status={s.status} label={s.status} />
              </div>
              <MetricRow label="Instruments" value={fmtNumber(s.instruments)} />
              <MetricRow
                label="Worst staleness"
                value={s.worst_stale_seconds === null ? '—' : `${fmtNumber(s.worst_stale_seconds, 1)}s`}
                tone={(s.worst_stale_seconds ?? 0) > 60 ? 'var(--admin-danger)' : undefined}
              />
              {s.error_message ? (
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-danger)', marginTop: 'var(--space-1)' }}>{s.error_message}</div>
              ) : null}
            </div>
          ))}

          {data.price_feed.divergence.length > 0 ? (
            <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)', marginBottom: 'var(--space-2)' }}>Largest cross-source spreads, last 24h</div>
              {data.price_feed.divergence.slice(0, 8).map((d, index) => (
                <MetricRow
                  key={`${d.instrument}-${index}`}
                  label={`${d.instrument} · ${d.sources} sources`}
                  value={d.max_spread_pct === null ? '—' : fmtPct(d.max_spread_pct, 3)}
                  tone={(d.max_spread_pct ?? 0) > 0.1 ? 'var(--admin-danger)' : undefined}
                />
              ))}
              <SectionNote>A source quietly drifting from its peers is the failure mode behind &quot;I was stopped out at a price that never traded&quot;.</SectionNote>
            </div>
          ) : null}
        </Card>
      </ChartGrid>

      {/* F100 */}
      <SectionHeading>Engine Health</SectionHeading>
      <ChartGrid>
        <Card title="Queues &amp; Open State" eyebrow="F100">
          {data.engine.email_queue.map((q) => (
            <MetricRow
              key={q.status}
              label={`Email · ${q.status}`}
              value={`${fmtNumber(q.jobs)}${q.oldest_wait_mins === null ? '' : ` · oldest ${fmtDuration(q.oldest_wait_mins)}`}`}
              tone={['failed', 'dead'].includes(q.status) ? 'var(--admin-danger)' : undefined}
            />
          ))}
          <div style={{ marginTop: 'var(--space-3)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Open trades" value={fmtNumber(data.engine.open_state.open_trades)} />
            <MetricRow label="Pending orders" value={fmtNumber(data.engine.open_state.pending_orders)} />
            <MetricRow
              label="Open over 30 days"
              value={fmtNumber(data.engine.open_state.stale_open_over_30d)}
              tone={data.engine.open_state.stale_open_over_30d > 0 ? 'var(--admin-danger)' : undefined}
            />
          </div>
          <SectionNote>
            An &quot;open&quot; position older than a month on an evaluation account is almost always an engine or bridge fault rather than a trading decision.
          </SectionNote>
        </Card>

        <AdminChart
          title="Why Trades Close"
          eyebrow="F100 · close reasons"
          height={280}
          empty={data.engine.close_reasons.length ? null : 'No trades closed in this window.'}
        >
          <BarChart data={data.engine.close_reasons} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
            <XAxis type="number" {...chartThemeProps.xAxis} allowDecimals={false} />
            <YAxis type="category" dataKey="reason" {...chartThemeProps.yAxis} width={130} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="trades" name="Trades" fill="var(--admin-accent)" />
          </BarChart>
        </AdminChart>
      </ChartGrid>

      <ChartGrid min={520}>
        <AdminChart
          title="System-Closed Share of Trades"
          eyebrow="F100 · stop, target, drawdown and news closes"
          height={240}
          empty={data.engine.trade_flow.length ? null : 'No trades closed in this window.'}
        >
          <LineChart data={data.engine.trade_flow}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `${v}%`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value, name) => (name === 'System-closed %' ? fmtPct(value) : fmtNumber(value))} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Line type="monotone" dataKey="system_closed_pct" name="System-closed %" stroke="var(--admin-warning)" strokeWidth={2} dot={false} />
          </LineChart>
        </AdminChart>
      </ChartGrid>
    </>
  );
}
