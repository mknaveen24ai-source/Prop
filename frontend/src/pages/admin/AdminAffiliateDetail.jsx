import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useParams, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import AdminStatCard from '../../components/admin/AdminStatCard'
import Card from '../../components/ui/Card'

const inputStyle = { width: '100%', padding: 'var(--space-2) var(--space-2-5)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function AdjustBalanceForm({ onSubmit }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const valid = amount !== '' && !Number.isNaN(parseFloat(amount)) && parseFloat(amount) !== 0 && reason.trim().length >= 5

  if (!open) {
    return <button className="admin-btn admin-btn-sm" onClick={() => setOpen(true)}>Adjust Balance</button>
  }
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
      <input style={{ ...inputStyle, width: '120px' }} type="number" step="0.01" placeholder="Amount (+/-)" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <input style={{ ...inputStyle, width: '240px' }} placeholder="Reason (5+ chars)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        className="admin-btn admin-btn-sm"
        disabled={!valid}
        onClick={() => { onSubmit(parseFloat(amount), reason.trim()); setOpen(false); setAmount(''); setReason('') }}
      >
        Confirm
      </button>
      <button className="admin-btn admin-btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}

export default function AdminAffiliateDetail() {
  const { adminAxios } = useOutletContext()
  const { userId } = useParams()
  const navigate = useNavigate()
  const toast = useToast()

  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get(`/api/admin/affiliates/${userId}`)
      setDetail(res.data)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not load affiliate detail')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios, userId])

  useEffect(() => { load() }, [load])

  async function handleAdjustBalance(amount, reason) {
    try {
      await adminAxios.post(`/api/admin/affiliates/${userId}/adjust-balance`, { amount, reason })
      toast.success('Balance adjusted')
      load()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not adjust balance')
    }
  }

  if (loading) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Loading...</div>
  if (!detail) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Affiliate not found</div>

  const { user, summary, referrals, commissions, payouts } = detail

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <button className="admin-btn admin-btn-sm" style={{ marginBottom: 'var(--space-4)' }} onClick={() => navigate('/admin/affiliates')}>
        ← Back to Affiliates
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-5)' }}>
        <div>
          <h2 style={{ margin: '0 0 var(--space-1)' }}>{user.full_name}</h2>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7 }}>{user.email} · Code {user.affiliate_code} · Joined {new Date(user.created_at).toLocaleDateString()}</div>
        </div>
        <AdjustBalanceForm onSubmit={handleAdjustBalance} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <AdminStatCard icon="users" label="Total Referrals" value={summary.total_referrals} />
        <AdminStatCard icon="approve" label="Paying Referrals" value={summary.paying_referrals} />
        <AdminStatCard icon="pnl" label="Lifetime Commission" value={formatMoney(summary.lifetime_commission)} />
        <AdminStatCard icon="wallet" label="Available Balance" value={formatMoney(summary.available_balance)} />
        <AdminStatCard icon="approve" label="Paid Out" value={formatMoney(summary.paid_total)} />
      </div>

      <Card style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-5)' }}>
        <h3 style={{ margin: '0 0 var(--space-3-5)' }}>Referrals ({referrals.total})</h3>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-th">Name</th>
                <th className="admin-th">Country</th>
                <th className="admin-th">Joined</th>
                <th className="admin-th">Commission Generated</th>
              </tr>
            </thead>
            <tbody>
              {referrals.rows.length === 0 ? (
                <tr><td className="admin-td" colSpan={4}>No referrals yet.</td></tr>
              ) : referrals.rows.map((r) => (
                <tr key={r.id}>
                  <td className="admin-td">{r.full_name}</td>
                  <td className="admin-td">{r.country || '—'}</td>
                  <td className="admin-td">{new Date(r.referred_at).toLocaleDateString()}</td>
                  <td className="admin-td">{formatMoney(r.total_commission_generated)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-5)' }}>
        <h3 style={{ margin: '0 0 var(--space-3-5)' }}>Commission Ledger ({commissions.total})</h3>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-th">From</th>
                <th className="admin-th">Order Amount</th>
                <th className="admin-th">Rate</th>
                <th className="admin-th">Commission</th>
                <th className="admin-th">Status</th>
                <th className="admin-th">Earned</th>
              </tr>
            </thead>
            <tbody>
              {commissions.rows.length === 0 ? (
                <tr><td className="admin-td" colSpan={6}>No commissions yet.</td></tr>
              ) : commissions.rows.map((c) => (
                <tr key={c.id}>
                  <td className="admin-td">{c.referred_full_name || (c.order_id ? '—' : 'Manual adjustment')}</td>
                  <td className="admin-td">{c.order_amount != null ? formatMoney(c.order_amount) : '—'}</td>
                  <td className="admin-td">{c.commission_rate_pct != null ? `${c.commission_rate_pct}%` : '—'}</td>
                  <td className="admin-td">{formatMoney(c.commission_amount)}</td>
                  <td className="admin-td">{c.status}{c.adjustment_note ? ` — ${c.adjustment_note}` : ''}</td>
                  <td className="admin-td">{new Date(c.earned_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card style={{ padding: 'var(--space-5)' }}>
        <h3 style={{ margin: '0 0 var(--space-3-5)' }}>Payout History ({payouts.total})</h3>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-th">Amount</th>
                <th className="admin-th">Method</th>
                <th className="admin-th">Status</th>
                <th className="admin-th">Requested</th>
                <th className="admin-th">Paid</th>
              </tr>
            </thead>
            <tbody>
              {payouts.rows.length === 0 ? (
                <tr><td className="admin-td" colSpan={5}>No payout requests yet.</td></tr>
              ) : payouts.rows.map((p) => (
                <tr key={p.id}>
                  <td className="admin-td">{formatMoney(p.amount_requested)}</td>
                  <td className="admin-td">{p.payment_method}</td>
                  <td className="admin-td">{p.status}</td>
                  <td className="admin-td">{new Date(p.requested_at).toLocaleDateString()}</td>
                  <td className="admin-td">{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
