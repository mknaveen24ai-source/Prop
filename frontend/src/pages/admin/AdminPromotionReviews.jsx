import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AdminBadge from '../../components/admin/AdminBadge'
import AdminDataTable from '../../components/admin/AdminDataTable'
import AdminStatCard from '../../components/admin/AdminStatCard'
import { useToast } from '../../components/admin/AdminToast'
import Card from '../../components/ui/Card'

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

function formatMoney(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `$${parsed.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 'N/A'
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : 'N/A'
}

// Include the HTTP status when the server did not send a usable message. A bare
// "Failed to load" reads the same whether the endpoint is missing, forbidden or
// erroring — which is exactly how a 404 went undiagnosed here.
function describeError(error, fallback) {
  const serverMessage = error?.response?.data?.error
  if (typeof serverMessage === 'string' && serverMessage) return serverMessage
  const status = error?.response?.status
  return status ? `${fallback} (HTTP ${status})` : `${fallback} — ${error?.message || 'network error'}`
}

export default function AdminPromotionReviews() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  // Approving CREATES a real funded account, so a double submit creates two.
  // A ref rather than state: two clicks in the same tick would both read a
  // stale `false` off state, which is precisely the case being guarded.
  const savingRef = useRef(false)
  const [month, setMonth] = useState(currentMonth())
  const [status, setStatus] = useState('pending')
  const [quota, setQuota] = useState(null)
  const [reviews, setReviews] = useState([])

  const params = useMemo(() => ({ month: `${month}-01` }), [month])

  async function fetchData({ silent = false } = {}) {
    if (!silent) setLoading(true)
    // Settled rather than all: these are two independent reads, and a failing
    // quota lookup should not blank the review queue. Both used to share one
    // catch, so either failing produced the same opaque "Failed to load
    // promotion reviews" — which is what a 404 from the deleted endpoints
    // looked like for months.
    const [quotaRes, reviewsRes] = await Promise.allSettled([
      adminAxios.get('/api/admin/account-batches', { params: { ...params, all_sizes: true } }),
      adminAxios.get('/api/admin/promotion-reviews', { params: { ...params, status } })
    ])

    if (quotaRes.status === 'fulfilled') {
      setQuota(quotaRes.value.data || null)
    } else {
      toast.error(describeError(quotaRes.reason, 'Failed to load account size availability'))
    }

    if (reviewsRes.status === 'fulfilled') {
      setReviews(Array.isArray(reviewsRes.value.data?.rows) ? reviewsRes.value.data.rows : [])
    } else {
      toast.error(describeError(reviewsRes.reason, 'Failed to load promotion reviews'))
    }

    if (!silent) setLoading(false)
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, status])

  async function reviewAction(row, action) {
    if (savingRef.current) return
    const note = action === 'reject'
      ? window.prompt('Rejection reason')
      : window.prompt('Approval note (optional)', '')
    if (action === 'reject' && (!note || note.trim().length < 5)) {
      toast.error('A clear rejection reason is required')
      return
    }

    savingRef.current = true
    try {
      const res = await adminAxios.post(`/api/admin/promotion-reviews/${row.id}/${action}`, { note })
      toast.success(res.data?.message || `Promotion ${action}ed`)
      await fetchData({ silent: true })
    } catch (error) {
      toast.error(error?.response?.data?.error || `Could not ${action} promotion`)
    } finally {
      savingRef.current = false
    }
  }

  const columns = [
    {
      header: 'Review',
      key: 'id',
      isMono: true,
      render: (row) => (
        <div>
          <div>#{row.id}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 11 }}>{formatDate(row.created_at)}</div>
        </div>
      )
    },
    {
      header: 'Trader',
      key: 'trader',
      render: (row) => (
        <div>
          <div>{row.user_full_name || 'Unnamed Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 11 }}>{row.user_email || row.user_id}</div>
        </div>
      )
    },
    { header: 'Source Account', key: 'source_account_id', isMono: true },
    {
      header: 'Promotion',
      key: 'target_account_type',
      render: (row) => `${String(row.from_account_type || '').toUpperCase()} -> ${String(row.target_account_type || '').toUpperCase()}`
    },
    { header: 'Size', key: 'account_size', isMono: true, render: (row) => formatMoney(row.account_size) },
    { header: 'Balance', key: 'current_balance', isMono: true, render: (row) => formatMoney(row.current_balance) },
    { header: 'Status', key: 'status', render: (row) => <AdminBadge status={row.status === 'pending' ? 'warning' : row.status === 'approved' ? 'success' : 'danger'} label={String(row.status || '').toUpperCase()} /> },
    { header: 'Open/Pending', key: 'counts', isMono: true, render: (row) => `${row.open_trade_count || 0}/${row.pending_trade_count || 0}` }
  ]

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 24 }}>
        <div>
          <h1 className="admin-h1">Promotion Review</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 13 }}>
            Every passed challenge account waits here until an admin approves it. Approving creates the next account —
            Phase 2, Phase 3 or Funded, whichever the account&rsquo;s challenge model says comes next.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <input className="admin-input" style={{ width: 150 }} type="month" value={month} onChange={(event) => setMonth(event.target.value || currentMonth())} />
          <select className="admin-select" style={{ width: 150 }} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
          <button className="admin-btn admin-btn-ghost" onClick={() => fetchData()}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 20, marginBottom: 24 }}>
        <AdminStatCard icon="wallet" label="Full Sizes" value={String((quota?.sizes || []).filter((row) => row.state === 'full').length)} />
        {/* Relabelled from "Used This Month": the slot pool is lifetime, so
            every account ever created for a (model, size) counts. */}
        <AdminStatCard icon="activity" label="Slots Used" value={String((quota?.sizes || []).reduce((sum, row) => sum + (Number(row.used) || 0), 0))} />
        <AdminStatCard icon="approve" label="Available Sizes" value={String((quota?.sizes || []).filter((row) => row.is_unlimited || Number(row.remaining) > 0).length)} />
        <AdminStatCard icon="warning" label="Pending Reviews" value={String(reviews.filter((row) => row.status === 'pending').length)} />
      </div>

      <Card style={{ marginBottom: 24 }}>
        <h2 className="admin-h2">Account Size Availability</h2>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 13, marginTop: 6 }}>
          Slots are a lifetime pool per challenge model and size, not a monthly quota. These figures are
          advisory — a full pool does <strong>not</strong> block approval, because a trader who has already passed
          should never be stranded by it. Edit limits under Step Models.
        </p>
      </Card>

      <Card flush>
        <AdminDataTable
          loading={loading}
          data={reviews}
          columns={columns}
          emptyMessage="No promotion reviews in this view"
          rowActions={(row) => row.status === 'pending' ? [
            { label: 'Approve & Create Next Account', onClick: () => reviewAction(row, 'approve') },
            { label: 'Reject', onClick: () => reviewAction(row, 'reject') }
          ] : []}
        />
      </Card>
    </>
  )
}
