import React, { useState, useEffect, useCallback } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { affiliateAPI, normalizeApiError } from '../services/api'
import { renderIcon } from '../utils/iconMap'
import Pagination from '../components/Pagination'
import { formatCurrency } from '../utils/finance'
import Card from '../components/ui/Card'
import StatCell from '../components/ui/StatCell'
import Table from '../components/ui/Table'
import StatusBadge from '../components/ui/StatusBadge'
import AdminChart, { chartThemeProps } from '../components/admin/AdminChart'

const PAGE_SIZE = 10

const USDT_NETWORKS = [
  { id: 'trc20', label: 'TRC20 (Tron)' },
  { id: 'bep20', label: 'BEP20 (BNB Smart Chain)' },
  { id: 'erc20', label: 'ERC20 (Ethereum)' },
  { id: 'polygon', label: 'Polygon' },
]

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'commissions', label: 'Commissions' },
  { key: 'payouts', label: 'Payouts' },
]

const EMPTY_CHART_STYLE = { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '260px', color: 'var(--text-muted)', fontSize: '13px' }

/**
 * AffiliateAnalysisTab — referral performance + earnings breakdown for the
 * logged-in trader, scoped mirror of the admin Affiliate Analysis view
 * (pages/admin/AdminAffiliates.jsx) but per-affiliate instead of platform-wide.
 * Reuses the parent's `summary` for the funnel stats (already loaded via
 * affiliateAPI.getMe()) and only fetches its own month-series data.
 */
