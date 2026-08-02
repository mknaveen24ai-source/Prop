import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import AdminStatCard from '../../components/admin/AdminStatCard'

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function RejectButton({ onReject }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) {
    return <button className="admin-btn admin-btn-sm" onClick={() => setOpen(true)}>Reject</button>
  }
  return (
    <div style={{ display: 'flex', gap: '6px' }}>
      <input
        style={{ width: '160px', padding: '6px 8px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }}
        placeholder="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button className="admin-btn admin-btn-sm" onClick={() => { onReject(reason); setOpen(false); setReason('') }}>Confirm</button>
      <button className="admin-btn admin-btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}

export default function AdminAffiliatePayouts() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('pending')
  const [data, setData] = useState({ rows: [], total: 0, page: 1, pageSize: 25 })

  const fetchPayouts = useCallback(async (page = 1, statusValue = status) => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/affiliates/payouts', {
        params: { status: statusValue === 'all' ? undefined : statusValue, page, pageSize: 25 }
      })
      setData(res.data)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load affiliate payout requests')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  useEffect(() => { fetchPayouts(1, status) }, [status, fetchPayouts])

  async function approve(row) {
    if (!window.confirm(`Mark payout of ${formatMoney(row.amount_requested)} for ${row.full_name} as paid?`)) return
    try {
      const transactionId = window.prompt('Transaction ID / reference (optional)', '') || null
      const res = await adminAxios.post('/api/admin/affiliates/payouts/approve', { payout_id: row.id, transaction_id: transactionId })
      toast.success(`Payout marked as paid (settled ${formatMoney(res.data.settled_amount)})`)
      fetchPayouts(data.page, status)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to approve payout')
    }
  }

  async function reject(row, reason) {
    try {
      await adminAxios.post('/api/admin/affiliates/payouts/reject', { payout_id: row.id, reason })
      toast.success('Payout rejected')
      fetchPayouts(data.page, status)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to reject payout')
    }
  }

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
  const pendingCount = data.rows.filter(r => r.status === 'pending').length

  return (
    <div style={{ padding: '24px' }}>
      <h1 className="admin-h1">Affiliate Payouts</h1>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px', marginBottom: '24px' }}>
        Approving settles the affiliate's entire current available balance (not just the requested amount, if it has since grown).
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <AdminStatCard icon="history" label="On This Page" value={data.rows.length} />
        <AdminStatCard icon="wallet" label="Pending On Page" value={pendingCount} />
      </div>

      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
        {['pending', 'paid', 'rejected', 'all'].map((s) => (
          <button
            key={s}
            className={`admin-filter-chip ${status === s ? 'active' : ''}`}
            onClick={() => setStatus(s)}
          >
            {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-th">Affiliate</th>
              <th className="admin-th">Amount</th>
              <th className="admin-th">Method</th>
              <th className="admin-th">Details</th>
              <th className="admin-th">Requested</th>
              <th className="admin-th">Status</th>
              <th className="admin-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="admin-td" colSpan={7}>Loading...</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td className="admin-td" colSpan={7}>No payout requests.</td></tr>
            ) : data.rows.map((row) => (
              <tr key={row.id}>
                <td className="admin-td">
                  <div>{row.full_name}</div>
                  <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
                </td>
                <td className="admin-td">{formatMoney(row.amount_requested)}</td>
                <td className="admin-td">{row.payment_method}</td>
                <td className="admin-td" style={{ maxWidth: '220px', whiteSpace: 'normal' }}>{row.payment_details}</td>
                <td className="admin-td">{new Date(row.requested_at).toLocaleDateString()}</td>
                <td className="admin-td">{row.status}{row.admin_notes ? ` — ${row.admin_notes}` : ''}</td>
                <td className="admin-td">
                  {row.status === 'pending' ? (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button className="admin-btn admin-btn-sm" onClick={() => approve(row)}>Approve</button>
                      <RejectButton onReject={(reason) => reject(row, reason)} />
                    </div>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'center' }}>
          <button className="admin-btn admin-btn-sm" disabled={data.page <= 1} onClick={() => fetchPayouts(data.page - 1, status)}>Previous</button>
          <span style={{ padding: '6px 12px', fontSize: '13px', color: 'var(--admin-text-muted)' }}>Page {data.page} of {totalPages}</span>
          <button className="admin-btn admin-btn-sm" disabled={data.page >= totalPages} onClick={() => fetchPayouts(data.page + 1, status)}>Next</button>
        </div>
      )}
    </div>
  )
}
