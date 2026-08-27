import React from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, NeedsData, ChartGrid, SectionHeading,
  SectionNote, MetricRow, fmtMoney, fmtNumber, fmtPct, fmtDate, fmtDateTime, toneFor, seriesColor
} from '../AdminIntelligence/shared';
import { Heatmap } from '../AdminIntelligence/charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Trader & Risk Intelligence → Risk & Fraud (D53–D77).
//
// Read-only throughout. Where a row is actionable the operator takes the action
// in the existing Violations, Account Linking or Payouts pages — this page's job
// is to surface what those pages cannot see on their own.

function SuspectTable({ title, eyebrow, note, columns, data, emptyMessage, exportName }) {
  return (
    <>
      <SectionHeading
        action={data.length > 0 && exportName ? (
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => downloadCsv(exportName, data, columns
              .filter((c) => c.csv !== false)
              .map((c) => ({ header: c.header, value: c.csvValue || ((r) => r[c.key] ?? '') })))}
          >
            Export CSV
          </button>
        ) : null}
      >
        {title}
      </SectionHeading>
      {eyebrow ? <SectionNote>{eyebrow}</SectionNote> : null}
      <Card flush style={{ marginBottom: note ? 'var(--space-2)' : 'var(--space-6)' }}>
        <AdminDataTable columns={columns} data={data} emptyMessage={emptyMessage} emptyIcon="approve" />
      </Card>
      {note ? <SectionNote>{note}</SectionNote> : null}
    </>
  );
}

