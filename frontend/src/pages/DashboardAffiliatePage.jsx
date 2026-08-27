import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { affiliateAPI, referralSeasonAPI, normalizeApiError } from '../services/api'
import { renderIcon } from '../utils/iconMap'
import Pagination from '../components/Pagination'
import { formatCurrency } from '../utils/finance'
import Card from '../components/ui/Card'
import StatCell from '../components/ui/StatCell'
import Table from '../components/ui/Table'
import StatusBadge from '../components/ui/StatusBadge'
import ProgressBar from '../components/ui/ProgressBar'
import AdminChart, { chartThemeProps } from '../components/admin/AdminChart'
import { CRYPTO_CURRENCIES, USDT_NETWORKS } from '../utils/paymentMethods'
import { exportRowsToCSV } from '../utils/exportCsv'

const PAGE_SIZE = 10

const REFERRAL_EXPORT_COLUMNS = [
  { header: 'Name', value: (r) => r.full_name },
  { header: 'Country', value: (r) => r.country || '' },
  { header: 'Joined', value: (r) => new Date(r.referred_at).toISOString() },
  { header: 'Status', value: (r) => (r.is_paying ? 'Paying' : 'Not yet purchased') },
  { header: 'Commission Generated', value: (r) => parseFloat(r.total_commission_generated || 0).toFixed(2) },
]

const COMMISSION_EXPORT_COLUMNS = [
  { header: 'From', value: (c) => c.referred_full_name || (c.order_id ? '' : 'Manual adjustment') },
  { header: 'Order Amount', value: (c) => (c.order_amount != null ? parseFloat(c.order_amount).toFixed(2) : '') },
  { header: 'Rate %', value: (c) => (c.commission_rate_pct != null ? c.commission_rate_pct : '') },
  { header: 'Commission', value: (c) => parseFloat(c.commission_amount || 0).toFixed(2) },
  { header: 'Status', value: (c) => c.status },
  { header: 'Earned', value: (c) => new Date(c.earned_at).toISOString() },
]

