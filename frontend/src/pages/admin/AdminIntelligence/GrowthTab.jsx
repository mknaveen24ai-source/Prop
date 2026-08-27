import React from 'react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart
} from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, NeedsData, ChartGrid, SectionHeading,
  SectionNote, MetricRow, fmtMoney, fmtNumber, fmtPct, fmtDate, fmtDuration
} from './shared';
import { Funnel, GeoRanking, Versus } from './charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Firm Intelligence → Growth & Affiliate (E78–E95).

export default function GrowthTab({ adminAxios, dateRange, onUpdated }) {
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/growth', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const { funnel, activation, retention, affiliates } = data;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="users" label="Signups" value={fmtNumber(funnel.stages.find((s) => s.stage === 'Registered')?.count)} />
        <AdminStatCard icon="activity" label="Activation Rate" value={fmtPct(activation.activation_pct)} />
        <AdminStatCard icon="trades" label="Signup → Paid" value={fmtPct(activation.conversion_pct)} />
        <AdminStatCard icon="timer" label="Time to First Trade" value={fmtDuration(activation.avg_hours_to_first_trade === null ? null : activation.avg_hours_to_first_trade * 60)} />
        <AdminStatCard icon="affiliate" label="Affiliates Active" value={fmtNumber(affiliates.leaderboard.length)} />
        <AdminStatCard
          icon="warning"
          label="Dormant 30d"
          value={fmtNumber(retention.dormancy.dormant_30d)}
          alert={retention.dormancy.dormant_30d_pct > 40}
        />
      </AdminStatGrid>

      {/* E78 */}
      <ChartGrid>
        <Funnel title="Acquisition Funnel" eyebrow="E78 · visit through to paid" stages={funnel.stages} />

        <Card title="Conversion Rates" eyebrow="E78 · stage to stage">
          <MetricRow label="Visit → signup" value={fmtPct(funnel.conversion.visit_to_signup_pct)} />
          <MetricRow label="Signup → order created" value={fmtPct(funnel.conversion.signup_to_order_pct)} />
          <MetricRow label="Order → paid" value={fmtPct(funnel.conversion.order_to_paid_pct)} />
          <MetricRow label="Visit → paid" value={fmtPct(funnel.conversion.visit_to_paid_pct)} tone="var(--admin-accent)" />
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label="Signups placing a first trade" value={fmtPct(activation.activation_pct)} />
            <MetricRow label="Average days to first order" value={activation.avg_days_to_first_order === null ? '—' : fmtNumber(activation.avg_days_to_first_order, 1)} />
          </div>
        </Card>
      </ChartGrid>

      {/* E79 */}
      <SectionHeading>Attribution</SectionHeading>
      {funnel.attribution_available ? (
        <Card flush style={{ marginBottom: 'var(--space-6)' }}>
          <AdminDataTable
            columns={[
              { header: 'Source', key: 'source', isMono: true },
              { header: 'Medium', render: (r) => r.medium || '—' },
              { header: 'Campaign', render: (r) => r.campaign || '—' },
              { header: 'Sessions', render: (r) => fmtNumber(r.sessions), isMono: true },
              { header: 'Signups', render: (r) => fmtNumber(r.signups), isMono: true },
              { header: 'Buyers', render: (r) => fmtNumber(r.buyers), isMono: true },
              { header: 'Revenue', render: (r) => fmtMoney(r.revenue), isMono: true },
              { header: 'Rev / session', render: (r) => fmtMoney(r.revenue_per_session, { decimals: 2 }), isMono: true }
            ]}
            data={funnel.by_source}
            emptyMessage="No attributed sessions in this window"
            emptyIcon="globe"
          />
        </Card>
      ) : (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <NeedsData title="Campaign Attribution (E79)" reason={funnel.attribution_note} />
        </div>
      )}

      <ChartGrid>
        <AdminChart
          title="Signups and Paid Orders"
          eyebrow="daily"
          height={260}
        >
          <ComposedChart data={data.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="signups" name="Signups" fill="var(--admin-accent)" />
            <Line type="monotone" dataKey="orders_paid" name="Paid orders" stroke="var(--admin-success)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </AdminChart>

        <AdminChart
          title="Days from Signup to First Purchase"
          eyebrow="E95"
          height={260}
          empty={activation.lag_histogram.length ? null : 'No purchases from this window’s signups yet.'}
        >
          <BarChart data={activation.lag_histogram}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="bucket" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="users" name="Users" fill="var(--admin-warning)" />
          </BarChart>
        </AdminChart>
      </ChartGrid>

      {/* E82, E83, E84 */}
      <SectionHeading>Retention</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Cohort Retention"
          eyebrow="E82 · still trading after signup"
          height={280}
          empty={retention.cohorts.length ? null : 'No signup cohorts in the last 12 weeks.'}
        >
          <LineChart data={retention.cohorts}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="cohort_week" {...chartThemeProps.xAxis} minTickGap={20} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `${v}%`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtPct(value)} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Line type="monotone" dataKey="week_1_pct" name="Week 1" stroke="var(--admin-accent)" strokeWidth={2} />
            <Line type="monotone" dataKey="week_2_3_pct" name="Weeks 2–3" stroke="var(--admin-success)" strokeWidth={2} />
            <Line type="monotone" dataKey="week_4_plus_pct" name="Week 4+" stroke="var(--admin-warning)" strokeWidth={2} />
          </LineChart>
        </AdminChart>

        <Card title="Dormancy &amp; Reactivation" eyebrow="E83 · E84">
          <MetricRow label="Active accounts" value={fmtNumber(retention.dormancy.active_accounts)} />
          <MetricRow label="Never traded" value={fmtNumber(retention.dormancy.never_traded)} tone="var(--admin-warning)" />
          <MetricRow label="No trade in 7 days" value={fmtNumber(retention.dormancy.dormant_7d)} />
          <MetricRow label="No trade in 14 days" value={fmtNumber(retention.dormancy.dormant_14d)} />
          <MetricRow label="No trade in 30 days" value={`${fmtNumber(retention.dormancy.dormant_30d)} (${fmtPct(retention.dormancy.dormant_30d_pct)})`} tone="var(--admin-danger)" />
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            <MetricRow label={`Buyers lapsed over ${retention.reactivation.lapse_threshold_days} days`} value={fmtNumber(retention.reactivation.lapsed_buyers)} />
            <MetricRow label="Came back and bought" value={`${fmtNumber(retention.reactivation.reactivated)} (${fmtPct(retention.reactivation.reactivation_pct)})`} tone="var(--admin-success)" />
          </div>
        </Card>
      </ChartGrid>

      {/* E85, E86, E87, E88 */}
      <SectionHeading
        action={
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => downloadCsv('affiliates.csv', affiliates.leaderboard, [
              { header: 'Affiliate', value: (r) => r.affiliate },
              { header: 'Code', value: (r) => r.affiliate_code },
              { header: 'Referrals', value: (r) => r.referrals },
              { header: 'Paying referrals', value: (r) => r.paying_referrals },
              { header: 'Referred revenue', value: (r) => r.referred_revenue },
              { header: 'Commission earned', value: (r) => r.commission_earned }
            ])}
          >
            Export CSV
          </button>
        }
      >
        Affiliates
      </SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={[
            { header: 'Affiliate', render: (r) => r.affiliate || '—' },
            { header: 'Code', render: (r) => r.affiliate_code || '—', isMono: true },
            { header: 'Referrals', render: (r) => fmtNumber(r.referrals), isMono: true },
            { header: 'Paying', render: (r) => `${fmtNumber(r.paying_referrals)} (${fmtPct(r.conversion_pct)})`, isMono: true },
            { header: 'Referred revenue', render: (r) => fmtMoney(r.referred_revenue), isMono: true },
            { header: 'Commission', render: (r) => fmtMoney(r.commission_earned, { decimals: 2 }), isMono: true },
            {
              header: 'Rev / commission $',
              render: (r) => (r.revenue_per_commission_dollar === null
                ? '—'
                : <span style={{ fontFamily: 'var(--font-mono)', color: r.revenue_per_commission_dollar >= 5 ? 'var(--admin-success)' : 'var(--admin-warning)' }}>{fmtNumber(r.revenue_per_commission_dollar, 1)}×</span>)
            }
          ]}
          data={affiliates.leaderboard}
          emptyMessage="No referrals in this window"
          emptyIcon="affiliate"
        />
      </Card>

      <ChartGrid>
        <Card title="Referred vs Organic Quality" eyebrow="E86">
          <Versus
            label="Accounts"
            left={affiliates.quality.referred.accounts}
            right={affiliates.quality.organic.accounts}
            leftLabel="Referred"
            rightLabel="Organic"
          />
          <MetricRow label="Referred pass rate" value={fmtPct(affiliates.quality.referred.pass_rate_pct)} />
          <MetricRow label="Organic pass rate" value={fmtPct(affiliates.quality.organic.pass_rate_pct)} />
          <MetricRow label="Referred payout cost / account" value={fmtMoney(affiliates.quality.referred.payout_cost_per_account, { decimals: 2 })} />
          <MetricRow label="Organic payout cost / account" value={fmtMoney(affiliates.quality.organic.payout_cost_per_account, { decimals: 2 })} />
          <SectionNote>
            If referred traders pass more often and cost more in payouts, the commission is buying expensive customers, not cheap ones.
          </SectionNote>
        </Card>

        <Card title="Commission State &amp; Tiers" eyebrow="E88">
          {affiliates.commission_state.map((c) => (
            <MetricRow key={c.status} label={`${c.status} (${fmtNumber(c.commissions)})`} value={fmtMoney(c.amount, { decimals: 2 })} />
          ))}
          <div style={{ marginTop: 'var(--space-4)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule)' }}>
            {affiliates.tiers.length === 0
              ? <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-sm)', margin: 0 }}>No tiered commissions in this window.</p>
              : affiliates.tiers.map((t) => (
                <MetricRow key={t.tier_rank} label={`Tier ${t.tier_rank} · ${fmtPct(t.avg_rate_pct, 0)}`} value={fmtMoney(t.amount, { decimals: 2 })} />
              ))}
          </div>
        </Card>
      </ChartGrid>

      {/* E87 */}
      {affiliates.self_referral_suspects.length > 0 ? (
        <>
          <SectionHeading>Possible Self-Referral</SectionHeading>
          <Card flush style={{ marginBottom: 'var(--space-2)' }}>
            <AdminDataTable
              columns={[
                { header: 'Referrer', render: (r) => r.referrer || '—' },
                { header: 'Referred', render: (r) => r.referred || '—' },
                { header: 'Referred on', render: (r) => fmtDate(r.created_at), isMono: true },
                { header: 'Commission', render: (r) => fmtMoney(r.commission, { decimals: 2 }), isMono: true },
                { header: 'Evidence', render: (r) => <AdminBadge status="warn" label={r.evidence} /> }
              ]}
              data={affiliates.self_referral_suspects}
              emptyMessage="None detected"
              emptyIcon="approve"
            />
          </Card>
          <SectionNote>
            The referrer and the person they referred appear in the same account-link cluster — shared device, IP or identity document. Read as a lead for review, not a finding.
          </SectionNote>
        </>
      ) : null}

      {/* E81 */}
      <SectionHeading>Experiments</SectionHeading>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        {data.experiments.length === 0 ? (
          <Card><p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No experiments recorded.</p></Card>
        ) : data.experiments.map((exp) => (
          <Card key={exp.key} title={exp.name} eyebrow={`E81 · ${exp.status} · outcome: ${exp.outcome_metric || 'unset'}`} style={{ marginBottom: 'var(--space-4)' }}>
            {exp.variants.map((v) => (
              <MetricRow
                key={v.variant_key}
                label={`${v.variant_key} · ${fmtNumber(v.users)} users`}
                value={`${fmtNumber(v.conversions)} conv · ${fmtPct(v.conversion_pct)}`}
              />
            ))}
            {exp.comparisons.map((c) => (
              <div key={c.variant_key} style={{ marginTop: 'var(--space-3)', padding: 'var(--space-3)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)' }}>
                <div style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)', marginBottom: 'var(--space-1)' }}>
                  <strong>{c.variant_key}</strong> vs <strong>{c.vs_control}</strong>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                  {c.lift_pct_points === null ? 'no lift computable' : `${c.lift_pct_points > 0 ? '+' : ''}${fmtNumber(c.lift_pct_points, 1)}pt`}
                  {c.test
                    ? ` · z=${c.test.z} · p=${c.test.p_value} · ${c.test.significant ? 'significant' : 'not significant'}`
                    : ' · sample too small for a valid test'}
                </div>
              </div>
            ))}
          </Card>
        ))}
      </div>

      {/* E92 */}
      <SectionHeading>Geography</SectionHeading>
      <ChartGrid>
        <GeoRanking title="Signups, Revenue and Pass Rate by Country" eyebrow="E92" rows={data.geography} />

        <Card title="Competitions &amp; Seasons" eyebrow="E89 · E90 · E91">
          {data.competitions.length === 0 && data.referral_seasons.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No competitions or referral seasons in this window.</p>
          ) : (
            <>
              {data.competitions.map((c) => (
                <div key={c.id} style={{ marginBottom: 'var(--space-4)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{c.title}</strong>
                    <AdminBadge bracket status={c.status} label={c.status} />
                  </div>
                  <MetricRow label="Entries" value={fmtNumber(c.entries)} />
                  <MetricRow label="Completion" value={fmtPct(c.completion_pct)} />
                  <MetricRow label="Disqualified" value={fmtPct(c.disqualification_pct)} tone="var(--admin-warning)" />
                  <MetricRow label="Bought within 30 days after" value={`${fmtNumber(c.followed_by_purchase)} (${fmtPct(c.purchase_rate_pct)})`} tone="var(--admin-success)" />
                  <MetricRow label="Revenue in that window" value={fmtMoney(c.revenue_30d_after)} />
                </div>
              ))}
              {data.referral_seasons.map((s) => (
                <div key={s.id} style={{ marginBottom: 'var(--space-3)' }}>
                  <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>{s.title}</strong>
                  <MetricRow label="Entrants" value={fmtNumber(s.entrants)} />
                  <MetricRow label="Paying referrals" value={fmtNumber(s.paying_referrals)} />
                  <MetricRow label="Referrals per entrant" value={fmtNumber(s.referrals_per_entrant, 2)} />
                </div>
              ))}
            </>
          )}
        </Card>
      </ChartGrid>

      {/* E93, E94 */}
      <SectionHeading>Email &amp; Public Pages</SectionHeading>
      <ChartGrid>
        <Card flush title="Email Delivery" eyebrow="E93">
          <AdminDataTable
            columns={[
              { header: 'Template', key: 'template_key', isMono: true },
              { header: 'Jobs', render: (r) => fmtNumber(r.jobs), isMono: true },
              { header: 'Delivered', render: (r) => <span style={{ color: r.delivery_pct >= 95 ? 'var(--admin-success)' : 'var(--admin-warning)', fontFamily: 'var(--font-mono)' }}>{fmtPct(r.delivery_pct)}</span> },
              { header: 'Failed', render: (r) => fmtNumber(r.failed), isMono: true },
              { header: 'Avg attempts', render: (r) => fmtNumber(r.avg_attempts, 2), isMono: true }
            ]}
            data={data.email.templates}
            emptyMessage="No email jobs in this window"
            emptyIcon="mail"
          />
        </Card>

        <Card title="Public Page Reach" eyebrow="E94">
          {data.public_pages.pages.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>No page-stage events recorded yet.</p>
          ) : data.public_pages.pages.map((p) => (
            <MetricRow key={p.page} label={p.page.replace(/_/g, ' ')} value={`${fmtNumber(p.sessions)} sessions`} />
          ))}
          <SectionNote>{data.public_pages.tracked_since_note}</SectionNote>
          <SectionNote>{data.email.note}</SectionNote>
        </Card>
      </ChartGrid>
    </>
  );
}