export default function RiskFraudTab({ adminAxios, dateRange, onUpdated }) {
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/trader-intelligence/risk', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading stats={6} />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const { heatmap, drawdown, strategies, identity, thresholds } = data;
  const highRiskPayouts = data.payout_fraud.filter((p) => p.risk_band === 'high');

  // Heatmap axes come from the data, so a severity or type the platform starts
  // emitting tomorrow appears without a code change.
  const types = [...new Set(heatmap.cells.map((c) => c.violation_type))];
  const severities = [...new Set(heatmap.cells.map((c) => c.severity))];
  const heatCells = types.flatMap((type) => severities.map((sev) => {
    const matching = heatmap.cells.filter((c) => c.violation_type === type && c.severity === sev);
    if (!matching.length) return null;
    return { row: type, column: sev, value: matching.reduce((s, c) => s + c.violations, 0) };
  })).filter(Boolean);

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="violations" label="Violations" value={fmtNumber(heatmap.total)} />
        <AdminStatCard
          icon="drawdown"
          label="Near Drawdown"
          value={fmtNumber(drawdown.at_risk_count)}
          alert={drawdown.at_risk_count > 0}
        />
        <AdminStatCard
          icon="warning"
          label="Predicted Breach ≤5d"
          value={fmtNumber(drawdown.predicted_breach_count)}
          alert={drawdown.predicted_breach_count > 0}
        />
        <AdminStatCard
          icon="users"
          label="Copy-Trading Pairs"
          value={fmtNumber(data.copy_trading.pairs.length)}
          alert={data.copy_trading.pairs.length > 0}
        />
        <AdminStatCard
          icon="payouts"
          label="High-Risk Payouts"
          value={fmtNumber(highRiskPayouts.length)}
          alert={highRiskPayouts.length > 0}
        />
        <AdminStatCard icon="kyc" label="KYC Pending" value={fmtNumber(data.kyc.pending_now)} />
      </AdminStatGrid>

      {/* D53, D54, D55 */}
      <ChartGrid>
        <Heatmap
          title="Violations by Type and Severity"
          eyebrow="D53"
          rows={types}
          columns={severities}
          cells={heatCells}
          valueLabel="violations"
          colorFor={() => 'var(--admin-danger)'}
        />

        <Card title="Resolution Backlog" eyebrow="D55">
          <MetricRow label="Open violations" value={fmtNumber(data.resolution.open_backlog.open_violations)} />
          <MetricRow
            label="Open over 7 days"
            value={fmtNumber(data.resolution.open_backlog.open_over_7d)}
            tone={data.resolution.open_backlog.open_over_7d > 0 ? 'var(--admin-warning)' : undefined}
          />
          <MetricRow
            label="Open over 30 days"
            value={fmtNumber(data.resolution.open_backlog.open_over_30d)}
            tone={data.resolution.open_backlog.open_over_30d > 0 ? 'var(--admin-danger)' : undefined}
          />
          <MetricRow
            label="Oldest open"
            value={data.resolution.open_backlog.oldest_days === null ? '—' : `${fmtNumber(data.resolution.open_backlog.oldest_days, 1)} days`}
          />
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {data.resolution.by_type.slice(0, 8).map((r, index) => (
              <MetricRow
                key={`${r.violation_type}-${r.resolution_type}-${index}`}
                label={`${r.violation_type} → ${r.resolution_type}`}
                value={r.avg_hours === null ? '—' : `${fmtNumber(r.avg_hours, 1)}h avg`}
              />
            ))}
          </div>
        </Card>
      </ChartGrid>

      {/* D54 */}
      <SuspectTable
        title="Repeat Offenders"
        eyebrow="D54 — traders with more than one violation, ranked by severity then hit escalation."
        note="Escalation ratio is total hits divided by distinct violation records: one rule tripped forty times is a very different trader from forty rules tripped once."
        exportName="repeat-offenders.csv"
        columns={[
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—', csvValue: (r) => r.trader },
          { header: 'Trader UID', key: 'trader_uid', render: (r) => r.trader_uid || '—', isMono: true },
          { header: 'Violations', key: 'violations', render: (r) => fmtNumber(r.violations), isMono: true },
          { header: 'Total hits', key: 'total_hits', render: (r) => fmtNumber(r.total_hits), isMono: true },
          { header: 'Distinct types', key: 'distinct_types', render: (r) => fmtNumber(r.distinct_types), isMono: true },
          {
            header: 'Severe',
            key: 'severe',
            render: (r) => (r.severe > 0
              ? <AdminBadge bracket status="danger" label={String(r.severe)} />
              : <span style={{ color: 'var(--admin-text-faint)', fontFamily: 'var(--font-mono)' }}>0</span>)
          },
          {
            header: 'Escalation',
            key: 'escalation_ratio',
            render: (r) => (r.escalation_ratio === null ? '—' : `${fmtNumber(r.escalation_ratio, 1)}×`),
            isMono: true
          },
          { header: 'Last seen', key: 'last_detected_at', render: (r) => fmtDate(r.last_detected_at), isMono: true }
        ]}
        data={data.repeat_offenders}
        emptyMessage="No trader has more than one violation in this window"
      />

      {/* D56, D57 */}
      <SuspectTable
        title="Predicted Drawdown Breach"
        eyebrow={`D57 — projected from each account's own last five trading days. ${fmtNumber(drawdown.active_accounts)} active accounts scanned.`}
        note={drawdown.method_note}
        exportName="predicted-breach.csv"
        columns={[
          { header: 'Account', key: 'account_uid', render: (r) => r.account_uid || String(r.account_id).slice(0, 8), isMono: true },
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—' },
          { header: 'Model', key: 'model_slug', render: (r) => r.model_slug || '—', isMono: true },
          { header: 'Equity', key: 'equity', render: (r) => fmtMoney(r.equity), isMono: true },
          { header: 'Headroom', key: 'headroom', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.headroom) }}>{fmtMoney(r.headroom)}</span> },
          { header: 'Allowance used', key: 'allowance_used_pct', render: (r) => fmtPct(r.allowance_used_pct), isMono: true },
          { header: 'Avg daily P&L (5d)', key: 'avg_daily_pnl_5d', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.avg_daily_pnl_5d) }}>{fmtMoney(r.avg_daily_pnl_5d)}</span> },
          {
            header: 'Days to floor',
            key: 'projected_days_to_floor',
            render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--admin-danger)' }}>{fmtNumber(r.projected_days_to_floor, 1)}</span>
          }
        ]}
        data={drawdown.predicted_breach}
        emptyMessage="No account is on track to breach within five days"
      />

      {/* D58, D59 */}
      <SuspectTable
        title="Copy-Trading Pairs"
        eyebrow={`D58 · D59 — accounts opening the same instrument and direction within ${thresholds.simultaneous_open_seconds}s of each other, at least ${thresholds.min_paired_trades} times in ${thresholds.pairwise_lookback_days} days.`}
        note="Overlap is the paired count as a share of the quieter account's own activity. Twelve paired trades out of fifteen is collusion; twelve out of four hundred is coincidence."
        exportName="copy-trading-pairs.csv"
        columns={[
          { header: 'Account A', key: 'account_a_uid', render: (r) => r.account_a_uid || String(r.account_a).slice(0, 8), isMono: true },
          { header: 'Trader A', key: 'trader_a', render: (r) => r.trader_a || '—' },
          { header: 'Account B', key: 'account_b_uid', render: (r) => r.account_b_uid || String(r.account_b).slice(0, 8), isMono: true },
          { header: 'Trader B', key: 'trader_b', render: (r) => r.trader_b || '—' },
          { header: 'Paired trades', key: 'paired_trades', render: (r) => fmtNumber(r.paired_trades), isMono: true },
          { header: 'Instruments', key: 'instruments', render: (r) => fmtNumber(r.instruments), isMono: true },
          { header: 'Avg gap', key: 'avg_gap_seconds', render: (r) => `${fmtNumber(r.avg_gap_seconds, 2)}s`, isMono: true },
          {
            header: 'Overlap',
            key: 'overlap_pct',
            render: (r) => (r.overlap_pct === null
              ? '—'
              : <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: r.overlap_pct > 50 ? 'var(--admin-danger)' : 'var(--admin-warning)' }}>{fmtPct(r.overlap_pct)}</span>)
          }
        ]}
        data={data.copy_trading.pairs}
        emptyMessage="No account pair meets the copy-trading threshold"
      />

      {/* D63, D64, D65, D66, D67 */}
      <SectionHeading>Strategy-Shape Detections</SectionHeading>
      <SectionNote>
        These are the behaviours the challenge models already name — no_martingale, no_grid_trading, no_hedging, no_ea_bots — but that nothing in the product measured until now.
        Every threshold is stated beside its finding rather than hidden.
      </SectionNote>

      <ChartGrid>
        <Card flush title="Martingale" eyebrow={`D63 · size ≥ ${thresholds.martingale_multiplier}× after a loss, 3+ times`}>
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Account', render: (r) => r.account_uid || String(r.account_id).slice(0, 8), isMono: true },
              { header: 'Escalations', render: (r) => fmtNumber(r.escalations), isMono: true },
              { header: 'Rate', render: (r) => fmtPct(r.escalation_pct), isMono: true },
              { header: 'Max multiplier', render: (r) => `${fmtNumber(r.max_multiplier, 2)}×`, isMono: true }
            ]}
            data={strategies.martingale}
            emptyMessage="No martingale pattern detected"
            emptyIcon="approve"
          />
        </Card>

        <Card flush title="Grid Trading" eyebrow={`D64 · ${thresholds.grid_min_positions}+ concurrent positions on one instrument`}>
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Instrument', key: 'instrument', isMono: true },
              { header: 'Open positions', render: (r) => fmtNumber(r.open_positions), isMono: true },
              { header: 'Distinct prices', render: (r) => fmtNumber(r.distinct_prices), isMono: true },
              { header: 'Price band', render: (r) => fmtNumber(r.price_band, 5), isMono: true }
            ]}
            data={strategies.grid}
            emptyMessage="No grid pattern detected"
            emptyIcon="approve"
          />
        </Card>
      </ChartGrid>

      <ChartGrid>
        <Card flush title="Hedging" eyebrow="D65 · opposing positions held at once">
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Instrument', key: 'instrument', isMono: true },
              { header: 'Buy lots', render: (r) => fmtNumber(r.buy_lots, 2), isMono: true },
              { header: 'Sell lots', render: (r) => fmtNumber(r.sell_lots, 2), isMono: true },
              {
                header: 'Offset',
                render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: (r.offset_pct ?? 0) >= 95 ? 'var(--admin-danger)' : 'var(--admin-warning)' }}>{fmtPct(r.offset_pct)}</span>
              }
            ]}
            data={strategies.hedging}
            emptyMessage="No hedged positions open"
            emptyIcon="approve"
          />
        </Card>

        <Card flush title="Tick Scalping" eyebrow={`D67 · ${thresholds.scalp_share_pct}%+ of trades closed inside ${thresholds.scalp_max_seconds}s`}>
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Trades', render: (r) => fmtNumber(r.trades), isMono: true },
              { header: 'Scalps', render: (r) => fmtNumber(r.scalps), isMono: true },
              { header: 'Share', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{fmtPct(r.scalp_share_pct)}</span> },
              { header: 'Net P&L', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.net_pnl) }}>{fmtMoney(r.net_pnl)}</span> }
            ]}
            data={strategies.scalping}
            emptyMessage="No account meets the scalping threshold"
            emptyIcon="approve"
          />
        </Card>
      </ChartGrid>

      {/* D66 */}
      <SuspectTable
        title="Bot / EA Likelihood"
        eyebrow={`D66 · machine-regular spacing (interval CV ≤ ${thresholds.bot_interval_cv}) combined with invariant lot sizing, over ${thresholds.bot_min_trades}+ trades.`}
        note="The score is the sum of its two components, both shown, so an operator can see exactly why an account scored what it did. It is compared against the bot_score already stored on the account rather than replacing it."
        exportName="bot-likelihood.csv"
        columns={[
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—' },
          { header: 'Account', key: 'account_uid', render: (r) => r.account_uid || String(r.account_id).slice(0, 8), isMono: true },
          { header: 'Trades', key: 'trades', render: (r) => fmtNumber(r.trades), isMono: true },
          { header: 'Avg gap', key: 'avg_gap_seconds', render: (r) => `${fmtNumber(r.avg_gap_seconds, 1)}s`, isMono: true },
          { header: 'Interval CV', key: 'gap_cv', render: (r) => (r.gap_cv === null ? '—' : fmtNumber(r.gap_cv, 3)), isMono: true },
          { header: 'Distinct lots', key: 'distinct_lots', render: (r) => fmtNumber(r.distinct_lots), isMono: true },
          { header: 'Stored score', key: 'stored_bot_score', render: (r) => fmtNumber(r.stored_bot_score), isMono: true },
          {
            header: 'Computed score',
            key: 'computed_bot_score',
            render: (r) => <AdminBadge bracket status={r.computed_bot_score >= 80 ? 'danger' : 'warn'} label={String(r.computed_bot_score)} />
          }
        ]}
        data={data.bots.accounts}
        emptyMessage="No account shows machine-regular trading"
      />

      {/* D72 */}
      <SuspectTable
        title="Payout Risk Scoring"
        eyebrow="D72 · every pending and approved withdrawal, scored with each contributing factor shown."
        note="Read as a case, not a verdict. Nothing here blocks a payout — approval still happens in the Payouts page, by a human."
        exportName="payout-risk.csv"
        columns={[
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—' },
          { header: 'Account', key: 'account_uid', render: (r) => r.account_uid || '—', isMono: true },
          { header: 'Amount', key: 'amount_payable', render: (r) => fmtMoney(r.amount_payable), isMono: true },
          { header: 'Requested', key: 'requested_at', render: (r) => fmtDate(r.requested_at), isMono: true },
          {
            header: 'Risk',
            key: 'risk_score',
            render: (r) => (
              <AdminBadge
                bracket
                status={r.risk_band === 'high' ? 'danger' : r.risk_band === 'medium' ? 'warn' : 'approved'}
                label={`${r.risk_score} ${r.risk_band}`}
              />
            )
          },
          {
            header: 'Why',
            csv: false,
            render: (r) => (
              <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                {r.factors.length === 0 ? 'nothing flagged' : r.factors.map((f) => `${f.factor} (+${f.points})`).join(' · ')}
              </span>
            )
          },
          {
            header: 'Already flagged',
            key: 'already_flagged',
            render: (r) => (r.already_flagged ? <AdminBadge bracket status="warn" label="flagged" /> : '—')
          }
        ]}
        data={data.payout_fraud}
        emptyMessage="No pending or approved payouts"
      />

      {/* D73 */}
      <SuspectTable
        title="AML Velocity"
        eyebrow="D73 · money in, minimal trading, money out — ordered by how fast that cycle completed."
        note="A fast cycle is not itself wrongdoing. It is the shape that warrants a look, especially combined with a link cluster or an unapproved KYC."
        exportName="aml-velocity.csv"
        columns={[
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—' },
          { header: 'Account', key: 'account_uid', render: (r) => r.account_uid || '—', isMono: true },
          { header: 'Amount', key: 'amount_payable', render: (r) => fmtMoney(r.amount_payable), isMono: true },
          { header: 'Closed trades', key: 'closed_trades', render: (r) => fmtNumber(r.closed_trades), isMono: true },
          {
            header: 'Purchase → payout',
            key: 'days_purchase_to_payout',
            render: (r) => (r.days_purchase_to_payout === null
              ? '—'
              : <span style={{ fontFamily: 'var(--font-mono)', color: r.fast_cycle ? 'var(--admin-danger)' : 'var(--admin-text)' }}>{fmtNumber(r.days_purchase_to_payout, 1)}d</span>)
          },
          {
            header: 'Fast cycle',
            key: 'fast_cycle',
            render: (r) => (r.fast_cycle ? <AdminBadge bracket status="danger" label="review" /> : '—')
          }
        ]}
        data={data.aml}
        emptyMessage="No payout requests in the last 180 days"
      />

      {/* D68, D69, D70, D71 */}
      <SectionHeading>Shared Identity</SectionHeading>
      <ChartGrid>
        <Card flush title="Shared IP Addresses" eyebrow="D68 · logins and trades, last 90 days">
          <AdminDataTable
            columns={[
              { header: 'IP', key: 'ip_address', isMono: true },
              { header: 'Distinct users', render: (r) => <AdminBadge bracket status={r.users > 3 ? 'danger' : 'warn'} label={String(r.users)} /> }
            ]}
            data={identity.shared_ips}
            emptyMessage="No IP is shared between users"
            emptyIcon="approve"
          />
        </Card>

        <Card title="Devices, Documents and Payout Destinations" eyebrow="D69 · D70">
          <MetricRow
            label="Device fingerprints shared"
            value={fmtNumber(identity.shared_devices.length)}
            tone={identity.shared_devices.length > 0 ? 'var(--admin-warning)' : undefined}
          />
          <MetricRow
            label="KYC documents shared"
            value={fmtNumber(identity.shared_documents.length)}
            tone={identity.shared_documents.length > 0 ? 'var(--admin-danger)' : undefined}
          />
          <MetricRow
            label="Payout destinations reused"
            value={fmtNumber(identity.shared_payment_details.length)}
            tone={identity.shared_payment_details.length > 0 ? 'var(--admin-danger)' : undefined}
          />
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {identity.shared_payment_details.map((p, index) => (
              <MetricRow
                key={index}
                label={`${p.payment_method || 'unspecified'} · ${p.users} users`}
                value={`${fmtNumber(p.payouts)} payouts · ${fmtMoney(p.amount)}`}
              />
            ))}
          </div>
          <SectionNote>
            Document hashes themselves are never rendered — they are KYC identifiers, and the count is the actionable part.
          </SectionNote>
        </Card>
      </ChartGrid>

      <ChartGrid>
        <Card flush title="Account-Link Clusters" eyebrow="D71 · highest scoring">
          <AdminDataTable
            columns={[
              { header: 'Cluster', key: 'cluster_key', isMono: true },
              { header: 'Members', render: (r) => fmtNumber(r.member_count), isMono: true },
              { header: 'Score', render: (r) => <AdminBadge bracket status={r.score >= 70 ? 'danger' : 'warn'} label={String(r.score)} /> },
              { header: 'Confidence', key: 'confidence' },
              { header: 'Signals', render: (r) => (r.signal_types || []).join(', ') },
              { header: 'Status', render: (r) => <AdminBadge bracket status={r.status} label={r.status} /> }
            ]}
            data={data.link_clusters.top}
            emptyMessage="No linked account clusters"
            emptyIcon="approve"
          />
        </Card>

        <AdminChart
          title="New Clusters Detected"
          eyebrow="D71 · daily"
          height={260}
          empty={data.link_clusters.trend.length ? null : 'No clusters first detected in this window.'}
        >
          <LineChart data={data.link_clusters.trend}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Line type="monotone" dataKey="clusters" name="Clusters" stroke="var(--admin-danger)" strokeWidth={2} />
            <Line type="monotone" dataKey="avg_score" name="Avg score" stroke="var(--admin-warning)" strokeWidth={2} />
          </LineChart>
        </AdminChart>
      </ChartGrid>

      {/* D60, D61, D62 */}
      <SectionHeading>Execution Abuse</SectionHeading>
      <ChartGrid>
        <Card flush title="Stale-Price Entries" eyebrow="D60">
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Off-feed trades', render: (r) => fmtNumber(r.off_feed_trades), isMono: true },
              { header: 'Share', render: (r) => fmtPct(r.off_feed_share_pct), isMono: true },
              { header: 'P&L on those', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.off_feed_pnl) }}>{fmtMoney(r.off_feed_pnl)}</span> }
            ]}
            data={data.latency_abuse.accounts}
            emptyMessage="No repeated off-feed entries detected"
            emptyIcon="approve"
          />
          <SectionNote>{data.latency_abuse.threshold_note}</SectionNote>
        </Card>

        <Card flush title="Slippage Outliers" eyebrow={`D61 · z ≥ ${thresholds.slippage_outlier_multiple} against the platform distribution`}>
          <AdminDataTable
            columns={[
              { header: 'Trader', render: (r) => r.trader || '—' },
              { header: 'Trades', render: (r) => fmtNumber(r.trades), isMono: true },
              { header: 'Avg slippage', render: (r) => fmtNumber(r.avg_slippage, 3), isMono: true },
              {
                header: 'z-score',
                render: (r) => (r.z_score === null
                  ? '—'
                  : <span style={{ fontFamily: 'var(--font-mono)', color: r.is_outlier ? 'var(--admin-danger)' : 'var(--admin-text)' }}>{fmtNumber(r.z_score, 2)}</span>)
              }
            ]}
            data={data.slippage.accounts}
            emptyMessage="No account has enough slipped fills to compare"
            emptyIcon="approve"
          />
          <SectionNote>
            Platform average {fmtNumber(data.slippage.platform_avg_slippage, 3)} pips, sd {fmtNumber(data.slippage.platform_sd, 3)}.
          </SectionNote>
        </Card>
      </ChartGrid>

      <SuspectTable
        title="News-Window Trading"
        eyebrow={`D62 · trades opened within ${data.news_window.window_minutes} minutes of a high-impact event.`}
        note={data.news_window.note}
        exportName="news-window-trading.csv"
        columns={[
          { header: 'Trader', key: 'trader', render: (r) => r.trader || '—' },
          { header: 'Account', key: 'account_uid', render: (r) => r.account_uid || '—', isMono: true },
          { header: 'Trades in window', key: 'news_trades', render: (r) => fmtNumber(r.news_trades), isMono: true },
          { header: 'Distinct events', key: 'distinct_events', render: (r) => fmtNumber(r.distinct_events), isMono: true },
          { header: 'P&L', key: 'news_pnl', render: (r) => <span style={{ fontFamily: 'var(--font-mono)', color: toneFor(r.news_pnl) }}>{fmtMoney(r.news_pnl)}</span> }
        ]}
        data={data.news_window.accounts}
        emptyMessage="No trades opened inside a high-impact news window"
      />

      {/* D74, D75 */}
      <SectionHeading>Compliance</SectionHeading>
      <ChartGrid>
        <Card title="KYC Funnel" eyebrow="D74">
          {data.kyc.statuses.map((s) => (
            <MetricRow key={s.kyc_status} label={`${s.kyc_status} · ${fmtPct(s.share_pct)}`} value={fmtNumber(s.users)} />
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Pending right now" value={fmtNumber(data.kyc.pending_now)} />
            <MetricRow
              label="Average time pending"
              value={data.kyc.avg_pending_hours === null ? '—' : `${fmtNumber(data.kyc.avg_pending_hours, 1)}h`}
            />
            <MetricRow
              label="Oldest pending"
              value={data.kyc.oldest_pending_hours === null ? '—' : `${fmtNumber(data.kyc.oldest_pending_hours, 1)}h`}
              tone={(data.kyc.oldest_pending_hours ?? 0) > 72 ? 'var(--admin-danger)' : undefined}
            />
          </div>
          <div style={{ marginTop: 'var(--space-3)' }}>
            {data.kyc.rejection_reasons.map((r) => (
              <MetricRow key={r.reason} label={r.reason} value={fmtNumber(r.users)} mono={false} />
            ))}
          </div>
        </Card>

        {data.geo.available ? (
          <Card flush title="Multi-Country Logins" eyebrow="D75 · last 90 days">
            <AdminDataTable
              columns={[
                { header: 'Trader', render: (r) => r.trader || '—' },
                { header: 'KYC', render: (r) => <AdminBadge bracket status={r.kyc_status} label={r.kyc_status} /> },
                { header: 'Signup country', render: (r) => r.signup_country || '—' },
                { header: 'Login countries', render: (r) => (r.login_countries || []).join(', '), isMono: true },
                { header: 'Count', render: (r) => fmtNumber(r.distinct_countries), isMono: true }
              ]}
              data={data.geo.users}
              emptyMessage="No user logged in from more than one country"
              emptyIcon="globe"
            />
            <SectionNote>
              Geo resolved for {fmtPct(data.geo.coverage.coverage_pct)} of the {fmtNumber(data.geo.coverage.logins_90d)} logins in this period. Unresolved logins count as unknown, never as a mismatch.
            </SectionNote>
          </Card>
        ) : (
          <NeedsData title="Geographic Mismatch (D75)" reason={data.geo.note} />
        )}
      </ChartGrid>

      {/* D76, D77 */}
      <SectionHeading>Admin Activity &amp; Rule Changes</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Actions per Admin"
          eyebrow="D76"
          height={280}
          empty={data.admin_actions.by_actor.length ? null : 'No audited admin actions in this window.'}
        >
          <BarChart data={data.admin_actions.by_actor.slice(0, 12)} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
            <XAxis type="number" {...chartThemeProps.xAxis} allowDecimals={false} />
            <YAxis type="category" dataKey="actor" {...chartThemeProps.yAxis} width={150} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="events" name="Actions">
              {data.admin_actions.by_actor.slice(0, 12).map((a, index) => (
                <Cell key={a.actor} fill={seriesColor(index)} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        <Card title="Governance" eyebrow="D76 · four-eyes and enforcement">
          {data.admin_actions.four_eyes.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No four-eyes requests in this window.</p>
          ) : data.admin_actions.four_eyes.map((f) => (
            <MetricRow
              key={f.status}
              label={`Four-eyes · ${f.status}`}
              value={`${fmtNumber(f.requests)}${f.avg_decision_hours === null ? '' : ` · ${fmtNumber(f.avg_decision_hours, 1)}h`}`}
            />
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {data.admin_actions.enforcement.slice(0, 10).map((e, index) => (
              <MetricRow key={`${e.action}-${e.status}-${index}`} label={`${e.action} · ${e.status}`} value={fmtNumber(e.events)} />
            ))}
          </div>
        </Card>
      </ChartGrid>

      <Card flush>
        <AdminDataTable
          columns={[
            { header: 'Changed', render: (r) => fmtDateTime(r.changed_at), isMono: true },
            { header: 'Setting', key: 'key', isMono: true },
            { header: 'From → To', render: (r) => <span style={{ fontFamily: 'var(--font-mono)' }}>{r.old_value ?? '—'} → {r.new_value ?? '—'}</span> },
            { header: 'Violations before', render: (r) => fmtNumber(r.violations_before), isMono: true },
            { header: 'Violations after', render: (r) => fmtNumber(r.violations_after), isMono: true },
            {
              header: 'Change',
              render: (r) => (r.change_pct === null
                ? '—'
                : <span style={{ fontFamily: 'var(--font-mono)', color: r.change_pct > 0 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>{r.change_pct > 0 ? '+' : ''}{fmtNumber(r.change_pct, 1)}%</span>)
            }
          ]}
          data={data.rule_change_impact}
          emptyMessage="No settings changed in this window"
          emptyIcon="settings"
        />
      </Card>
      <SectionNote>D77 · fourteen days either side of each change. Correlational — other things move in a fortnight too.</SectionNote>
    </>
  );
}
