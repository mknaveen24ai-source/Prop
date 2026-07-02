import React, { useState } from 'react'
import { renderIcon } from '../utils/iconMap'
import Pagination from '../components/Pagination'
import { formatCurrency, calculatePayoutPreview } from '../utils/finance'

const PAYOUTS_PAGE_SIZE = 10

function getStatusColor(status) {
  const c = {
    pending: 'var(--accent)', approved: 'var(--green)', paid: 'var(--green)',
    rejected: 'var(--red)', processing: 'var(--info)',
  }
  return c[status] || 'var(--text-muted)'
}

/**
 * DashboardPayoutsPage — Payouts tab.
 *
 * Receives all payout state and callbacks from Dashboard.jsx via props.
 */
export default function DashboardPayoutsPage({
  user,
  fundedAccount,
  payouts,
  payoutForm,
  setPayoutForm,
  requestPayout,
  availableProfit,
  profitSharePct,
  API_URL,
}) {
  const [payoutsPage, setPayoutsPage] = useState(1)

  if (!fundedAccount) {
    return (
      <div>
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
          Payouts
        </h2>
        <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('payouts', { size: 48, color: 'var(--accent-gold)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Funded Account Yet</h3>
          <p style={{ color: 'var(--text-muted)' }}>Complete Phase 1 and Phase 2 to unlock payouts.</p>
        </div>
      </div>
    )
  }

  const totalPayoutPages = Math.ceil(payouts.length / PAYOUTS_PAGE_SIZE)
  const pagedPayouts = payouts.slice(
    (payoutsPage - 1) * PAYOUTS_PAGE_SIZE,
    payoutsPage * PAYOUTS_PAGE_SIZE
  )

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>
        Payouts
      </h2>

      {/* Summary stats */}
      <div className="grid-2" style={{ marginBottom: '20px', maxWidth: '600px' }}>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--green)' }}>{formatCurrency(availableProfit)}</div>
          <div className="stat-label">Available Profit</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: 'var(--accent)' }}>{profitSharePct}%</div>
          <div className="stat-label">Your Profit Share</div>
        </div>
      </div>

      {/* Request payout form */}
      <div className="card" style={{ marginBottom: '20px', maxWidth: '700px' }}>
        <h3 style={{ marginBottom: '20px', color: 'var(--accent)' }}>Request Payout</h3>
        <form onSubmit={requestPayout}>
          <div className="grid-2 payout-form-grid">
            <div>
              <label>Amount to Withdraw ($)</label>
              <input
                type="number"
                value={payoutForm.amount_requested}
                onChange={e => setPayoutForm({ ...payoutForm, amount_requested: e.target.value })}
                placeholder={`Max ${formatCurrency(availableProfit)}`}
                min="50"
                max={availableProfit}
                step="0.01"
                required
              />
              {payoutForm.amount_requested && (
                <p style={{ fontSize: '13px', color: 'var(--green-light)', marginTop: '6px' }}>
                  You will receive: {formatCurrency(calculatePayoutPreview(payoutForm.amount_requested || 0, profitSharePct))} ({profitSharePct}% share)
                </p>
              )}
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
                rows="5"
                required
                style={{ resize: 'vertical' }}
              />
            </div>
          </div>
          <button
            className="btn btn-accent"
            type="submit"
            style={{ marginTop: '16px', padding: '12px 32px' }}
            disabled={availableProfit < 50}
          >
            {availableProfit < 50 ? 'Minimum $50 required' : 'Submit Payout Request'}
          </button>
        </form>
      </div>

      {/* Payout history table */}
      {payouts.length > 0 && (
        <div className="card" style={{ maxWidth: '900px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ color: 'var(--accent)', margin: 0 }}>Payout History</h3>
            {payouts.some(p => p.status === 'paid') && (
              <button
                onClick={() => {
                  const link = document.createElement('a')
                  link.href = `${API_URL}/api/payouts/statement`
                  link.target = '_blank'
                  link.click()
                }}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(148,148,148,0.3)',
                  borderRadius: '6px', padding: '6px 14px',
                  fontSize: '12px', color: 'var(--accent)',
                  cursor: 'pointer', transition: 'all 0.15s'
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'rgba(148,148,148,0.08)'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                title="Download your payout statement as HTML (printable / save as PDF)"
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {renderIcon('download', { size: 14, color: 'currentColor' })}
                  <span>Download Statement</span>
                </span>
              </button>
            )}
          </div>

          <table>
            <thead>
              <tr>
                <th>Trader ID</th>
                <th>Account ID</th>
                <th>Amount</th>
                <th>You Receive</th>
                <th>Method</th>
                <th>Status</th>
                <th>Requested</th>
                <th>Paid</th>
              </tr>
            </thead>
            <tbody>
              {pagedPayouts.map(p => (
                <tr key={p.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                    {user?.trader_uid || user?.trader_id || '—'}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
                    {p.account_uid || p.account_id || '—'}
                  </td>
                  <td>${parseFloat(p.amount_requested).toFixed(2)}</td>
                  <td style={{ color: 'var(--green)' }}>${parseFloat(p.amount_payable).toFixed(2)}</td>
                  <td>{p.payment_method}</td>
                  <td style={{ color: getStatusColor(p.status) }}>{p.status.toUpperCase()}</td>
                  <td>{new Date(p.requested_at).toLocaleDateString()}</td>
                  {/* FIX (BUG-L2): was p.processed_at but backend column is paid_at */}
                  <td>{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <Pagination
            page={payoutsPage}
            totalPages={totalPayoutPages}
            onPageChange={p => setPayoutsPage(p)}
            pageSize={PAYOUTS_PAGE_SIZE}
            total={payouts.length}
          />
        </div>
      )}
    </div>
  )
}
