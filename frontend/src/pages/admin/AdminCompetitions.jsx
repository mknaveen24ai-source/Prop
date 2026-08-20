import React, { useEffect, useState, useCallback, useMemo } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
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

function CreateCompetitionForm({ onCreate, creating }) {
  const now = new Date()
  const defaultStart = new Date(now.getTime() + 60 * 60 * 1000)
  const defaultEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const [form, setForm] = useState({
    title: '',
    type: 'weekly',
    start_at: toLocalInputValue(defaultStart),
    end_at: toLocalInputValue(defaultEnd),
    starting_balance: 10000,
    max_participants: '',
    ranking_metric: 'profit_pct',
    max_drawdown_pct: 10,
    daily_drawdown_pct: ''
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
        .map((p) => ({ rank: parseInt(p.rank, 10) || 1, label: String(p.label).trim() }))
    })
  }

  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

  return (
    <form onSubmit={submit} className="lx-card" style={{ marginBottom: 'var(--space-6)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <h3 style={{ margin: '0 0 4px' }}>Create Competition</h3>
      </div>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Title</div>
        <input style={inputStyle} value={form.title} onChange={(e) => update('title', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Type</div>
        <select style={inputStyle} value={form.type} onChange={(e) => update('type', e.target.value)}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Start</div>
        <input type="datetime-local" style={inputStyle} value={form.start_at} onChange={(e) => update('start_at', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>End</div>
        <input type="datetime-local" style={inputStyle} value={form.end_at} onChange={(e) => update('end_at', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Starting Balance ($)</div>
        <input type="number" style={inputStyle} value={form.starting_balance} onChange={(e) => update('starting_balance', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Max Participants (blank = unlimited)</div>
        <input type="number" style={inputStyle} value={form.max_participants} onChange={(e) => update('max_participants', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Ranking Metric</div>
        <select style={inputStyle} value={form.ranking_metric} onChange={(e) => update('ranking_metric', e.target.value)}>
          <option value="profit_pct">Profit %</option>
          <option value="profit_usd">Profit $</option>
        </select>
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Max Drawdown %</div>
        <input type="number" style={inputStyle} value={form.max_drawdown_pct} onChange={(e) => update('max_drawdown_pct', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Daily Drawdown % (optional)</div>
        <input type="number" style={inputStyle} value={form.daily_drawdown_pct} onChange={(e) => update('daily_drawdown_pct', e.target.value)} />
      </label>
      <div style={{ gridColumn: '1 / -1' }}>
        <PrizePoolEditor prizes={prizes} onChange={setPrizes} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <button className="admin-btn" type="submit" disabled={creating}>
          {creating ? 'Creating...' : 'Create Competition'}
        </button>
      </div>
    </form>
  )
}

export default function AdminCompetitions() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()
  const navigate = useNavigate()
  const [competitions, setCompetitions] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [page, setPage] = useState(1)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/competitions')
      setCompetitions(Array.isArray(res.data) ? res.data : [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load competitions')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, toast])

  useEffect(() => { load() }, [load])
  useEffect(() => { setPage(1) }, [search, statusFilter])

  async function handleCreate(payload) {
    setCreating(true)
    try {
      await adminAxios.post('/api/admin/competitions', payload)
      toast.success('Competition created')
      setShowForm(false)
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not create competition')
    } finally {
      setCreating(false)
    }
  }

  const kpis = useMemo(() => ({
    total: competitions.length,
    active: competitions.filter((c) => c.status === 'active').length,
    upcoming: competitions.filter((c) => c.status === 'upcoming').length,
    participants: competitions.reduce((sum, c) => sum + (c.participant_count || 0), 0),
  }), [competitions])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return competitions.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (q && !String(c.title || '').toLowerCase().includes(q)) return false
      return true
    })
  }, [competitions, search, statusFilter])

  const pagination = { current: page, total: Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)), total_items: filtered.length, page_size: PAGE_SIZE }
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const columns = [
    { key: 'title', header: 'Title', render: (c) => <span style={{ fontWeight: 600 }}>{c.title}</span> },
    { key: 'type', header: 'Type', render: (c) => c.type },
    { key: 'status', header: 'Status', render: (c) => <AdminBadge status={c.status} /> },
    { key: 'start', header: 'Start', render: (c) => new Date(c.start_at).toLocaleString() },
    { key: 'end', header: 'End', render: (c) => new Date(c.end_at).toLocaleString() },
    { key: 'participants', header: 'Participants', isMono: true, render: (c) => `${c.participant_count || 0}${c.max_participants ? ` / ${c.max_participants}` : ''}` },
    { key: 'prizes', header: 'Prizes', render: (c) => (Array.isArray(c.prize_pool) ? c.prize_pool.length : 0) },
  ]

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-5)', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
        <div>
          <h1 className="admin-h1">Competitions</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
            Create and manage weekly/monthly contests. Entries are free in v1; final rankings are shown once a contest completes for manual prize payout.
          </p>
        </div>
        <button className="admin-btn admin-btn-primary" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : '+ New Competition'}
        </button>
      </div>

      {showForm && <CreateCompetitionForm onCreate={handleCreate} creating={creating} />}

      <AdminStatGrid style={{ marginBottom: 'var(--space-5)' }}>
        <AdminStatCard icon="challenges" label="Total Competitions" value={kpis.total} />
        <AdminStatCard icon="activity" label="Active Now" value={kpis.active} />
        <AdminStatCard icon="calendar" label="Upcoming" value={kpis.upcoming} />
        <AdminStatCard icon="users" label="Total Entrants" value={kpis.participants} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search competitions by title..." searchValue={search} onSearchChange={setSearch}>
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
          emptyMessage="No competitions match the current filters"
          pagination={pagination}
          onPageChange={setPage}
          onRowClick={(row) => navigate(`/admin/competitions/${row.id}`)}
        />
      </Card>
    </div>
  )
}
