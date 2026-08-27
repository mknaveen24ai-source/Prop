import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  NeedsData, ChartGrid, SectionHeading, SectionNote, MetricRow,
  fmtMoney, fmtNumber, fmtPct, fmtDate, toneFor
} from '../AdminIntelligence/shared';
import { Meter, Versus } from '../AdminIntelligence/charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Trader & Risk Intelligence → Benchmark (J143–J150).

export default function BenchmarkTab({ data }) {
  const b = data.benchmarks;
  const setups = data.setups;
  const journal = data.journal;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard
          icon="leaderboard"
          label="Percentile Rank"
          value={b?.available ? fmtPct(b.percentile_rank) : '—'}
        />
        <AdminStatCard icon="users" label="Peer Group Size" value={fmtNumber(b?.peers)} />
        <AdminStatCard icon="approve" label="Passers in Group" value={b?.available ? fmtNumber(b.passers) : '—'} />
        <AdminStatCard icon="journal" label="Journalling Rate" value={fmtPct(journal?.notes.journalling_rate_pct)} />
      </AdminStatGrid>

      {/* J143, J144, J145 */}
      {b?.available ? (
        <>
          <ChartGrid>
            <Card title="Rank in Peer Group" eyebrow={`J143 · ${b.peer_group}`}>
              <Meter
                label="Net P&L percentile"
                value={b.percentile_rank ?? 0}
                caption={`Ahead of ${fmtPct(b.percentile_rank)} of ${fmtNumber(b.peers)} comparable accounts`}
                tone={(b.percentile_rank ?? 0) >= 50 ? 'var(--admin-success)' : 'var(--admin-warning)'}
              />
              <SectionNote>
                Peers are accounts on the same challenge model at the same account size, with at least ten closed trades. Anything looser would be comparing different games.
              </SectionNote>
            </Card>

            <AdminChart
              title="This Trader against Peers and Passers"
              eyebrow="J144 · J145"
              height={280}
            >
              <BarChart data={b.comparison.filter((c) => c.metric !== 'Net P&L')}>
                <CartesianGrid {...chartThemeProps.grid} />
                <XAxis dataKey="metric" {...chartThemeProps.xAxis} />
                <YAxis {...chartThemeProps.yAxis} />
                <Tooltip {...chartThemeProps.tooltip} formatter={(value) => (value === null ? '—' : fmtNumber(value, 2))} />
                <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
                <Bar dataKey="trader" name="This trader" fill="var(--admin-accent)" />
                <Bar dataKey="peer_avg" name="Peer average" fill="var(--admin-text-faint)" />
                <Bar dataKey="passer_avg" name="Passers" fill="var(--admin-success)" />
              </BarChart>
            </AdminChart>
          </ChartGrid>

          <Card flush style={{ marginBottom: 'var(--space-6)' }}>
            <AdminDataTable
              columns={[
                { header: 'Metric', key: 'metric' },
                { header: 'This trader', render: (r) => (r.trader === null ? '—' : fmtNumber(r.trader, 2)), isMono: true },
                { header: 'Peer average', render: (r) => (r.peer_avg === null ? '—' : fmtNumber(r.peer_avg, 2)), isMono: true },
                { header: 'Passers', render: (r) => (r.passer_avg === null ? '—' : fmtNumber(r.passer_avg, 2)), isMono: true },
                {
                  header: 'Verdict',
                  render: (r) => {
                    if (r.trader === null || r.peer_avg === null) return '—';
                    const ahead = Number(r.trader) >= Number(r.peer_avg);
                    return <AdminBadge bracket status={ahead ? 'approved' : 'warn'} label={ahead ? 'ahead' : 'behind'} />;
                  }
                }
              ]}
              data={b.comparison}
              emptyMessage="No comparison available"
              emptyIcon="leaderboard"
            />
          </Card>
        </>
      ) : (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <NeedsData title="Peer Benchmarking (J143–J145)" reason={b?.reason || 'No comparable accounts to rank against.'} />
        </div>
      )}

      {/* J148 */}
      <SectionHeading>Best and Worst Setups</SectionHeading>
      <ChartGrid>
        <Card title="Working" eyebrow="J148 · best setups">
          {(setups?.best_setups || []).length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>Not enough trades per setup to rank them.</p>
          ) : setups.best_setups.map((s, index) => (
            <div key={`${s.setup_type}-${s.label}-${index}`} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{s.label}</strong>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-success)' }}>{fmtMoney(s.total_pnl, { signed: true })}</span>
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                {s.setup_type} · {fmtNumber(s.trades)} trades · {fmtPct(s.win_rate)} win rate
              </div>
            </div>
          ))}
        </Card>

        <Card title="Not Working" eyebrow="J148 · worst setups">
          {(setups?.worst_setups || []).length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>Not enough trades per setup to rank them.</p>
          ) : setups.worst_setups.map((s, index) => (
            <div key={`${s.setup_type}-${s.label}-${index}`} style={{ marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{s.label}</strong>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-danger)' }}>{fmtMoney(s.total_pnl, { signed: true })}</span>
              </div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                {s.setup_type} · {fmtNumber(s.trades)} trades · {fmtPct(s.win_rate)} win rate
              </div>
            </div>
          ))}
        </Card>
      </ChartGrid>

      {/* J149 */}
      <SectionHeading
        action={
          journal?.tags.length > 0 ? (
            <button
              type="button"
              className="admin-filter-chip"
              onClick={() => downloadCsv('trader-tags.csv', journal.tags, [
                { header: 'Tag', value: (r) => r.tag },
                { header: 'Trades', value: (r) => r.trades },
                { header: 'Win rate %', value: (r) => r.win_rate_pct },
                { header: 'Net P&L', value: (r) => r.net_pnl },
                { header: 'Avg P&L', value: (r) => r.avg_pnl }
              ])}
            >
              Export CSV
            </button>
          ) : null
        }
      >
        Journal Signal
      </SectionHeading>
      <ChartGrid>
        <Card title="Journalled vs Unjournalled" eyebrow="J149">
          <Versus
            label="Trades"
            left={journal?.notes.journalled.trades}
            right={journal?.notes.unjournalled.trades}
            leftLabel="With notes"
            rightLabel="Without"
          />
          <MetricRow label="Win rate with notes" value={fmtPct(journal?.notes.journalled.win_rate_pct)} />
          <MetricRow label="Win rate without" value={fmtPct(journal?.notes.unjournalled.win_rate_pct)} />
          <MetricRow
            label="Average P&L with notes"
            value={fmtMoney(journal?.notes.journalled.avg_pnl, { decimals: 2, signed: true })}
            tone={toneFor(journal?.notes.journalled.avg_pnl)}
          />
          <MetricRow
            label="Average P&L without"
            value={fmtMoney(journal?.notes.unjournalled.avg_pnl, { decimals: 2, signed: true })}
            tone={toneFor(journal?.notes.unjournalled.avg_pnl)}
          />
          <SectionNote>
            Descriptive, not causal — a trader who journals is likely more deliberate in other ways too. It is still worth knowing which half of their book they thought about.
          </SectionNote>
        </Card>

        <AdminChart
          title="Performance by Tag"
          eyebrow="J149"
          height={280}
          empty={journal?.tags.length ? null : 'This trader has not tagged any trades.'}
        >
          <BarChart data={journal?.tags.slice(0, 12) || []} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
            <XAxis type="number" {...chartThemeProps.xAxis} tickFormatter={(v) => fmtMoney(v)} />
            <YAxis type="category" dataKey="tag" {...chartThemeProps.yAxis} width={110} />
            <Tooltip
              {...chartThemeProps.tooltip}
              formatter={(value) => fmtMoney(value, { decimals: 2 })}
              labelFormatter={(label) => {
                const row = (journal?.tags || []).find((t) => t.tag === label);
                return row ? `${label} · ${row.trades} trades · ${fmtPct(row.win_rate_pct)} win rate` : label;
              }}
            />
            <Bar dataKey="net_pnl" name="Net P&L">
              {(journal?.tags.slice(0, 12) || []).map((t) => (
                <Cell key={t.tag} fill={t.net_pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)'} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>
      </ChartGrid>

      {/* J150 */}
      <SectionHeading>Milestones</SectionHeading>
      <Card flush>
        <AdminDataTable
          columns={[
            { header: 'When', render: (r) => fmtDate(r.at), isMono: true },
            { header: 'Event', render: (r) => <AdminBadge bracket status={r.kind === 'passed' ? 'approved' : r.kind === 'certificate' ? 'accent' : 'muted'} label={r.kind.replace(/_/g, ' ')} /> },
            { header: 'Detail', render: (r) => r.label || '—' },
            { header: 'Status', render: (r) => r.status || '—' }
          ]}
          data={data.milestones?.timeline || []}
          emptyMessage="No milestones recorded"
          emptyIcon="leaderboard"
        />
      </Card>
      <SectionNote>
        J150 · account creations, phase passes and issued certificates on one timeline. Certificates are the trader-visible record, so a revoked one is worth noticing here before they ask about it.
      </SectionNote>
    </>
  );
}