const PAYOUT_EXPORT_COLUMNS = [
  { header: 'Amount', value: (p) => parseFloat(p.amount_requested || 0).toFixed(2) },
  { header: 'Method', value: (p) => p.payment_method },
  { header: 'Status', value: (p) => p.status },
  { header: 'Requested', value: (p) => new Date(p.requested_at).toISOString() },
  { header: 'Paid', value: (p) => (p.paid_at ? new Date(p.paid_at).toISOString() : '') },
]

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'analysis', label: 'Analysis' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'commissions', label: 'Commissions' },
  { key: 'payouts', label: 'Payouts' },
  { key: 'season', label: 'Referral Season' },
]

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
    return <div style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>Loading...</div>
  }
  if (error || !data) {
    return <Card style={{ padding: 'var(--space-6)', color: 'var(--red)' }}>{error || 'Could not load affiliate analytics.'}</Card>
  }

  const { referralsByMonth, commissionByMonth } = data
  const totalReferrals = summary?.total_referrals || 0
  const payingReferrals = summary?.paying_referrals || 0
  const conversionPct = totalReferrals > 0 ? Math.round((payingReferrals / totalReferrals) * 1000) / 10 : 0

  return (
    <>
      <div style={{ display: 'grid', gap: 'var(--space-4)', marginBottom: 'var(--space-5)', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <StatCell label="Total Referrals" value={totalReferrals} />
        <StatCell label="Paying Referrals" value={payingReferrals} tone="gain" />
        <StatCell label="Conversion Rate" value={`${conversionPct}%`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 'var(--space-5)' }}>
        <AdminChart title="Referrals by Month" empty={referralsByMonth.length === 0 ? 'No referrals in the last 6 months' : null}>
          {referralsByMonth.length > 0 && (
            <BarChart data={referralsByMonth}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
              <Tooltip {...chartThemeProps.tooltip} />
              <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
              <Bar dataKey="total" fill="var(--accent)" name="Total Referrals" radius={[4, 4, 0, 0]} />
              <Bar dataKey="paying" fill="var(--green)" name="Paying Referrals" radius={[4, 4, 0, 0]} />
            </BarChart>
          )}
        </AdminChart>

        <AdminChart title="Commission Earned by Month" empty={commissionByMonth.length === 0 ? 'No commission earned in the last 6 months' : null}>
          {commissionByMonth.length > 0 && (
            <BarChart data={commissionByMonth}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${v}`} />
              <Tooltip {...chartThemeProps.tooltip} formatter={(value) => [`$${Number(value).toLocaleString()}`, undefined]} />
              <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
              <Bar dataKey="paid" stackId="commission" fill="var(--green)" name="Paid" />
              <Bar dataKey="pending" stackId="commission" fill="var(--muted)" name="Pending" radius={[4, 4, 0, 0]} />
            </BarChart>
          )}
        </AdminChart>
      </div>
    </>
  )
}

/**
 * ReferralSeasonTab — a time-boxed referral leaderboard (see
 * backend/referralSeasonEngine.js), separate from the lifetime commission
 * tier ladder shown on the Overview tab. Picks the most relevant season
 * (active > upcoming > most recently completed) and shows the standings plus
 * the trader's own rank, self-contained like AffiliateAnalysisTab above.
 */
function ReferralSeasonTab() {
  const [season, setSeason] = useState(undefined) // undefined = loading, null = none found
  const [myEntry, setMyEntry] = useState(null)
  const [leaderboard, setLeaderboard] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    referralSeasonAPI.list()
      .then(async (res) => {
        const seasons = Array.isArray(res.data) ? res.data : []
        const chosen = seasons.find(s => s.status === 'active')
          || seasons.find(s => s.status === 'upcoming')
          || seasons.find(s => s.status === 'completed')
          || null
        if (cancelled) return
        setSeason(chosen)
        if (!chosen) return

        const [detailRes, leaderboardRes] = await Promise.all([
          referralSeasonAPI.getBySlug(chosen.slug),
          referralSeasonAPI.getLeaderboard(chosen.slug)
        ])
        if (cancelled) return
        setMyEntry(detailRes.data?.my_entry || null)
        setLeaderboard(Array.isArray(leaderboardRes.data) ? leaderboardRes.data : [])
      })
      .catch(err => { if (!cancelled) setError(normalizeApiError(err, 'Could not load the referral season').message) })
    return () => { cancelled = true }
  }, [])

  if (season === undefined) {
    return <div style={{ textAlign: 'center', padding: 'var(--space-10)', color: 'var(--text-muted)' }}>Loading...</div>
  }
  if (error) {
    return <Card style={{ padding: 'var(--space-6)', color: 'var(--red)' }}>{error}</Card>
  }
  if (!season) {
    return (
      <Card style={{ maxWidth: '700px' }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', margin: 0 }}>
          No referral season is running right now — check back soon. Seasons rank affiliates by new paying
          referrals over a set period, with free challenge accounts for the top finishers.
        </p>
      </Card>
    )
  }

  const myRank = myEntry?.final_rank ?? null

  return (
    <>
      <Card style={{ marginBottom: 'var(--space-5)', maxWidth: '700px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 'var(--space-2)', marginBottom: 'var(--space-1-5)' }}>
          <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-secondary)' }}>{season.title}</span>
          <StatusBadge status={season.status} />
        </div>
        {season.description && (
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-2-5)' }}>{season.description}</p>
        )}
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', margin: 0 }}>
          {new Date(season.start_at).toLocaleDateString()} – {new Date(season.end_at).toLocaleDateString()}
        </p>
        {season.prize_pool?.length > 0 && (
          <div style={{ marginTop: 'var(--space-3-5)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule-soft, var(--navy-border))' }}>
            <div style={{ fontSize: 'var(--fs-xs)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 'var(--space-2)' }}>Prizes</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {season.prize_pool.map((p, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-base)' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Rank #{p.rank}</span>
                  <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{p.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {myEntry && (
          <div style={{ marginTop: 'var(--space-3-5)', paddingTop: 'var(--space-3)', borderTop: '1px solid var(--rule-soft, var(--navy-border))', display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)' }}>Your standing</span>
            <span style={{ fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)', color: 'var(--accent)' }}>
              {myRank ? `#${myRank}` : 'Unranked'} · {myEntry.new_paying_referrals} new paying referral{myEntry.new_paying_referrals === 1 ? '' : 's'}
            </span>
          </div>
        )}
      </Card>

      <Card title="Leaderboard" style={{ maxWidth: '700px' }}>
        <Table
          columns={[
            { key: 'rank', header: 'Rank', render: r => `#${r.rank}` },
            { key: 'full_name', header: 'Trader', render: r => r.full_name || 'Trader' },
            { key: 'new_paying_referrals', header: 'New Paying Referrals', align: 'right' },
          ]}
          rows={leaderboard}
          emptyMessage="No referrals recorded yet this season."
        />
      </Card>
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
const TAB_KEYS = ['overview', 'analysis', 'referrals', 'commissions', 'payouts', 'season']

export default function DashboardAffiliatePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab = TAB_KEYS.includes(tabParam) ? tabParam : 'overview'
  const setActiveTab = (tab) => setSearchParams(
    (prev) => {
      const next = new URLSearchParams(prev)
      if (tab === 'overview') next.delete('tab')
      else next.set('tab', tab)
      return next
    },
    { replace: true }
  )
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
  const [copyFailed, setCopyFailed] = useState(false)
  const referralLinkRef = useRef(null)

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
    setCopyFailed(false)
    if (!navigator.clipboard) {
      selectReferralLinkText()
      setCopyFailed(true)
      return
    }
    navigator.clipboard.writeText(summary.referral_link).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch(() => {
      selectReferralLinkText()
      setCopyFailed(true)
    })
  }

  function selectReferralLinkText() {
    if (!referralLinkRef.current || !window.getSelection) return
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(referralLinkRef.current)
    selection.removeAllRanges()
    selection.addRange(range)
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
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 'var(--space-6)', fontSize: 'var(--fs-3xl)' }}>
          Affiliate Program
        </h2>
        <div style={{ textAlign: 'center', padding: 'var(--space-11)', color: 'var(--text-muted)' }}>Loading...</div>
      </div>
    )
  }

  if (error && !summary) {
    return (
      <div>
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 'var(--space-6)', fontSize: 'var(--fs-3xl)' }}>
          Affiliate Program
        </h2>
        <Card style={{ padding: 'var(--space-6)', color: 'var(--red)' }}>{error}</Card>
      </div>
    )
  }

  const currentTier = summary?.current_tier
  const nextTier = summary?.next_tier
  const allTiers = summary?.all_tiers || []
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
    { key: 'full_name', header: 'Name', primary: true },
    { key: 'country', header: 'Country', render: r => r.country || '—' },
    { key: 'referred_at', header: 'Joined', render: r => new Date(r.referred_at).toLocaleDateString() },
    { key: 'status', header: 'Status', render: r => (
      <StatusBadge status={r.is_paying ? 'paid' : 'pending'} label={r.is_paying ? 'Paying' : 'Not yet purchased'} />
    ) },
    { key: 'total_commission_generated', header: 'Commission Generated', align: 'right', render: r => formatCurrency(r.total_commission_generated) },
  ]

  const commissionColumns = [
    { key: 'referred_full_name', header: 'From', primary: true, render: c => c.referred_full_name || (c.order_id ? '—' : 'Manual adjustment') },
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
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 'var(--space-6)', fontSize: 'var(--fs-3xl)' }}>
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
          <Card title="Your Referral Link" style={{ marginBottom: 'var(--space-5)', maxWidth: '700px' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-3)' }}>
              Share this link. Anyone who signs up gets a discount on their first challenge, and you earn
              commission on every challenge they ever purchase — for life.
            </p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <code ref={referralLinkRef} style={{
                flex: '1 1 300px', padding: 'var(--space-2-5) var(--space-3-5)', background: 'var(--bg-surface)',
                border: '1px solid var(--border)', borderRadius: '6px', fontSize: 'var(--fs-base)',
                color: 'var(--text-secondary)', overflowX: 'auto', whiteSpace: 'nowrap'
              }}>
                {summary?.referral_link || '—'}
              </code>
              <button className="btn btn-secondary" onClick={copyReferralLink} type="button">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                  {renderIcon('copy', { size: 14, color: 'currentColor' })}
                  {copied ? 'Copied!' : 'Copy'}
                </span>
              </button>
            </div>
            {copyFailed && (
              <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--warn)' }} role="alert">
                Couldn't copy automatically — the link is selected above, press Ctrl/Cmd+C to copy it.
              </p>
            )}
            <p style={{ marginTop: 'var(--space-2-5)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
              Referral code: <strong style={{ color: 'var(--text-secondary)' }}>{summary?.affiliate_code || '—'}</strong>
            </p>
          </Card>

          <div style={{ display: 'grid', gap: 'var(--space-4)', marginBottom: 'var(--space-5)', maxWidth: '700px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <StatCell label="Lifetime Commission" value={formatCurrency(summary?.lifetime_commission || 0)} tone="gain" />
            <StatCell label="Available Balance" value={formatCurrency(summary?.available_balance || 0)} />
            <StatCell label="Total Referrals" value={summary?.total_referrals || 0} />
            <StatCell label="Paying Referrals" value={payingReferrals} />
          </div>

          <Card title="Commission Tier" style={{ maxWidth: '700px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-2)' }}>
              <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-secondary)' }}>
                {currentTier ? `${currentTier.label || 'Tier ' + currentTier.tier_rank} — ${currentTier.commission_pct}%` : '—'}
              </span>
              {nextTier && (
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
                  {nextTier.min_referrals - payingReferrals} more paying referral{nextTier.min_referrals - payingReferrals === 1 ? '' : 's'} to reach {nextTier.label || `Tier ${nextTier.tier_rank}`} ({nextTier.commission_pct}%)
                </span>
              )}
            </div>
            {nextTier && (
              <ProgressBar
                value={progressPct}
                label={`Progress to ${nextTier.label || `Tier ${nextTier.tier_rank}`}`}
              />
            )}
            {!nextTier && currentTier && (
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--green)', margin: 0 }}>You've reached the highest tier.</p>
            )}

            {allTiers.length > 0 && (
              <div style={{ marginTop: 'var(--space-4-5)', paddingTop: 'var(--space-3-5)', borderTop: '1px solid var(--rule-soft, var(--navy-border))' }}>
                <div style={{ fontSize: 'var(--fs-xs)', letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 'var(--space-2-5)' }}>Full Tier Ladder</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1-5)' }}>
                  {allTiers.map((t) => {
                    const isCurrent = currentTier && t.tier_rank === currentTier.tier_rank
                    return (
                      <div
                        key={t.tier_rank}
                        style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: 'var(--space-2) var(--space-3)', borderRadius: '4px',
                          background: isCurrent ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
                          border: isCurrent ? '1px solid var(--accent)' : '1px solid transparent',
                        }}
                      >
                        <span style={{ fontSize: 'var(--fs-base)', fontWeight: isCurrent ? 700 : 400, color: isCurrent ? 'var(--accent)' : 'var(--text-secondary)' }}>
                          {t.label || `Tier ${t.tier_rank}`}{isCurrent ? ' (current)' : ''}
                        </span>
                        <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {t.min_referrals}+ referrals · {t.commission_pct}%
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </Card>
        </>
      )}

      {activeTab === 'analysis' && <AffiliateAnalysisTab summary={summary} />}

      {activeTab === 'season' && <ReferralSeasonTab />}

      {activeTab === 'referrals' && (
        <Card title="Your Referrals" style={{ maxWidth: '900px' }} actions={referrals.rows.length > 0 && (
          <button
            onClick={() => exportRowsToCSV(referrals.rows, REFERRAL_EXPORT_COLUMNS, `referrals_${new Date().toISOString().slice(0, 10)}.csv`)}
            className="lx-btn"
            style={{ padding: 'var(--space-1-5) var(--space-2-5)', border: '1px solid var(--rule, var(--navy-border))', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2, var(--navy-hover))', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}
          >
            {renderIcon('download', { size: 12 })} Export
          </button>
        )}>
          <Table
            mobileCard
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
        <Card title="Commission Ledger" style={{ maxWidth: '900px' }} actions={commissions.rows.length > 0 && (
          <button
            onClick={() => exportRowsToCSV(commissions.rows, COMMISSION_EXPORT_COLUMNS, `commissions_${new Date().toISOString().slice(0, 10)}.csv`)}
            className="lx-btn"
            style={{ padding: 'var(--space-1-5) var(--space-2-5)', border: '1px solid var(--rule, var(--navy-border))', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2, var(--navy-hover))', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}
          >
            {renderIcon('download', { size: 12 })} Export
          </button>
        )}>
          <Table
            mobileCard
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
          <Card title="Request Payout" style={{ marginBottom: 'var(--space-5)', maxWidth: '700px' }}>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-4)' }}>
              Available balance: {formatCurrency(summary?.available_balance || 0)}. Enter the amount you'd like to withdraw.
            </p>
            {payoutMessage && (
              <div style={{
                padding: 'var(--space-2-5) var(--space-3-5)', borderRadius: '6px', marginBottom: 'var(--space-4)', fontSize: 'var(--fs-base)',
                background: payoutMessage.type === 'success' ? 'color-mix(in srgb, var(--green) 12%, transparent)' : 'color-mix(in srgb, var(--red) 12%, transparent)',
                color: payoutMessage.type === 'success' ? 'var(--green)' : 'var(--red)'
              }}>
                {payoutMessage.text}
              </div>
            )}
            <form onSubmit={requestPayout}>
              <div className="input-group">
                <label className="input-label">Amount (USD)</label>
                <input
                  className="input-field"
                  type="number"
                  value={payoutForm.amount_requested}
                  onChange={e => setPayoutForm({ ...payoutForm, amount_requested: e.target.value })}
                  placeholder={`Max ${formatCurrency(summary?.available_balance || 0)}`}
                  min="0.01"
                  max={summary?.available_balance || 0}
                  step="0.01"
                  required
                />
                <div style={{ display: 'flex', gap: 'var(--space-1-5)', marginTop: 'var(--space-2)' }}>
                  {[0.25, 0.5, 1].map(pct => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-secondary"
                      style={{ flex: 1, padding: 'var(--space-1-5)', fontSize: 'var(--fs-xs)' }}
                      onClick={() => setPayoutForm({ ...payoutForm, amount_requested: String(Math.floor((summary?.available_balance || 0) * pct * 100) / 100) })}
                    >
                      {pct === 1 ? 'Max' : `${pct * 100}%`}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid-2 payout-form-grid">
                <div>
                  <div className="input-group">
                    <label className="input-label">Cryptocurrency</label>
                    <select
                      className="select-field"
                      value={payoutCurrency}
                      onChange={e => {
                        const currency = e.target.value
                        setPayoutForm({ ...payoutForm, payment_method: currency === 'usdt' ? `usdt_${payoutNetwork}` : currency })
                      }}
                    >
                      {CRYPTO_CURRENCIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                  </div>
                  {payoutCurrency === 'usdt' && (
                    <div className="input-group">
                      <label className="input-label">Network</label>
                      <select
                        className="select-field"
                        value={payoutNetwork}
                        onChange={e => setPayoutForm({ ...payoutForm, payment_method: `usdt_${e.target.value}` })}
                      >
                        {USDT_NETWORKS.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <div className="input-group">
                  <label className="input-label">Payment Details</label>
                  <textarea
                    className="textarea-field"
                    value={payoutForm.payment_details}
                    onChange={e => setPayoutForm({ ...payoutForm, payment_details: e.target.value })}
                    placeholder="Enter your wallet address"
                    rows="4"
                    required
                    style={{ resize: 'vertical' }}
                  />
                  <p style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--warn, var(--text-muted))' }}>
                    Double-check before submitting — crypto payouts are final. Funds sent to an incorrect address or wrong network cannot be recovered.
                  </p>
                </div>
              </div>
              <button
                className="btn btn-accent"
                type="submit"
                style={{ marginTop: 'var(--space-4)', padding: 'var(--space-3) var(--space-7)' }}
                disabled={submitting || !(summary?.available_balance > 0) || !(parseFloat(payoutForm.amount_requested) > 0) || parseFloat(payoutForm.amount_requested) > (summary?.available_balance || 0)}
              >
                {submitting ? 'Submitting...' : 'Submit Payout Request'}
              </button>
            </form>
          </Card>

          <Card title="Payout History" style={{ maxWidth: '900px' }} actions={payouts.rows.length > 0 && (
            <button
              onClick={() => exportRowsToCSV(payouts.rows, PAYOUT_EXPORT_COLUMNS, `affiliate_payouts_${new Date().toISOString().slice(0, 10)}.csv`)}
              className="lx-btn"
              style={{ padding: 'var(--space-1-5) var(--space-2-5)', border: '1px solid var(--rule, var(--navy-border))', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2, var(--navy-hover))', display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}
            >
              {renderIcon('download', { size: 12 })} Export
            </button>
          )}>
            <Table
              mobileCard
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
