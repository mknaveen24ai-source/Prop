import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import PrizePoolEditor from '../../components/admin/PrizePoolEditor'

function statusColor(status) {
  return {
    upcoming: 'var(--admin-text-muted)',
    active: 'var(--admin-success)',
    completed: 'var(--admin-text-faint)',
    cancelled: 'var(--admin-danger, #d33)'
  }[status] || 'var(--admin-text-muted)'
}

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
    <form onSubmit={submit} className="admin-card" style={{ padding: '20px', marginBottom: '24px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
      <div style={{ gridColumn: '1 / -1' }}>
        <h3 style={{ margin: '0 0 4px' }}>Create Competition</h3>
      </div>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Title</div>
        <input style={inputStyle} value={form.title} onChange={(e) => update('title', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Type</div>
        <select style={inputStyle} value={form.type} onChange={(e) => update('type', e.target.value)}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Start</div>
        <input type="datetime-local" style={inputStyle} value={form.start_at} onChange={(e) => update('start_at', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>End</div>
        <input type="datetime-local" style={inputStyle} value={form.end_at} onChange={(e) => update('end_at', e.target.value)} required />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Starting Balance ($)</div>
        <input type="number" style={inputStyle} value={form.starting_balance} onChange={(e) => update('starting_balance', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Max Participants (blank = unlimited)</div>
        <input type="number" style={inputStyle} value={form.max_participants} onChange={(e) => update('max_participants', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Ranking Metric</div>
        <select style={inputStyle} value={form.ranking_metric} onChange={(e) => update('ranking_metric', e.target.value)}>
          <option value="profit_pct">Profit %</option>
          <option value="profit_usd">Profit $</option>
        </select>
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Max Drawdown %</div>
        <input type="number" style={inputStyle} value={form.max_drawdown_pct} onChange={(e) => update('max_drawdown_pct', e.target.value)} />
      </label>
      <label>
        <div style={{ fontSize: '12px', opacity: 0.7, marginBottom: '4px' }}>Daily Drawdown % (optional)</div>
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

  if (loading) {
    return <div style={{ padding: '32px', opacity: 0.7 }}>Loading competitions...</div>
  }

  return (
    <div style={{ padding: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>Trading Competitions</h2>
          <p style={{ margin: 0, opacity: 0.7, fontSize: '13px' }}>
            Create and manage weekly/monthly contests. Entries are free in v1; final rankings are shown once a contest completes for manual prize payout.
          </p>
        </div>
        <button className="admin-btn" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : 'New Competition'}
        </button>
      </div>

      {showForm && <CreateCompetitionForm onCreate={handleCreate} creating={creating} />}

      <div className="admin-card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: '10px 12px' }}>Title</th>
              <th style={{ padding: '10px 12px' }}>Type</th>
              <th style={{ padding: '10px 12px' }}>Status</th>
              <th style={{ padding: '10px 12px' }}>Start</th>
              <th style={{ padding: '10px 12px' }}>End</th>
              <th style={{ padding: '10px 12px' }}>Participants</th>
            </tr>
          </thead>
          <tbody>
            {competitions.map((c) => (
              <tr
                key={c.id}
                onClick={() => navigate(`/admin/competitions/${c.id}`)}
                style={{ cursor: 'pointer', borderTop: '1px solid var(--admin-border)' }}
              >
                <td style={{ padding: '10px 12px', fontWeight: 600 }}>{c.title}</td>
                <td style={{ padding: '10px 12px' }}>{c.type}</td>
                <td style={{ padding: '10px 12px' }}>
                  <span style={{ color: statusColor(c.status), fontWeight: 700, textTransform: 'uppercase', fontSize: '11px' }}>{c.status}</span>
                </td>
                <td style={{ padding: '10px 12px' }}>{new Date(c.start_at).toLocaleString()}</td>
                <td style={{ padding: '10px 12px' }}>{new Date(c.end_at).toLocaleString()}</td>
                <td style={{ padding: '10px 12px' }}>{c.participant_count}{c.max_participants ? ` / ${c.max_participants}` : ''}</td>
              </tr>
            ))}
            {competitions.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '24px', textAlign: 'center', opacity: 0.6 }}>No competitions yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
