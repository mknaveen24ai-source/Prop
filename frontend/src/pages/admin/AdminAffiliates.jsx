import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts'
import { useToast } from '../../components/admin/AdminToast'
import AdminStatCard from '../../components/admin/AdminStatCard'
import AdminChart, { chartThemeProps, dimUnlessActive } from '../../components/admin/AdminChart'
import Card from '../../components/ui/Card'

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/**
 * Affiliate Analysis — not one of the 26 prototype screens; added alongside
 * pulling Affiliates into scope (explicit user request). Real aggregates
 * only from GET /api/admin/affiliates/analytics: top affiliates by lifetime
 * commission, a referred-vs-paying conversion funnel, commission paid by
 * month, and tier distribution.
 */
function AffiliateAnalysisTab({ adminAxios, toast }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [tierActiveIndex, setTierActiveIndex] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    adminAxios.get('/api/admin/affiliates/analytics')
      .then((res) => { if (!cancelled) setData(res.data) })
      .catch((err) => { if (!cancelled) toast.error(err?.response?.data?.error || 'Failed to load affiliate analytics') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  if (loading) return <div className="admin-skeleton" style={{ height: '300px' }} />
  if (!data) return <div style={{ color: 'var(--admin-text-muted)' }}>Could not load affiliate analytics.</div>

  const { topAffiliates, funnel, commissionByMonth, tierDistribution } = data

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
        <AdminStatCard icon="users" label="Total Referrals" value={funnel.totalReferrals} />
        <AdminStatCard icon="pnl" label="Paying Referrals" value={funnel.payingReferrals} />
        <AdminStatCard icon="activity" label="Conversion Rate" value={`${funnel.conversionPct}%`} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-6)', marginBottom: 'var(--space-6)' }}>
        <AdminChart title="Commission Paid by Month">
          {commissionByMonth.length > 0 ? (
            <BarChart data={commissionByMonth}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="month" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
              <Tooltip {...chartThemeProps.tooltip} formatter={(value) => [`$${Number(value).toLocaleString()}`, 'Paid']} />
              <Bar dataKey="paid" fill="var(--admin-success)" radius={[4, 4, 0, 0]} name="Commission Paid" />
            </BarChart>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '260px', color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
              No paid affiliate payouts in the last 6 months
            </div>
          )}
        </AdminChart>

        <AdminChart title="Tier Distribution">
          {tierDistribution.some((t) => t.count > 0) ? (
            <BarChart data={tierDistribution} onMouseMove={(state) => setTierActiveIndex(state?.isTooltipActive ? state.activeTooltipIndex : null)} onMouseLeave={() => setTierActiveIndex(null)}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="label" {...chartThemeProps.xAxis} />
              <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
              <Tooltip {...chartThemeProps.tooltip} />
              <Bar dataKey="count" fill="var(--admin-accent)" radius={[4, 4, 0, 0]} name="Affiliates">
                {tierDistribution.map((_, index) => (
                  <Cell key={index} fill="var(--admin-accent)" fillOpacity={dimUnlessActive(tierActiveIndex, index)} />
                ))}
              </Bar>
            </BarChart>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '260px', color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
              No affiliates have reached a commission tier yet
            </div>
          )}
        </AdminChart>
      </div>

      <Card ruled flush title="Top Affiliates" style={{ marginBottom: 'var(--space-6)' }}>
        <div className="admin-table-wrapper">
          <table className="admin-table">
            <thead>
              <tr>
                <th className="admin-th">Trader</th>
                <th className="admin-th">Code</th>
                <th className="admin-th">Total Referrals</th>
                <th className="admin-th">Paying Referrals</th>
                <th className="admin-th">Lifetime Commission</th>
              </tr>
            </thead>
            <tbody>
              {topAffiliates.length === 0 ? (
                <tr><td className="admin-td" colSpan={5}>No affiliates yet.</td></tr>
              ) : topAffiliates.map((row) => (
                <tr key={row.userId}>
                  <td className="admin-td">
                    <div>{row.fullName || 'Unknown'}</div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{row.email}</div>
                  </td>
                  <td className="admin-td admin-td-mono">{row.affiliateCode}</td>
                  <td className="admin-td">{row.totalReferrals}</td>
                  <td className="admin-td">{row.payingReferrals}</td>
                  <td className="admin-td">{formatMoney(row.lifetimeCommission)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  )
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
  const [activeTab, setActiveTab] = useState('directory')

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
    <div style={{ padding: 'var(--space-6)' }}>
      <h1 className="admin-h1">Affiliates</h1>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-5)' }}>
        Traders who have referred at least one signup. Commission is a lifetime revenue share, not a one-time bonus.
      </p>

      <div style={{ display: 'flex', gap: '2px', padding: '3px', border: '1px solid var(--admin-border)', borderRadius: '4px', background: 'var(--admin-elevated)', width: 'fit-content', marginBottom: 'var(--space-6)' }}>
        {[{ id: 'directory', label: 'Directory' }, { id: 'analysis', label: 'Analysis' }].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '7px 16px', border: 'none', borderRadius: '3px', cursor: 'pointer',
              background: activeTab === tab.id ? 'var(--admin-accent)' : 'transparent',
              color: activeTab === tab.id ? 'var(--paper)' : 'var(--admin-text-muted)',
              fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: '.08em', textTransform: 'uppercase'
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'analysis' ? (
        <AffiliateAnalysisTab adminAxios={adminAxios} toast={toast} />
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
            <AdminStatCard icon="users" label="Active Affiliates" value={data.total || 0} />
            <AdminStatCard icon="pnl" label="Lifetime Commission (page)" value={formatMoney(totalCommission)} />
            <AdminStatCard icon="wallet" label="Available Balance (page)" value={formatMoney(totalBalance)} />
          </div>

          <div style={{ marginBottom: 'var(--space-4)' }}>
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
                        <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{row.email}</div>
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
            <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-4)', justifyContent: 'center' }}>
              <button className="admin-btn admin-btn-sm" disabled={data.page <= 1} onClick={() => fetchAffiliates(data.page - 1)}>Previous</button>
              <span style={{ padding: 'var(--space-1-5) var(--space-3)', fontSize: 'var(--fs-base)', color: 'var(--admin-text-muted)' }}>Page {data.page} of {totalPages}</span>
              <button className="admin-btn admin-btn-sm" disabled={data.page >= totalPages} onClick={() => fetchAffiliates(data.page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