function AffiliateAnalysisTab({ summary }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    affiliateAPI.getAnalytics()
      .then(res => { if (!cancelled) setData(res.data) })
      .catch(err => { if (!cancelled) setError(normalizeApiError(err, 'Could not load affiliate analytics').message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '60px', color: 'var(--text-muted)' }}>Loading...</div>
  }
  if (error || !data) {
    return <Card style={{ padding: '24px', color: 'var(--red)' }}>{error || 'Could not load affiliate analytics.'}</Card>
  }

  const { referralsByMonth, commissionByMonth } = data
  const totalReferrals = summary?.total_referrals || 0
  const payingReferrals = summary?.paying_referrals || 0
  const conversionPct = totalReferrals > 0 ? Math.round((payingReferrals / totalReferrals) * 1000) / 10 : 0

  return (
    <>
      <div className="grid-2" style={{ marginBottom: '20px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCell label="Total Referrals" value={totalReferrals} />
        <StatCell label="Paying Referrals" value={payingReferrals} tone="gain" />
        <StatCell label="Conversion Rate" value={`${conversionPct}%`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
        <AdminChart title="Referrals by Month">
          {referralsByMonth.length > 0 ? (
            <BarChart data={referralsByMonth}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
              <Tooltip {...chartThemeProps.tooltip} />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="total" fill="var(--accent)" name="Total Referrals" radius={[4, 4, 0, 0]} />
              <Bar dataKey="paying" fill="var(--green)" name="Paying Referrals" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : (
            <div style={EMPTY_CHART_STYLE}>No referrals in the last 6 months</div>
          )}
        </AdminChart>

        <AdminChart title="Commission Earned by Month">
          {commissionByMonth.length > 0 ? (
            <BarChart data={commissionByMonth}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${v}`} />
              <Tooltip {...chartThemeProps.tooltip} formatter={(value) => [`$${Number(value).toLocaleString()}`, undefined]} />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="paid" stackId="commission" fill="var(--green)" name="Paid" />
              <Bar dataKey="pending" stackId="commission" fill="var(--muted)" name="Pending" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : (
            <div style={EMPTY_CHART_STYLE}>No commission earned in the last 6 months</div>
          )}
        </AdminChart>
      </div>
    </>
  )
}

/**
 * DashboardAffiliatePage — Affiliate tab. Self-contained (fetches its own
 * data via affiliateAPI) rather than prop-driven from Dashboard.jsx, mirroring
 * the DashboardCompetitionsPage precedent for tabs with their own paginated
 * server-backed lists. Internal sub-tabs (Overview/Analysis/Referrals/
 * Commissions/Payouts) use the .service-tabs pattern from Support.jsx.
 */
export default function DashboardAffiliatePage() {
  const [activeTab, setActiveTab] = useState('overview')
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [referrals, setReferrals] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })
  const [commissions, setCommissions] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })
  const [payouts, setPayouts] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })

  const [payoutForm, setPayoutForm] = useState({ amount_requested: '', payment_method: 'usdt_trc20', payment_details: '' })
  const [submitting, setSubmitting] = useState(false)
  const [payoutMessage, setPayoutMessage] = useState(null)
  const [copied, setCopied] = useState(false)

  const loadSummary = useCallback(() => {
    return affiliateAPI.getMe()
      .then(res => setSummary(res.data))
      .catch(err => setError(normalizeApiError(err, 'Could not load affiliate summary').message))
  }, [])

  const loadReferrals = useCallback((page = 1) => {
    affiliateAPI.getReferrals({ page, pageSize: PAGE_SIZE })
      .then(res => setReferrals(res.data))
      .catch(() => {})
  }, [])

  const loadCommissions = useCallback((page = 1) => {
    affiliateAPI.getCommissions({ page, pageSize: PAGE_SIZE })
      .then(res => setCommissions(res.data))
      .catch(() => {})
  }, [])

  const loadPayouts = useCallback((page = 1) => {
    affiliateAPI.getPayouts({ page, pageSize: PAGE_SIZE })
      .then(res => setPayouts(res.data))
      .catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    Promise.all([loadSummary(), loadReferrals(1), loadCommissions(1), loadPayouts(1)])
      .finally(() => setLoading(false))
  }, [loadSummary, loadReferrals, loadCommissions, loadPayouts])

  function copyReferralLink() {
    if (!summary?.referral_link) return
    navigator.clipboard.writeText(summary.referral_link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {})
  }

  async function requestPayout(e) {
    e.preventDefault()
    setSubmitting(true)
    setPayoutMessage(null)
    try {
      await affiliateAPI.requestPayout({ ...payoutForm, amount_requested: parseFloat(payoutForm.amount_requested) })
      setPayoutMessage({ type: 'success', text: 'Payout request submitted. It will be settled once approved.' })
      setPayoutForm({ amount_requested: '', payment_method: 'usdt_trc20', payment_details: '' })
      await Promise.all([loadSummary(), loadPayouts(1)])
    } catch (err) {
      setPayoutMessage({ type: 'error', text: normalizeApiError(err, 'Could not submit payout request').message })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div>
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
          Affiliate Program
        </h2>
        <div style={{ textAlign: 'center', padding: '80px', color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div>
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
          Affiliate Program
        </h2>
        <Card style={{ padding: '24px', color: 'var(--red)' }}>{error}</Card>
      </div>
    )
  }

  const currentTier = summary?.current_tier
  const nextTier = summary?.next_tier
  const payingReferrals = summary?.paying_referrals || 0
  const progressPct = nextTier
    ? Math.min(100, Math.round((payingReferrals / nextTier.min_referrals) * 100))
    : 100

  const [payoutCurrency, payoutNetwork] = payoutForm.payment_method.startsWith('usdt_')
    ? ['usdt', payoutForm.payment_method.slice(5)]
    : [payoutForm.payment_method, USDT_NETWORKS[0].id]

  const totalReferralPages = Math.max(1, Math.ceil(referrals.total / referrals.pageSize))
  const totalCommissionPages = Math.max(1, Math.ceil(commissions.total / commissions.pageSize))
  const totalPayoutPages = Math.max(1, Math.ceil(payouts.total / payouts.pageSize))

  const referralColumns = [
    { key: 'full_name', header: 'Name' },
    { key: 'country', header: 'Country', render: r => r.country || '—' },
    { key: 'referred_at', header: 'Joined', render: r => new Date(r.referred_at).toLocaleDateString() },
    { key: 'status', header: 'Status', render: r => (
      <StatusBadge status={r.is_paying ? 'paid' : 'pending'} label={r.is_paying ? 'Paying' : 'Not yet purchased'} />
    ) },
    { key: 'total_commission_generated', header: 'Commission Generated', align: 'right', render: r => formatCurrency(r.total_commission_generated) },
  ]

  const commissionColumns = [
    { key: 'referred_full_name', header: 'From', render: c => c.referred_full_name || (c.order_id ? '—' : 'Manual adjustment') },
    { key: 'order_amount', header: 'Order Amount', align: 'right', render: c => c.order_amount != null ? formatCurrency(c.order_amount) : '—' },
    { key: 'commission_rate_pct', header: 'Rate', align: 'right', render: c => c.commission_rate_pct != null ? `${c.commission_rate_pct}%` : '—' },
    { key: 'commission_amount', header: 'Commission', align: 'right', render: c => (
      <span style={{ color: c.commission_amount < 0 ? 'var(--red)' : 'var(--green)' }}>{formatCurrency(c.commission_amount)}</span>
    ) },
    { key: 'status', header: 'Status', render: c => <StatusBadge status={c.status} /> },
    { key: 'earned_at', header: 'Earned', render: c => new Date(c.earned_at).toLocaleDateString() },
  ]

  const payoutColumns = [
    { key: 'amount_requested', header: 'Amount', align: 'right', render: p => formatCurrency(p.amount_requested) },
    { key: 'payment_method', header: 'Method' },
    { key: 'status', header: 'Status', render: p => <StatusBadge status={p.status} /> },
    { key: 'requested_at', header: 'Requested', render: p => new Date(p.requested_at).toLocaleDateString() },
    { key: 'paid_at', header: 'Paid', render: p => p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—' },
  ]

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
        Affiliate Program
      </h2>

      <div className="service-tabs">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            className={`service-tab ${activeTab === t.key ? 'is-active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          <Card title="Your Referral Link" style={{ marginBottom: '20px', maxWidth: '700px' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '12px' }}>
              Share this link. Anyone who signs up gets a discount on their first challenge, and you earn
              commission on every challenge they ever purchase — for life.
            </p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{
                flex: '1 1 300px', padding: '10px 14px', background: 'var(--bg-surface)',
                border: '1px solid var(--border)', borderRadius: '6px', fontSize: '13px',
                color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'nowrap'
              }}>
                {summary?.referral_link || '—'}
              </code>
              <button className="btn btn-secondary" onClick={copyReferralLink} type="button">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {renderIcon('copy', { size: 14, color: 'currentColor' })}
                  {copied ? 'Copied!' : 'Copy'}
                </span>
              </button>
            </div>
            <p style={{ marginTop: '10px', fontSize: '12px', color: 'var(--text-muted)' }}>
              Referral code: <strong style={{ color: 'var(--text-secondary)' }}>{summary?.affiliate_code || '—'}</strong>
            </p>
          </Card>

          <div className="grid-2" style={{ marginBottom: '20px', maxWidth: '700px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <StatCell label="Lifetime Commission" value={formatCurrency(summary?.lifetime_commission || 0)} tone="gain" />
            <StatCell label="Available Balance" value={formatCurrency(summary?.available_balance || 0)} />
            <StatCell label="Total Referrals" value={summary?.total_referrals || 0} />
            <StatCell label="Paying Referrals" value={payingReferrals} />
          </div>

          <Card title="Commission Tier" style={{ maxWidth: '700px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '8px' }}>
              <span style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-secondary)' }}>
                {currentTier ? `${currentTier.label || 'Tier ' + currentTier.tier_rank} — ${currentTier.commission_pct}%` : '—'}
              </span>
              {nextTier && (
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  {nextTier.min_referrals - payingReferrals} more paying referral{nextTier.min_referrals - payingReferrals === 1 ? '' : 's'} to reach {nextTier.label || `Tier ${nextTier.tier_rank}`} ({nextTier.commission_pct}%)
                </span>
              )}
            </div>
            {nextTier && (
              <div style={{ height: '8px', borderRadius: '4px', background: 'var(--bg-surface)', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--accent)', transition: 'width 0.3s' }} />
              </div>
            )}
            {!nextTier && currentTier && (
              <p style={{ fontSize: '12px', color: 'var(--green)', margin: 0 }}>You've reached the highest tier.</p>
            )}
          </Card>
        </>
      )}

      {activeTab === 'analysis' && <AffiliateAnalysisTab summary={summary} />}

      {activeTab === 'referrals' && (
        <Card title="Your Referrals" style={{ maxWidth: '900px' }}>
          <Table
            columns={referralColumns}
            rows={referrals.rows}
            emptyMessage="No referrals yet. Share your link to get started."
          />
          <Pagination
            page={referrals.page}
            totalPages={totalReferralPages}
            onPageChange={loadReferrals}
            pageSize={referrals.pageSize}
            total={referrals.total}
          />
        </Card>
      )}

      {activeTab === 'commissions' && (
        <Card title="Commission Ledger" style={{ maxWidth: '900px' }}>
          <Table
            columns={commissionColumns}
            rows={commissions.rows}
            emptyMessage="No commissions earned yet."
          />
          <Pagination
            page={commissions.page}
            totalPages={totalCommissionPages}
            onPageChange={loadCommissions}
            pageSize={commissions.pageSize}
            total={commissions.total}
          />
        </Card>
      )}

      {activeTab === 'payouts' && (
        <>
          <Card title="Request Payout" style={{ marginBottom: '20px', maxWidth: '700px' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
              Available balance: {formatCurrency(summary?.available_balance || 0)}. Enter the amount you'd like to withdraw.
            </p>
            {payoutMessage && (
              <div style={{
                padding: '10px 14px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px',
                background: payoutMessage.type === 'success' ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--red) 12%, transparent)',
                color: payoutMessage.type === 'success' ? 'var(--green)' : 'var(--red)'
              }}>
                {payoutMessage.text}
              </div>
            )}
            <form onSubmit={requestPayout}>
              <div style={{ marginBottom: '16px' }}>
                <label>Amount (USD)</label>
                <input
                  type="number"
                  value={payoutForm.amount_requested}
                  onChange={e => setPayoutForm({ ...payoutForm, amount_requested: e.target.value })}
                  placeholder={`Max ${formatCurrency(summary?.available_balance || 0)}`}
                  min="0.01"
                  max={summary?.available_balance || 0}
                  step="0.01"
                  required
                />
                <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                  {[0.25, 0.5, 1].map(pct => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-secondary"
                      style={{ flex: 1, padding: '6px', fontSize: '11px' }}
                      onClick={() => setPayoutForm({ ...payoutForm, amount_requested: String(Math.floor((summary?.available_balance || 0) * pct * 100) / 100) })}
                    >
                      {pct === 1 ? 'Max' : `${pct * 100}%`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid-2 payout-form-grid">
                <div>
                  <label>Cryptocurrency</label>
                  <select
                    value={payoutCurrency}
                    onChange={e => {
                      const currency = e.target.value
                      setPayoutForm({ ...payoutForm, payment_method: currency === 'usdt' ? `usdt_${payoutNetwork}` : currency })
                    }}
                  >
                    <option value="usdt">USDT</option>
                    <option value="btc">Bitcoin (BTC)</option>
                    <option value="ltc">Litecoin (LTC)</option>
                  </select>
                  {payoutCurrency === 'usdt' && (
                    <div style={{ marginTop: '12px' }}>
                      <label>Network</label>
                      <select
                        value={payoutNetwork}
                        onChange={e => setPayoutForm({ ...payoutForm, payment_method: `usdt_${e.target.value}` })}
                      >
                        {USDT_NETWORKS.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div>
                  <label>Payment Details</label>
                  <textarea
                    value={payoutForm.payment_details}
                    onChange={e => setPayoutForm({ ...payoutForm, payment_details: e.target.value })}
                    placeholder="Enter your wallet address"
                    rows="4"
                    required
                    style={{ resize: 'vertical' }}
                  />
                  <p style={{ marginTop: '8px', fontSize: '11.5px', color: 'var(--warn, var(--text-muted))' }}>
                    Double-check before submitting — crypto payouts are final. Funds sent to an incorrect address or wrong network cannot be recovered.
                  </p>
                </div>
              </div>
              <button
                className="btn btn-accent"
                type="submit"
                style={{ marginTop: '16px', padding: '12px 32px' }}
                disabled={submitting || !(summary?.available_balance > 0) || !(parseFloat(payoutForm.amount_requested) > 0) || parseFloat(payoutForm.amount_requested) > (summary?.available_balance || 0)}
              >
                {submitting ? 'Submitting...' : 'Submit Payout Request'}
              </button>
            </form>
          </Card>

          <Card title="Payout History" style={{ maxWidth: '900px' }}>
            <Table
              columns={payoutColumns}
              rows={payouts.rows}
              emptyMessage="No payout requests yet."
            />
            <Pagination
              page={payouts.page}
              totalPages={totalPayoutPages}
              onPageChange={loadPayouts}
              pageSize={payouts.pageSize}
              total={payouts.total}
            />
          </Card>
        </>
      )}
    </div>
  )
}
