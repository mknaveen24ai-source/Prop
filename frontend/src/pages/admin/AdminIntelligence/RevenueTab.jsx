import React, { useState } from 'react';
import {
  Area, BarChart, Bar, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart
} from 'recharts';
import AdminChart, { chartThemeProps, renderActiveDonutArc } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import Card from '../../../components/ui/Card';
import {
  useIntelligence, TabLoading, TabError, NeedsData, ChartGrid, SectionHeading,
  SectionNote, MetricRow, fmtMoney, fmtNumber, fmtPct, fmtDuration, toneFor, seriesColor
} from './shared';
import { Funnel } from './charts';
import { downloadCsv } from '../AdminAnalytics/shared';

// Firm Intelligence → Revenue & Economics (A1–A25).
// Read-only: the only interaction beyond filtering is a CSV export.

export default function RevenueTab({ adminAxios, dateRange, onUpdated }) {
  const [donutIndex, setDonutIndex] = useState(null);
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/revenue', {
    params: { from: dateRange.from, to: dateRange.to },
    intervalMs: 60000
  });

  React.useEffect(() => { if (data?.generated_at) onUpdated?.(new Date(data.generated_at)); }, [data, onUpdated]);

  if (loading) return <TabLoading />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const t = data.series.totals;
  const ltv = data.lifetime_value;

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="pnl" label="Gross Revenue" value={fmtMoney(t.gross_revenue)} />
        <AdminStatCard
          icon="wallet"
          label="Net After Payouts"
          value={<span style={{ color: toneFor(t.net_revenue) }}>{fmtMoney(t.net_revenue)}</span>}
          trendDirection={t.net_revenue >= 0 ? 'up' : 'down'}
        />
        <AdminStatCard icon="trades" label="Paid Orders" value={fmtNumber(t.orders_paid)} />
        <AdminStatCard icon="balance" label="Avg Order Value" value={fmtMoney(t.avg_order_value)} />
        <AdminStatCard icon="users" label="Returning Buyer Share" value={fmtPct(t.returning_buyer_share_pct)} />
        <AdminStatCard icon="affiliate" label="Affiliate Commission" value={fmtMoney(t.affiliate_commission)} />
      </AdminStatGrid>

      {/* A1, A2, A22 */}
      <ChartGrid min={520}>
        <AdminChart title="Revenue, Payouts and Orders" eyebrow="A1 · A2 · daily" height={320}>
          <ComposedChart data={data.series.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis yAxisId="money" {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <YAxis yAxisId="count" orientation="right" {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value, name) => (name === 'Orders' ? fmtNumber(value) : fmtMoney(value, { decimals: 2 }))} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Area yAxisId="money" type="monotone" dataKey="gross_revenue" name="Gross revenue" stroke="var(--admin-accent)" fill="var(--admin-accent)" fillOpacity={0.18} strokeWidth={2} />
            <Area yAxisId="money" type="monotone" dataKey="payouts_paid" name="Payouts" stroke="var(--admin-danger)" fill="var(--admin-danger)" fillOpacity={0.14} strokeWidth={2} />
            <Line yAxisId="count" type="monotone" dataKey="orders_paid" name="Orders" stroke="var(--admin-warning)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </AdminChart>
      </ChartGrid>

      <ChartGrid>
        {/* A22 */}
        <AdminChart title="New vs Returning Buyers" eyebrow="A22 · daily" height={260}>
          <BarChart data={data.series.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="new_buyers" stackId="b" name="New" fill="var(--admin-accent)" />
            <Bar dataKey="returning_buyers" stackId="b" name="Returning" fill="var(--admin-success)" />
          </BarChart>
        </AdminChart>

        {/* A1 provider split */}
        <AdminChart
          title="Revenue by Payment Provider"
          eyebrow="A1 · A8"
          height={260}
          empty={data.series.providers.length ? null : 'No paid orders in this window.'}
        >
          <PieChart>
            <Pie
              data={data.series.providers}
              dataKey="revenue"
              nameKey="provider"
              innerRadius={55}
              outerRadius={90}
              activeIndex={donutIndex}
              activeShape={renderActiveDonutArc}
              onMouseEnter={(_, index) => setDonutIndex(index)}
              onMouseLeave={() => setDonutIndex(null)}
            >
              {data.series.providers.map((entry, index) => (
                <Cell key={entry.provider} fill={seriesColor(index)} />
              ))}
            </Pie>
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
          </PieChart>
        </AdminChart>
      </ChartGrid>

      {/* A6, A7, A8 */}
      <SectionHeading>Checkout &amp; Payment Quality</SectionHeading>
      <ChartGrid>
        <Funnel
          title="Order to Payment"
          eyebrow="A6 · checkout conversion"
          stages={[
            { stage: 'Orders created', count: data.checkout.orders_created },
            { stage: 'Provider session opened', count: data.checkout.orders_with_session },
            { stage: 'Paid', count: data.checkout.orders_paid }
          ]}
        />

        <Card title="Time to Pay" eyebrow="A7 · from order creation">
          <MetricRow label="Median" value={fmtDuration(data.checkout.time_to_pay_mins.median)} />
          <MetricRow label="Paid within 10 minutes" value={fmtPct(data.checkout.time_to_pay_mins.under_10_min_pct)} />
          <MetricRow label="Took over 24 hours" value={fmtPct(data.checkout.time_to_pay_mins.over_24h_pct)} tone="var(--admin-warning)" />
          <MetricRow label="Abandonment rate" value={fmtPct(data.checkout.abandonment_pct)} tone="var(--admin-danger)" />
          <MetricRow label="Unconverted order value" value={fmtMoney(data.checkout.unconverted_value)} />
          <SectionNote>Median rather than mean — a single order paid weeks late would drag an average into meaninglessness.</SectionNote>
        </Card>
      </ChartGrid>

      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={[
            { header: 'Provider', key: 'provider', isMono: true },
            { header: 'Attempts', render: (r) => fmtNumber(r.attempts), isMono: true },
            { header: 'Success', render: (r) => <span style={{ color: r.success_pct >= 90 ? 'var(--admin-success)' : 'var(--admin-warning)' }}>{fmtPct(r.success_pct)}</span> },
            { header: 'Captured', render: (r) => fmtMoney(r.captured), isMono: true },
            { header: 'Platform fees', render: (r) => fmtMoney(r.platform_fees, { decimals: 2 }), isMono: true },
            { header: 'Settle time', render: (r) => (r.avg_settle_seconds === null ? '—' : `${fmtNumber(r.avg_settle_seconds, 1)}s`), isMono: true }
          ]}
          data={data.checkout.providers}
          emptyMessage="No payment attempts in this window"
          emptyIcon="wallet"
        />
      </Card>

      {/* A4, A5 */}
      <SectionHeading>Where the Revenue Comes From</SectionHeading>
      <ChartGrid>
        <AdminChart
          title="Revenue by Account Size"
          eyebrow="A4"
          height={260}
          empty={data.cuts.by_account_size.length ? null : 'No paid orders in this window.'}
        >
          <BarChart data={data.cuts.by_account_size}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="account_size" {...chartThemeProps.xAxis} tickFormatter={(v) => fmtMoney(v)} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} labelFormatter={(v) => `${fmtMoney(v)} account`} />
            <Bar dataKey="revenue" name="Revenue" fill="var(--admin-accent)" />
          </BarChart>
        </AdminChart>

        <AdminChart
          title="Revenue by Challenge Model"
          eyebrow="A5"
          height={260}
          empty={data.cuts.by_model.length ? null : 'No paid orders in this window.'}
        >
          <BarChart data={data.cuts.by_model} layout="vertical" margin={{ left: 24 }}>
            <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
            <XAxis type="number" {...chartThemeProps.xAxis} tickFormatter={(v) => fmtMoney(v)} />
            <YAxis type="category" dataKey="model_name" {...chartThemeProps.yAxis} width={110} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Bar dataKey="revenue" name="Revenue" fill="var(--admin-success)" />
          </BarChart>
        </AdminChart>
      </ChartGrid>

      {/* A17, A25 */}
      <SectionHeading
        action={
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => downloadCsv('model-margin.csv', data.model_margin, [
              { header: 'Model', value: (r) => r.model_slug },
              { header: 'Orders', value: (r) => r.orders },
              { header: 'Revenue', value: (r) => r.revenue },
              { header: 'Payouts', value: (r) => r.payouts },
              { header: 'Gross margin', value: (r) => r.gross_margin },
              { header: 'Margin %', value: (r) => r.gross_margin_pct },
              { header: 'Break-even payouts', value: (r) => r.breakeven_payouts }
            ])}
          >
            Export CSV
          </button>
        }
      >
        Margin &amp; Break-even by Model
      </SectionHeading>
      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Model', key: 'model_slug', isMono: true },
            { header: 'Orders', render: (r) => fmtNumber(r.orders), isMono: true },
            { header: 'Revenue', render: (r) => fmtMoney(r.revenue), isMono: true },
            { header: 'Payouts', render: (r) => fmtMoney(r.payouts), isMono: true },
            { header: 'Gross margin', render: (r) => <span style={{ color: toneFor(r.gross_margin), fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.gross_margin)}</span> },
            { header: 'Margin %', render: (r) => fmtPct(r.gross_margin_pct), isMono: true },
            { header: 'Pass rate', render: (r) => fmtPct(r.pass_rate_pct), isMono: true },
            { header: 'Break-even payouts', render: (r) => (r.breakeven_payouts === null ? '—' : fmtNumber(r.breakeven_payouts)), isMono: true }
          ]}
          data={data.model_margin}
          emptyMessage="No model activity in this window"
          emptyIcon="challenges"
        />
      </Card>
      <SectionNote>
        Break-even is how many payouts of that model&apos;s own observed average size its sales can absorb before margin reaches zero. Blank where the model has never paid out — the denominator would have to be invented.
      </SectionNote>

      {/* A18 */}
      <SectionHeading>B-Book Edge</SectionHeading>
      <ChartGrid min={520}>
        <AdminChart title="Firm Edge vs Trader P&L" eyebrow="A18 · daily" height={280}>
          <ComposedChart data={data.bbook.daily}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="date" {...chartThemeProps.xAxis} minTickGap={28} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="firm_edge" name="Firm edge" fill="var(--admin-success)" />
            <Line type="monotone" dataKey="broker_pnl" name="Broker P&L" stroke="var(--admin-warning)" strokeWidth={2} dot={false} />
          </ComposedChart>
        </AdminChart>
      </ChartGrid>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={[
            { header: 'Instrument', key: 'instrument', isMono: true },
            { header: 'Trades', render: (r) => fmtNumber(r.trades), isMono: true },
            { header: 'Volume (lots)', render: (r) => fmtNumber(r.volume_lots, 2), isMono: true },
            { header: 'Trader P&L', render: (r) => <span style={{ color: toneFor(r.demo_pnl), fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.demo_pnl)}</span> },
            { header: 'Broker P&L', render: (r) => <span style={{ color: toneFor(r.broker_pnl), fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.broker_pnl)}</span> },
            { header: 'Divergence', render: (r) => fmtMoney(r.divergence), isMono: true }
          ]}
          data={data.bbook.by_instrument}
          emptyMessage="No closed trades in this window"
          emptyIcon="trades"
        />
      </Card>

      {/* A14, A15, A16 */}
      <SectionHeading>Cohort Value</SectionHeading>
      {ltv.cac_available ? (
        <ChartGrid min={520}>
          <AdminChart title="LTV against CAC by Cohort" eyebrow="A14 · A15 · A16" height={280}>
            <ComposedChart data={ltv.cohorts}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="cohort_month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => fmtMoney(v)} />
              <Tooltip {...chartThemeProps.tooltip} formatter={(value) => fmtMoney(value, { decimals: 2 })} />
              <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
              <Bar dataKey="ltv" name="LTV per user" fill="var(--admin-accent)" />
              <Bar dataKey="cac" name="CAC per user" fill="var(--admin-danger)" />
            </ComposedChart>
          </AdminChart>
        </ChartGrid>
      ) : (
        <div style={{ marginBottom: 'var(--space-6)' }}>
          <NeedsData title="LTV:CAC and Payback (A15, A16)" reason={ltv.cac_note} />
        </div>
      )}

      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Cohort', key: 'cohort_month', isMono: true },
            { header: 'Users', render: (r) => fmtNumber(r.users), isMono: true },
            { header: 'Revenue', render: (r) => fmtMoney(r.revenue), isMono: true },
            { header: 'Payouts', render: (r) => fmtMoney(r.payouts), isMono: true },
            { header: 'Contribution', render: (r) => <span style={{ color: toneFor(r.contribution), fontFamily: 'var(--font-mono)' }}>{fmtMoney(r.contribution)}</span> },
            { header: 'LTV', render: (r) => fmtMoney(r.ltv, { decimals: 2 }), isMono: true },
            { header: 'CAC', render: (r) => (r.cac === null ? '—' : fmtMoney(r.cac, { decimals: 2 })), isMono: true },
            { header: 'LTV:CAC', render: (r) => (r.ltv_cac_ratio === null ? '—' : `${fmtNumber(r.ltv_cac_ratio, 2)}×`), isMono: true }
          ]}
          data={ltv.cohorts}
          emptyMessage="No cohorts in the last 12 months"
          emptyIcon="users"
        />
      </Card>
      <SectionNote>{ltv.range_note}</SectionNote>

      {/* A9, A10, A24 */}
      <SectionHeading>Discounting</SectionHeading>
      <ChartGrid>
        <Card title="Cannibalisation" eyebrow="A10 · discounted vs full price">
          <MetricRow label="Discounted revenue share" value={fmtPct(data.coupons.cannibalisation.discounted_revenue_share_pct)} tone="var(--admin-warning)" />
          <MetricRow label="Discounted orders" value={fmtNumber(data.coupons.cannibalisation.discounted_orders)} />
          <MetricRow label="Full-price orders" value={fmtNumber(data.coupons.cannibalisation.full_price_orders)} />
          <MetricRow label="Average realised price" value={fmtMoney(data.coupons.discount_depth.avg_realised_price, { decimals: 2 })} />
          <MetricRow label="Average list price" value={fmtMoney(data.coupons.discount_depth.avg_list_price, { decimals: 2 })} />
          <MetricRow label="Average discount depth" value={fmtPct(data.coupons.discount_depth.avg_discount_depth_pct)} />
          <SectionNote>
            Depth compares each order against the active price row for its own model and size; orders with no matching active price are excluded rather than compared against a guess.
          </SectionNote>
        </Card>

        <Card title="Gift Vouchers" eyebrow="A11">
          <MetricRow label="Issued" value={fmtNumber(data.gifts.issued)} />
          <MetricRow label="Claimed" value={fmtNumber(data.gifts.claimed)} tone="var(--admin-success)" />
          <MetricRow label="Redemption rate" value={fmtPct(data.gifts.redemption_pct)} />
          <MetricRow label="Average days to claim" value={data.gifts.avg_days_to_claim === null ? '—' : fmtNumber(data.gifts.avg_days_to_claim, 1)} />
          <MetricRow label="Expired" value={fmtNumber(data.gifts.expired)} tone="var(--admin-warning)" />
          <MetricRow label="Value paid" value={fmtMoney(data.gifts.amount_paid)} />
        </Card>
      </ChartGrid>

      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          columns={[
            { header: 'Code', key: 'code', isMono: true },
            { header: 'Type', render: (r) => `${r.discount_value}${r.discount_type === 'percent' ? '%' : '$'}` },
            { header: 'Redemptions', render: (r) => fmtNumber(r.redemptions), isMono: true },
            { header: 'Users', render: (r) => fmtNumber(r.distinct_users), isMono: true },
            { header: 'Discount given', render: (r) => fmtMoney(r.discount_given, { decimals: 2 }), isMono: true },
            { header: 'Revenue alongside', render: (r) => fmtMoney(r.revenue_after_discount, { decimals: 2 }), isMono: true },
            { header: 'Rev / discount $', render: (r) => (r.revenue_per_discount_dollar === null ? '—' : `${fmtNumber(r.revenue_per_discount_dollar, 2)}×`), isMono: true }
          ]}
          data={data.coupons.per_code}
          emptyMessage="No coupons redeemed in this window"
          emptyIcon="wallet"
        />
      </Card>
      <SectionNote>
        &quot;Rev / discount $&quot; is a ratio, not a causal uplift — the platform runs no coupon holdout, so it cannot say what these buyers would have done at full price.
      </SectionNote>

      {/* A12, A19, A13, A21, A20, A23 */}
      <SectionHeading>Buyers, Retries and Concentration</SectionHeading>
      <ChartGrid>
        <AdminChart title="Orders per Buyer" eyebrow="A12" height={240}>
          <BarChart data={data.buyers.orders_histogram}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="orders" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Bar dataKey="buyers" name="Buyers" fill="var(--admin-accent)" />
          </BarChart>
        </AdminChart>

        <Card title="Concentration &amp; Retries" eyebrow="A19 · A13 · A21">
          <MetricRow label="Top 1% of buyers" value={fmtPct(data.buyers.concentration.top_1_pct_share)} />
          <MetricRow label="Top 5% of buyers" value={fmtPct(data.buyers.concentration.top_5_pct_share)} />
          <MetricRow label="Top 10% of buyers" value={fmtPct(data.buyers.concentration.top_10_pct_share)} />
          <MetricRow label="Repeat purchase rate" value={fmtPct(data.buyers.repeat_purchase_pct)} />
          <MetricRow label="Failed accounts" value={fmtNumber(data.retries.failed_accounts)} />
          <MetricRow label="Bought again after failing" value={fmtPct(data.retries.paid_recovery_pct)} tone="var(--admin-success)" />
          <MetricRow label="Paid but unstarted" value={fmtMoney(data.deferred.unstarted_value)} />
          <MetricRow label="In-progress notional" value={fmtMoney(data.deferred.in_progress_notional)} />
          <MetricRow label="Refund-shaped payments" value={fmtMoney(data.refunds.refund_amount)} tone="var(--admin-danger)" />
          {data.refunds.note ? <SectionNote>{data.refunds.note}</SectionNote> : null}
        </Card>
      </ChartGrid>

      <SectionHeading>Revenue by Country</SectionHeading>
      <Card flush>
        <AdminDataTable
          columns={[
            { header: 'Country', key: 'country' },
            { header: 'Currency', key: 'currency', isMono: true },
            { header: 'Orders', render: (r) => fmtNumber(r.orders), isMono: true },
            { header: 'Revenue', render: (r) => fmtMoney(r.revenue), isMono: true }
          ]}
          data={data.cuts.by_country}
          emptyMessage="No paid orders in this window"
          emptyIcon="globe"
        />
      </Card>
    </>
  );
}
