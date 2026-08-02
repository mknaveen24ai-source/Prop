import React, { useState, useEffect, useCallback } from 'react'
import { affiliateAPI, normalizeApiError } from '../services/api'
import { renderIcon } from '../utils/iconMap'
import Pagination from '../components/Pagination'
import { formatCurrency } from '../utils/finance'

const PAGE_SIZE = 10

function getStatusColor(status) {
  const c = {
    available: 'var(--green)', adjusted: 'var(--info)', paid: 'var(--green)',
    pending: 'var(--accent)', rejected: 'var(--red)',
  }
  return c[status] || 'var(--text-muted)'
}

/**
 * DashboardAffiliatePage — Affiliate tab. Self-contained (fetches its own
 * data via affiliateAPI) rather than prop-driven from Dashboard.jsx, mirroring
 * the DashboardCompetitionsPage precedent for tabs with their own paginated
 * server-backed lists.
 */
export default function DashboardAffiliatePage() {
  const [summary, setSummary] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [referrals, setReferrals] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })
  const [commissions, setCommissions] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })
  const [payouts, setPayouts] = useState({ rows: [], total: 0, page: 1, pageSize: PAGE_SIZE })

  const [payoutForm, setPayoutForm] = useState({ payment_method: 'bank', payment_details: '' })
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
      await affiliateAPI.requestPayout(payoutForm)
      setPayoutMessage({ type: 'success', text: 'Payout request submitted. Your entire available balance will be settled once approved.' })
      setPayoutForm({ payment_method: 'bank', payment_details: '' })
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
        <div className="card" style={{ padding: '24px', color: 'var(--red)' }}>{error}</div>
      </div>
    )
  }

  const currentTier = summary?.current_tier
  const nextTier = summary?.next_tier
  const payingReferrals = summary?.paying_referrals || 0
  const progressPct = nextTier
    ? Math.min(100, Math.round((payingReferrals / nextTier.min_referrals) * 100))
    : 100

  const totalReferralPages = Math.max(1, Math.ceil(referrals.total / referrals.pageSize))
  const totalCommissionPages = Math.max(1, Math.ceil(commissions.total / commissions.pageSize))
  const totalPayoutPages = Math.max(1, Math.ceil(payouts.total / payouts.pageSize))

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
        Affiliate Program
      </h2>

      {/* Referral code / link */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '700px' }}>
        <h3 style={{ marginBottom: '16px', color: 'var(--accent)' }}>Your Referral Link</h3>
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
      </div>

      {/* Summary stats */}
      <div className="grid-2" style={{ marginBottom: '20px', maxWidth: '700px', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--green)' }}>{formatCurrency(summary?.lifetime_commission || 0)}</div>
          <div className="stat-label">Lifetime Commission</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{formatCurrency(summary?.available_balance || 0)}</div>
          <div className="stat-label">Available Balance</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{summary?.total_referrals || 0}</div>
          <div className="stat-label">Total Referrals</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{payingReferrals}</div>
          <div className="stat-label">Paying Referrals</div>
        </div>
      </div>

      {/* Tier progress */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '700px' }}>
        <h3 style={{ marginBottom: '12px', color: 'var(--accent)' }}>Commission Tier</h3>
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
      </div>

      {/* Request payout */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '700px' }}>
        <h3 style={{ marginBottom: '20px', color: 'var(--accent)' }}>Request Payout</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
          Requesting a payout settles your entire available balance ({formatCurrency(summary?.available_balance || 0)}).
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
          <div className="grid-2 payout-form-grid">
            <div>
              <label>Payment Method</label>
              <select
                value={payoutForm.payment_method}
                onChange={e => setPayoutForm({ ...payoutForm, payment_method: e.target.value })}
              >
                <option value="crypto">Cryptocurrency (USDT/BTC)</option>
                <option value="bank">Bank Transfer</option>
                <option value="wise">Wise</option>
                <option value="paypal">PayPal</option>
              </select>
            </div>
            <div>
              <label>Payment Details</label>
              <textarea
                value={payoutForm.payment_details}
                onChange={e => setPayoutForm({ ...payoutForm, payment_details: e.target.value })}
                placeholder="Enter your payment details"
                rows="4"
                required
                style={{ resize: 'vertical' }}
              />
            </div>
          </div>
          <button
            className="btn btn-accent"
            type="submit"
            style={{ marginTop: '16px', padding: '12px 32px' }}
            disabled={submitting || !(summary?.available_balance > 0)}
          >
            {submitting ? 'Submitting...' : 'Submit Payout Request'}
          </button>
        </form>
      </div>

      {/* Referrals */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '900px' }}>
        <h3 style={{ color: 'var(--accent)', marginBottom: '16px' }}>Your Referrals</h3>
        {referrals.rows.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No referrals yet. Share your link to get started.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Country</th>
                  <th>Joined</th>
                  <th>Status</th>
                  <th>Commission Generated</th>
                </tr>
              </thead>
              <tbody>
                {referrals.rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.full_name}</td>
                    <td>{r.country || '—'}</td>
                    <td>{new Date(r.referred_at).toLocaleDateString()}</td>
                    <td style={{ color: r.is_paying ? 'var(--green)' : 'var(--text-muted)' }}>
                      {r.is_paying ? 'Paying' : 'Not yet purchased'}
                    </td>
                    <td>{formatCurrency(r.total_commission_generated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={referrals.page}
              totalPages={totalReferralPages}
              onPageChange={loadReferrals}
              pageSize={referrals.pageSize}
              total={referrals.total}
            />
          </>
        )}
      </div>

      {/* Commissions */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '900px' }}>
        <h3 style={{ color: 'var(--accent)', marginBottom: '16px' }}>Commission Ledger</h3>
        {commissions.rows.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '13px' }}>No commissions earned yet.</p>
        ) : (
          <>
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Order Amount</th>
                  <th>Rate</th>
                  <th>Commission</th>
                  <th>Status</th>
                  <th>Earned</th>
                </tr>
              </thead>
              <tbody>
                {commissions.rows.map(c => (
                  <tr key={c.id}>
                    <td>{c.referred_full_name || (c.order_id ? '—' : 'Manual adjustment')}</td>
                    <td>{c.order_amount != null ? formatCurrency(c.order_amount) : '—'}</td>
                    <td>{c.commission_rate_pct != null ? `${c.commission_rate_pct}%` : '—'}</td>
                    <td style={{ color: c.commission_amount < 0 ? 'var(--red)' : 'var(--green)' }}>
                      {formatCurrency(c.commission_amount)}
                    </td>
                    <td style={{ color: getStatusColor(c.status) }}>{c.status.toUpperCase()}</td>
                    <td>{new Date(c.earned_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination
              page={commissions.page}
              totalPages={totalCommissionPages}
              onPageChange={loadCommissions}
              pageSize={commissions.pageSize}
              total={commissions.total}
            />
          </>
        )}
      </div>

      {/* Payout history */}
      {payouts.rows.length > 0 && (
        <div className="card" style={{ maxWidth: '900px' }}>
          <h3 style={{ color: 'var(--accent)', marginBottom: '16px' }}>Payout History</h3>
          <table>
            <thead>
              <tr>
                <th>Amount</th>
                <th>Method</th>
                <th>Status</th>
                <th>Requested</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {payouts.rows.map(p => (
                <tr key={p.id}>
                  <td>{formatCurrency(p.amount_requested)}</td>
                  <td>{p.payment_method}</td>
                  <td style={{ color: getStatusColor(p.status) }}>{p.status.toUpperCase()}</td>
                  <td>{new Date(p.requested_at).toLocaleDateString()}</td>
                  <td>{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination
            page={payouts.page}
            totalPages={totalPayoutPages}
            onPageChange={loadPayouts}
            pageSize={payouts.pageSize}
            total={payouts.total}
          />
        </div>
      )}
    </div>
  )
}
