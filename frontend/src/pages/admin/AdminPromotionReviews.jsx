import React, { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AdminBadge from '../../components/admin/AdminBadge'
import AdminDataTable from '../../components/admin/AdminDataTable'
import AdminStatCard from '../../components/admin/AdminStatCard'
import { useToast } from '../../components/admin/AdminToast'

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

export default function AdminPromotionReviews() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [month, setMonth] = useState(currentMonth())
  const [status, setStatus] = useState('pending')
  const [quota, setQuota] = useState(null)
  const [reviews, setReviews] = useState([])

  const params = useMemo(() => ({ month: `${month}-01` }), [month])

  async function fetchData({ silent = false } = {}) {
    if (!silent) setLoading(true)
    try {
      const [quotaRes, reviewsRes] = await Promise.all([
        adminAxios.get('/api/admin/account-batches', { params: { ...params, all_sizes: true } }),
        adminAxios.get('/api/admin/promotion-reviews', { params: { ...params, status } })
      ])
      const nextQuota = quotaRes.data || null
      setQuota(nextQuota)
      setReviews(Array.isArray(reviewsRes.data?.rows) ? reviewsRes.data.rows : [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Failed to load promotion reviews')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, status])

  async function reviewAction(row, action) {
    const note = action === 'reject'
      ? window.prompt('Rejection reason')
      : window.prompt('Approval note (optional)', '')
    if (action === 'reject' && (!note || note.trim().length < 5)) {
      toast.error('A clear rejection reason is required')
      return
    }

    setSaving(true)
    try {
      const res = await adminAxios.post(`/api/admin/promotion-reviews/${row.id}/${action}`, { note })
      toast.success(res.data?.message || `Promotion ${action}ed`)
      await fetchData({ silent: true })
    } catch (error) {
      toast.error(error?.response?.data?.error || `Could not ${action} promotion`)
    } finally {
      setSaving(false)
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
            Passed Phase 1 and Phase 2 accounts wait here until quota is available and an admin approves the next account.
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
        <AdminStatCard icon="activity" label="Used This Month" value={String((quota?.sizes || []).reduce((sum, row) => sum + (Number(row.used) || 0), 0))} />
        <AdminStatCard icon="approve" label="Available Sizes" value={String((quota?.sizes || []).filter((row) => row.is_unlimited || Number(row.remaining) > 0).length)} />
        <AdminStatCard icon="warning" label="Pending Reviews" value={String(reviews.filter((row) => row.status === 'pending').length)} />
      </div>

      <div className="admin-card" style={{ marginBottom: 24 }}>
        <h2 className="admin-h2">Per-Size Quota Gate</h2>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 13, marginTop: 6 }}>
          Promotion approval checks the target account size against its monthly quota. Edit limits from Settings to Per-Size Monthly Allocation.
        </p>
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
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
      </div>
    </>
  )
}
