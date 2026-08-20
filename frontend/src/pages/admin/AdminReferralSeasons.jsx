import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import PrizePoolEditor from '../../components/admin/PrizePoolEditor'
import AdminBadge from '../../components/admin/AdminBadge'
import AdminStatCard from '../../components/admin/AdminStatCard'
import AdminStatGrid from '../../components/admin/AdminStatGrid'
import AdminFilterBar from '../../components/admin/AdminFilterBar'
import AdminDataTable from '../../components/admin/AdminDataTable'
import Card from '../../components/ui/Card'

const PAGE_SIZE = 15
const STATUS_FILTERS = ['all', 'upcoming', 'active', 'completed', 'cancelled']

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function CreateSeasonForm({ onCreate, creating }) {
  const now = new Date()
  const defaultStart = new Date(now.getTime() + 60 * 60 * 1000)
  const defaultEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)

  const [form, setForm] = useState({
    title: '',
    description: '',
    start_at: toLocalInputValue(defaultStart),
    end_at: toLocalInputValue(defaultEnd),
  })
  const [prizes, setPrizes] = useState([])

  function update(key, value) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function submit(e) {
    e.preventDefault()
    onCreate({
      ...form,
      start_at: new Date(form.start_at).toISOString(),
      end_at: new Date(form.end_at).toISOString(),
      prize_pool: prizes
        .filter((p) => String(p.label || '').trim().length > 0)
        .map((p) => ({ rank: parseInt(p.rank, 10) || 1, label: String(p.label).trim(), ...(p.voucher ? { voucher: p.voucher } : {}) }))
    })
  }

  const inputStyle = { width: '100%', padding: 'var(--space-2) var(--space-2-5)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

  return (
    <form onSubmit={submit} className="lx-card" style={{ marginBottom: 'var(--space-6)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3-5)' }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <h3 style={{ margin: '0 0 4px' }}>Create Referral Season</h3>
      </div>
      <label style={{ gridColumn: '1 / -1' }}>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Title</div>
        <input style={inputStyle} value={form.title} onChange={(e) => update('title', e.target.value)} required />
      </label>
      <label style={{ gridColumn: '1 / -1' }}>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Description (shown to traders, optional)</div>
        <input style={inputStyle} value={form.description} onChange={(e) => update('description', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Start</div>
        <input type="datetime-local" style={inputStyle} value={form.start_at} onChange={(e) => update('start_at', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>End</div>
        <input type="datetime-local" style={inputStyle} value={form.end_at} onChange={(e) => update('end_at', e.target.value)} required />
      </label>
      <div style={{ gridColumn: '1 / -1' }}>
        <PrizePoolEditor prizes={prizes} onChange={setPrizes} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <button className="admin-btn" type="submit" disabled={creating}>
          {creating ? 'Creating...' : 'Create Season'}
        </button>
      </div>
    </form>
  )
}

export default function AdminReferralSeasons() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()
  const [seasons, setSeasons] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/referral-seasons')
      setSeasons(Array.isArray(res.data) ? res.data : [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load referral seasons')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, toast])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, statusFilter])

  async function handleCreate(payload) {
    setCreating(true)
    try {
      await adminAxios.post('/api/admin/referral-seasons', payload)
      toast.success('Referral season created')
      setShowForm(false)
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not create referral season')
    } finally {
      setCreating(false)
    }
  }

  async function handleCancel(id) {
    if (!window.confirm('Cancel this referral season? Standings will not be finalized and no prizes will be issued.')) return
    try {
      await adminAxios.post(`/api/admin/referral-seasons/${id}/cancel`)
      toast.success('Referral season cancelled')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not cancel referral season')
    }
  }

  const kpis = useMemo(() => ({
    total: seasons.length,
    active: seasons.filter((s) => s.status === 'active').length,
    upcoming: seasons.filter((s) => s.status === 'upcoming').length,
    entrants: seasons.reduce((sum, s) => sum + (s.entry_count || 0), 0),
  }), [seasons])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return seasons.filter((s) => {
      if (statusFilter !== 'all' && s.status !== statusFilter) return false
      if (q && !String(s.title || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [seasons, search, statusFilter])

  const pagination = { current: page, total: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), total_items: filtered.length, page_size: PAGE_SIZE }
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const columns = [
    { key: 'title', header: 'Title', render: (s) => <span style={{ fontWeight: 600 }}>{s.title}</span> },
    { key: 'status', header: 'Status', render: (s) => <AdminBadge status={s.status} /> },
    { key: 'start', header: 'Start', render: (s) => new Date(s.start_at).toLocaleString() },
    { key: 'end', header: 'End', render: (s) => new Date(s.end_at).toLocaleString() },
    { key: 'entrants', header: 'Ranked Entrants', isMono: true, render: (s) => s.entry_count || 0 },
    { key: 'prizes', header: 'Prizes', render: (s) => (Array.isArray(s.prize_pool_json) ? s.prize_pool_json.length : 0) },
    { key: 'actions', header: '', render: (s) => (
      ['upcoming', 'active'].includes(s.status) ? (
        <button className="admin-btn admin-btn-sm" onClick={(e) => { e.stopPropagation(); handleCancel(s.id) }}>Cancel</button>
      ) : null
    ) },
  ]

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-5)', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="admin-h1">Referral Seasons</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
            Time-boxed periods ranking affiliates by new paying referrals, separate from the lifetime
            commission-tier ladder. Winners are ranked automatically when a season ends and, if a rank has a
            voucher configured, receive a free challenge account.
          </p>
        </div>
        <button className="admin-btn admin-btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : '+ New Season'}
        </button>
      </div>

      {showForm && <CreateSeasonForm onCreate={handleCreate} creating={creating} />}

      <AdminStatGrid style={{ marginBottom: 'var(--space-5)' }}>
        <AdminStatCard icon="challenges" label="Total Seasons" value={kpis.total} />
        <AdminStatCard icon="activity" label="Active Now" value={kpis.active} />
        <AdminStatCard icon="calendar" label="Upcoming" value={kpis.upcoming} />
        <AdminStatCard icon="users" label="Ranked Entrants (completed)" value={kpis.entrants} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search seasons by title..." searchValue={search} onSearchChange={setSearch}>
        {STATUS_FILTERS.map((status) => (
          <button
            key={status}
            className={`admin-filter-chip ${statusFilter === status ? 'active' : ''}`}
            onClick={() => setStatusFilter(status)}
          >
            {status === 'all' ? 'All' : status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </AdminFilterBar>

      <Card flush>
        <AdminDataTable
          columns={columns}
          data={pageRows}
          loading={loading}
          emptyMessage="No referral seasons match the current filters"
          pagination={pagination}
          onPageChange={setPage}
        />
      </Card>
    </div>
  )
}
