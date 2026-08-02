import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import AdminStatCard from '../../components/admin/AdminStatCard'

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * AdminAffiliates — list of users who have at least one referral. Lighter
 * than AdminPayouts.jsx (no saved-views/export machinery) since the backend
 * envelope here is a plain {rows, total, page, pageSize}, not the full
 * admin-list-contract shape normalizeAdminListResponse expects.
 */
export default function AdminAffiliates() {
  const { adminAxios } = useOutletContext()
  const navigate = useNavigate()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [data, setData] = useState({ rows: [], total: 0, page: 1, pageSize: 25 })

  const fetchAffiliates = useCallback(async (page = 1, searchValue = search) => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/affiliates', { params: { search: searchValue, page, pageSize: 25 } })
      setData(res.data)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load affiliates')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  useEffect(() => { fetchAffiliates(1, '') }, [fetchAffiliates])

  useEffect(() => {
    const timeout = setTimeout(() => fetchAffiliates(1, search), 250)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const totalCommission = data.rows.reduce((sum, r) => sum + parseFloat(r.lifetime_commission || 0), 0)
  const totalBalance = data.rows.reduce((sum, r) => sum + parseFloat(r.available_balance || 0), 0)
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))

  return (
    <div style={{ padding: '24px' }}>
      <h1 className="admin-h1">Affiliates</h1>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px', marginBottom: '24px' }}>
        Traders who have referred at least one signup. Commission is a lifetime revenue share, not a one-time bonus.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="users" label="Active Affiliates" value={data.total || 0} />
        <AdminStatCard icon="pnl" label="Lifetime Commission (page)" value={formatMoney(totalCommission)} />
        <AdminStatCard icon="wallet" label="Available Balance (page)" value={formatMoney(totalBalance)} />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <input
          className="admin-input"
          style={{ maxWidth: '360px' }}
          placeholder="Search by name, email, or affiliate code..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-th">Trader</th>
              <th className="admin-th">Code</th>
              <th className="admin-th">Total Referrals</th>
              <th className="admin-th">Paying Referrals</th>
              <th className="admin-th">Lifetime Commission</th>
              <th className="admin-th">Available Balance</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="admin-td" colSpan={6}>Loading...</td></tr>
            ) : data.rows.length === 0 ? (
              <tr><td className="admin-td" colSpan={6}>No affiliates found.</td></tr>
            ) : (
              data.rows.map((row) => (
                <tr key={row.user_id} onClick={() => navigate(`/admin/affiliates/${row.user_id}`)} style={{ cursor: 'pointer' }}>
                  <td className="admin-td">
                    <div>{row.full_name || 'Unknown'}</div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{row.email}</div>
                  </td>
                  <td className="admin-td admin-td-mono">{row.affiliate_code}</td>
                  <td className="admin-td">{row.total_referrals}</td>
                  <td className="admin-td">{row.paying_referrals}</td>
                  <td className="admin-td">{formatMoney(row.lifetime_commission)}</td>
                  <td className="admin-td">{formatMoney(row.available_balance)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '16px', justifyContent: 'center' }}>
          <button className="admin-btn admin-btn-sm" disabled={data.page <= 1} onClick={() => fetchAffiliates(data.page - 1)}>Previous</button>
          <span style={{ padding: '6px 12px', fontSize: '13px', color: 'var(--admin-text-muted)' }}>Page {data.page} of {totalPages}</span>
          <button className="admin-btn admin-btn-sm" disabled={data.page >= totalPages} onClick={() => fetchAffiliates(data.page + 1)}>Next</button>
        </div>
      )}
    </div>
  )
}
