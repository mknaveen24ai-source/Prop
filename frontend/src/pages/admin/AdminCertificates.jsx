import React, { useCallback, useEffect, useState } from 'react'
import { useOutletContext, Link } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import AdminStatCard from '../../components/admin/AdminStatCard'
import AdminModal from '../../components/admin/AdminModal'
import { apiUrl } from '../../config/apiBase'

/**
 * AdminCertificates — the registry of every issued certificate.
 *
 * Certificates are minted automatically by the promotion and payout paths, so
 * this page is mostly a search-and-audit surface. The two write actions exist
 * for the cases automation cannot cover: awarding something bespoke, and
 * correcting or withdrawing an award that should not stand.
 *
 * Re-issue is the deliberate escape hatch for template versioning: a
 * certificate pins its template at issue time, so redesigning the artwork never
 * changes certificates already in circulation. Re-issuing mints a fresh one
 * against the current design and supersedes the original.
 */

const KIND_LABELS = {
  funded: 'Funded Trader',
  phase_passed: 'Challenge Passed',
  payout: 'Profit Payout',
  custom: 'Custom Award'
}

const PAGE_SIZE = 25

export default function AdminCertificates() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('')
  const [data, setData] = useState({ certificates: [], total: 0, page: 1, pageSize: PAGE_SIZE })

  const [awardOpen, setAwardOpen] = useState(false)
  const [awardForm, setAwardForm] = useState({ user_id: '', title: '', subtitle: '', amount: '' })
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revokeReason, setRevokeReason] = useState('')
  const [busy, setBusy] = useState(false)

  const fetchCertificates = useCallback(async (page = 1, params = {}) => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/certificates', {
        params: {
          search: params.search ?? '',
          kind: params.kind ?? '',
          status: params.status ?? '',
          page,
          pageSize: PAGE_SIZE
        }
      })
      setData(res.data)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load certificates')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  // 250ms debounce, matching AdminAffiliates — typing a trader name should not
  // fire a query per keystroke. This also covers the initial load, so there is
  // deliberately no separate mount-time fetch: having both meant every page
  // view issued two identical requests.
  useEffect(() => {
    const timeout = setTimeout(() => fetchCertificates(1, { search, kind, status }), 250)
    return () => clearTimeout(timeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, kind, status])

  async function submitAward(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await adminAxios.post('/api/admin/certificates', awardForm)
      toast.success('Certificate awarded')
      setAwardOpen(false)
      setAwardForm({ user_id: '', title: '', subtitle: '', amount: '' })
      fetchCertificates(1, { search, kind, status })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not award that certificate')
    } finally {
      setBusy(false)
    }
  }

  async function submitRevoke(e) {
    e.preventDefault()
    setBusy(true)
    try {
      await adminAxios.post(`/api/admin/certificates/${revokeTarget.id}/revoke`, { reason: revokeReason })
      toast.success('Certificate revoked')
      setRevokeTarget(null)
      setRevokeReason('')
      fetchCertificates(data.page, { search, kind, status })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not revoke that certificate')
    } finally {
      setBusy(false)
    }
  }

  async function reissue(certificate) {
    if (!window.confirm(`Re-issue ${certificate.public_id} against the current template? The original will be marked superseded.`)) return
    try {
      const res = await adminAxios.post(`/api/admin/certificates/${certificate.id}/reissue`)
      toast.success(`Re-issued as ${res.data.certificate.public_id}`)
      fetchCertificates(data.page, { search, kind, status })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not re-issue that certificate')
    }
  }

  const totalPages = Math.max(1, Math.ceil(data.total / (data.pageSize || PAGE_SIZE)))
  const revokedCount = data.certificates.filter((c) => c.status === 'revoked').length

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Certificates</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginBottom: '20px' }}>
            Issued automatically when a promotion is approved or a payout is paid. Search by trader name, email or certificate ID.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/admin/certificates/templates" className="admin-btn-secondary" style={{ textDecoration: 'none' }}>
            Design templates
          </Link>
          <button className="admin-btn-primary" onClick={() => setAwardOpen(true)}>Award custom</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="leaderboard" label="Total Issued" value={data.total || 0} />
        <AdminStatCard icon="warning" label="Revoked (page)" value={revokedCount} />
        <AdminStatCard icon="users" label="On This Page" value={data.certificates.length} />
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <input
          className="admin-input"
          style={{ maxWidth: 360, flex: '1 1 260px' }}
          placeholder="Search by trader name, email, or certificate ID..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="admin-input" style={{ maxWidth: 200 }} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <select className="admin-input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="revoked">Revoked</option>
        </select>
      </div>

      <div className="admin-table-wrapper">
        <table className="admin-table">
          <thead>
            <tr>
              <th className="admin-th">Certificate ID</th>
              <th className="admin-th">Trader</th>
              <th className="admin-th">Award</th>
              <th className="admin-th">Type</th>
              <th className="admin-th">Issued</th>
              <th className="admin-th">Status</th>
              <th className="admin-th">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td className="admin-td" colSpan={7} style={{ textAlign: 'center', padding: 32 }}>Loading…</td></tr>
            )}
            {!loading && data.certificates.length === 0 && (
              <tr><td className="admin-td" colSpan={7} style={{ textAlign: 'center', padding: 32, color: 'var(--admin-text-muted)' }}>
                No certificates match those filters.
              </td></tr>
            )}
            {!loading && data.certificates.map((certificate) => (
              <tr key={certificate.id}>
                <td className="admin-td admin-td-mono">{certificate.public_id}</td>
                <td className="admin-td">
                  <div>{certificate.user_full_name || certificate.recipient_name}</div>
                  <div style={{ fontSize: 11, color: 'var(--admin-text-muted)' }}>{certificate.user_email}</div>
                  {/* recipient_name is snapshotted at issue time, so it can
                      legitimately differ from the trader's current name. */}
                  {certificate.user_full_name && certificate.user_full_name !== certificate.recipient_name && (
                    <div style={{ fontSize: 11, color: 'var(--admin-text-muted)' }}>
                      on certificate: {certificate.recipient_name}
                    </div>
                  )}
                </td>
                <td className="admin-td">{certificate.title}</td>
                <td className="admin-td">{KIND_LABELS[certificate.kind] || certificate.kind}</td>
                <td className="admin-td admin-td-mono">
                  {new Date(certificate.issued_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
                <td className="admin-td">
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.08em', textTransform: 'uppercase',
                    color: certificate.status === 'revoked' ? 'var(--loss)' : 'var(--gain)'
                  }}>
                    {certificate.status}
                  </span>
                </td>
                <td className="admin-td">
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a
                      href={apiUrl(`/api/admin/certificates/${certificate.id}/render.pdf`)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--admin-accent)', fontSize: 12 }}
                    >
                      PDF
                    </a>
                    <button
                      onClick={() => reissue(certificate)}
                      style={{ background: 'none', border: 'none', color: 'var(--admin-accent)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                    >
                      Re-issue
                    </button>
                    {certificate.status !== 'revoked' && (
                      <button
                        onClick={() => setRevokeTarget(certificate)}
                        style={{ background: 'none', border: 'none', color: 'var(--loss)', cursor: 'pointer', fontSize: 12, padding: 0 }}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
          <button className="admin-btn-secondary" disabled={data.page <= 1}
            onClick={() => fetchCertificates(data.page - 1, { search, kind, status })}>Previous</button>
          <span style={{ color: 'var(--admin-text-muted)', fontSize: 12 }}>Page {data.page} of {totalPages}</span>
          <button className="admin-btn-secondary" disabled={data.page >= totalPages}
            onClick={() => fetchCertificates(data.page + 1, { search, kind, status })}>Next</button>
        </div>
      )}

      <AdminModal isOpen={awardOpen} onClose={() => setAwardOpen(false)} title="Award a custom certificate">
        <form onSubmit={submitAward}>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 13 }}>
            For awards automation does not cover — competition wins, milestones, goodwill. The trader is notified and emailed exactly as with an automatic award.
          </p>
          <label className="admin-label" htmlFor="cert-user-id">Trader user ID</label>
          <input id="cert-user-id" className="admin-input" required value={awardForm.user_id}
            onChange={(e) => setAwardForm({ ...awardForm, user_id: e.target.value })} placeholder="uuid" />

          <label className="admin-label" htmlFor="cert-title">Title</label>
          <input id="cert-title" className="admin-input" required value={awardForm.title}
            onChange={(e) => setAwardForm({ ...awardForm, title: e.target.value })} placeholder="Trader of the Month" />

          <label className="admin-label" htmlFor="cert-subtitle">Subtitle (optional)</label>
          <input id="cert-subtitle" className="admin-input" value={awardForm.subtitle}
            onChange={(e) => setAwardForm({ ...awardForm, subtitle: e.target.value })} />

          <label className="admin-label" htmlFor="cert-amount">Amount (optional)</label>
          <input id="cert-amount" className="admin-input" type="number" step="0.01" value={awardForm.amount}
            onChange={(e) => setAwardForm({ ...awardForm, amount: e.target.value })} />

          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button type="submit" className="admin-btn-primary" disabled={busy}>{busy ? 'Awarding…' : 'Award certificate'}</button>
            <button type="button" className="admin-btn-secondary" onClick={() => setAwardOpen(false)}>Cancel</button>
          </div>
        </form>
      </AdminModal>

      <AdminModal isOpen={Boolean(revokeTarget)} onClose={() => setRevokeTarget(null)} title="Revoke certificate">
        <form onSubmit={submitRevoke}>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 13 }}>
            {revokeTarget?.public_id} will show as revoked on its public verification page, and its render gains a REVOKED overprint.
            Anything already downloaded or shared stays out there — this is what makes the link tell the truth.
          </p>
          <label className="admin-label" htmlFor="revoke-reason">Reason (shown publicly)</label>
          <input id="revoke-reason" className="admin-input" required value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)} placeholder="Rule violation found on review" />
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button type="submit" className="admin-btn-danger" disabled={busy}>{busy ? 'Revoking…' : 'Revoke'}</button>
            <button type="button" className="admin-btn-secondary" onClick={() => setRevokeTarget(null)}>Cancel</button>
          </div>
        </form>
      </AdminModal>
    </div>
  )
}
