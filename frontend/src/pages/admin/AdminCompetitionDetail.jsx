import React, { useEffect, useState, useCallback } from 'react'
import { useOutletContext, useParams, useNavigate } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'
import PrizePoolEditor from '../../components/admin/PrizePoolEditor'
import Card from '../../components/ui/Card'

const inputStyle = { width: '100%', padding: 'var(--space-2) var(--space-2-5)', border: '1px solid var(--admin-border)', background: 'transparent', color: 'inherit' }

function toLocalInputValue(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function SettingsPanel({ competition, onSave, saving, stepModels }) {
  const isLocked = competition.status !== 'upcoming'
  const [draft, setDraft] = useState({
    title: competition.title,
    description: competition.description || '',
    start_at: toLocalInputValue(competition.start_at),
    end_at: toLocalInputValue(competition.end_at),
    starting_balance: competition.starting_balance,
    max_participants: competition.max_participants ?? '',
    ranking_metric: competition.ranking_metric,
    max_drawdown_pct: competition.max_drawdown_pct,
    daily_drawdown_pct: competition.daily_drawdown_pct ?? ''
  })
  const [prizes, setPrizes] = useState(
    Array.isArray(competition.prize_pool_json) ? competition.prize_pool_json : []
  )

  function update(key, value) {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function submit(e) {
    e.preventDefault()
    const payload = {
      description: draft.description,
      prize_pool: prizes
        .filter((p) => String(p.label || '').trim().length > 0)
        .map((p) => {
          const row = { rank: parseInt(p.rank, 10) || 1, label: String(p.label).trim() }
          if (p.voucher && p.voucher.account_size && p.voucher.challenge_model_slug) {
            row.voucher = {
              account_size: parseFloat(p.voucher.account_size),
              challenge_model_slug: p.voucher.challenge_model_slug
            }
          }
          return row
        })
    }
    if (!isLocked) {
      Object.assign(payload, {
        title: draft.title,
        start_at: new Date(draft.start_at).toISOString(),
        end_at: new Date(draft.end_at).toISOString(),
        starting_balance: draft.starting_balance,
        max_participants: draft.max_participants === '' ? null : draft.max_participants,
        ranking_metric: draft.ranking_metric,
        max_drawdown_pct: draft.max_drawdown_pct,
        daily_drawdown_pct: draft.daily_drawdown_pct === '' ? null : draft.daily_drawdown_pct
      })
    }
    onSave(payload)
  }

  return (
    <form onSubmit={submit} className="lx-card" style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
      <h3 style={{ margin: '0 0 4px' }}>Settings</h3>
      {isLocked && (
        <p style={{ margin: '0 0 14px', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
          This competition is {competition.status} — dates, balance, and drawdown rules are locked to protect entries already in flight. Only description and prize display text can still be edited.
        </p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-3-5)', marginTop: 'var(--space-3)' }}>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Title</div>
          <input style={inputStyle} value={draft.title} disabled={isLocked} onChange={(e) => update('title', e.target.value)} />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Description</div>
          <input style={inputStyle} value={draft.description} onChange={(e) => update('description', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Start</div>
          <input type="datetime-local" style={inputStyle} value={draft.start_at} disabled={isLocked} onChange={(e) => update('start_at', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>End</div>
          <input type="datetime-local" style={inputStyle} value={draft.end_at} disabled={isLocked} onChange={(e) => update('end_at', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Starting Balance ($)</div>
          <input type="number" style={inputStyle} value={draft.starting_balance} disabled={isLocked} onChange={(e) => update('starting_balance', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Max Participants</div>
          <input type="number" style={inputStyle} value={draft.max_participants} disabled={isLocked} onChange={(e) => update('max_participants', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Ranking Metric</div>
          <select style={inputStyle} value={draft.ranking_metric} disabled={isLocked} onChange={(e) => update('ranking_metric', e.target.value)}>
            <option value="profit_pct">Profit %</option>
            <option value="profit_usd">Profit $</option>
          </select>
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Max Drawdown %</div>
          <input type="number" style={inputStyle} value={draft.max_drawdown_pct} disabled={isLocked} onChange={(e) => update('max_drawdown_pct', e.target.value)} />
        </label>
        <label>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7, marginBottom: 'var(--space-1)' }}>Daily Drawdown %</div>
          <input type="number" style={inputStyle} value={draft.daily_drawdown_pct} disabled={isLocked} onChange={(e) => update('daily_drawdown_pct', e.target.value)} />
        </label>
      </div>
      <div style={{ marginTop: 'var(--space-4)' }}>
        <PrizePoolEditor prizes={prizes} onChange={setPrizes} stepModels={stepModels} />
      </div>
      <div style={{ marginTop: 'var(--space-4)' }}>
        <button className="admin-btn" type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</button>
      </div>
    </form>
  )
}

function DisqualifyButton({ onDisqualify }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  if (!open) {
    return <button className="admin-btn admin-btn-sm" onClick={() => setOpen(true)}>Disqualify</button>
  }
  return (
    <div style={{ display: 'flex', gap: 'var(--space-1-5)' }}>
      <input
        style={{ ...inputStyle, width: '160px' }}
        placeholder="Reason (5+ chars)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        className="admin-btn admin-btn-sm"
        onClick={() => { onDisqualify(reason); setOpen(false); setReason('') }}
        disabled={reason.trim().length < 5}
      >
        Confirm
      </button>
      <button className="admin-btn admin-btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}

function CorrectBalanceButton({ onCorrect }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  if (!open) {
    return <button className="admin-btn admin-btn-sm" onClick={() => setOpen(true)}>Correct Balance</button>
  }
  const amountValid = Number.isFinite(parseFloat(amount)) && parseFloat(amount) !== 0
  return (
    <div style={{ display: 'flex', gap: 'var(--space-1-5)', flexWrap: 'wrap' }}>
      <input
        style={{ ...inputStyle, width: '100px' }}
        type="number"
        step="0.01"
        placeholder="Amount (±$)"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        style={{ ...inputStyle, width: '160px' }}
        placeholder="Reason (5+ chars)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <button
        className="admin-btn admin-btn-sm"
        onClick={() => { onCorrect(amount, reason); setOpen(false); setAmount(''); setReason('') }}
        disabled={!amountValid || reason.trim().length < 5}
      >
        Confirm
      </button>
      <button className="admin-btn admin-btn-sm" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}

const BOT_COUNTRY_OPTIONS = [
  'Random',
  'United States','United Kingdom','Canada','Australia','Germany','France','Netherlands',
  'Singapore','United Arab Emirates','Japan','South Korea','Brazil','India','South Africa',
  'Switzerland','Sweden','Norway','Denmark','Spain','Italy','Portugal','Mexico','Argentina',
  'Indonesia','Malaysia','Philippines','Thailand','Nigeria','Kenya','Egypt'
]

function BotRosterPanel({ adminAxios, toast, competition, onEntered }) {
  const [bots, setBots] = useState([])
  const [loading, setLoading] = useState(true)
  const [count, setCount] = useState(1)
  const [country, setCountry] = useState('Random')
  const [autoEnter, setAutoEnter] = useState(true)
  const [creating, setCreating] = useState(false)
  const [busyBotId, setBusyBotId] = useState(null)

  const loadBots = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/bots')
      setBots(res.data || [])
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load bots')
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios])

  useEffect(() => {
    loadBots()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleCreateBots() {
    const n = Math.min(50, Math.max(1, parseInt(count, 10) || 1))
    setCreating(true)
    try {
      const payload = {
        count: n,
        country: country === 'Random' ? 'random' : country,
        ...(autoEnter ? { enter_competition_id: competition.id } : {})
      }
      const res = await adminAxios.post('/api/admin/bots', payload)
      const created = Array.isArray(res.data) ? res.data : [res.data]
      toast.success(`${created.length} bot${created.length > 1 ? 's' : ''} created${autoEnter ? ' & entered' : ''}`)
      loadBots()
      if (autoEnter) onEntered()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not create bots')
    } finally {
      setCreating(false)
    }
  }

  async function handleEnter(botId) {
    setBusyBotId(botId)
    try {
      await adminAxios.post(`/api/admin/competitions/${competition.id}/bots/${botId}/enter`)
      toast.success('Bot entered into competition')
      loadBots()
      onEntered()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not enter bot')
    } finally {
      setBusyBotId(null)
    }
  }

  const canEnter = ['upcoming', 'active'].includes(competition.status)

  return (
    <Card style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
      <h3 style={{ margin: '0 0 4px' }}>Demo Bot Participants</h3>
      <p style={{ margin: '0 0 16px', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
        Bots are labeled participants with no real trading activity — their balance moves via an automated background tick.
        Names and countries are generated randomly unless overridden.
      </p>

      {/* Creation controls */}
      <div style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 'var(--space-4-5)', padding: 'var(--space-3-5)', background: 'var(--admin-bg-elevated)', borderRadius: '6px', border: '1px solid var(--admin-border)' }}>
        {/* Count */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>Count (1–50)</span>
          <input
            type="number"
            min={1}
            max={50}
            style={{ ...inputStyle, width: '80px' }}
            value={count}
            onChange={(e) => setCount(Math.min(50, Math.max(1, parseInt(e.target.value, 10) || 1)))}
          />
        </label>

        {/* Country */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontSize: 'var(--fs-xs)', opacity: 0.7 }}>Country</span>
          <select
            style={{ ...inputStyle, width: '180px' }}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
          >
            {BOT_COUNTRY_OPTIONS.map((c) => (
              <option key={c} value={c}>{c === 'Random' ? '🎲 Random (per bot)' : c}</option>
            ))}
          </select>
        </label>

        {/* Auto-enter toggle */}
        {canEnter && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)', fontSize: 'var(--fs-base)', cursor: 'pointer', paddingBottom: '2px' }}>
            <input
              type="checkbox"
              checked={autoEnter}
              onChange={(e) => setAutoEnter(e.target.checked)}
            />
            Auto-enter this competition
          </label>
        )}

        <button
          className="admin-btn"
          onClick={handleCreateBots}
          disabled={creating}
          style={{ alignSelf: 'flex-end' }}
        >
          {creating ? 'Creating...' : `Create ${count > 1 ? count + ' ' : ''}Bot${count > 1 ? 's' : ''}`}
        </button>
      </div>

      {/* Bot table */}
      {loading ? (
        <div style={{ opacity: 0.6, fontSize: 'var(--fs-base)' }}>Loading bots...</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Name</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Country</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Current Competition</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}></th>
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => (
              <tr key={bot.id} style={{ borderTop: '1px solid var(--admin-border)' }}>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{bot.full_name}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)', color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>{bot.country || '—'}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{bot.competition_title || '—'}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>
                  {!bot.competition_id && canEnter && (
                    <button className="admin-btn admin-btn-sm" onClick={() => handleEnter(bot.id)} disabled={busyBotId === bot.id}>
                      {busyBotId === bot.id ? 'Entering...' : 'Enter This Competition'}
                    </button>
                  )}
                  {bot.competition_id === competition.id && <span style={{ opacity: 0.6 }}>In this competition</span>}
                </td>
              </tr>
            ))}
            {bots.length === 0 && (
              <tr><td colSpan={4} style={{ padding: 'var(--space-4)', textAlign: 'center', opacity: 0.6 }}>No bots yet</td></tr>
            )}
          </tbody>
        </table>
      )}
    </Card>
  )
}


export default function AdminCompetitionDetail() {
  const { adminAxios } = useOutletContext()
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const [competition, setCompetition] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [stepModels, setStepModels] = useState([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get(`/api/admin/competitions/${id}`)
      setCompetition(res.data)
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not load competition')
    } finally {
      setLoading(false)
    }
  }, [adminAxios, id, toast])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    adminAxios.get('/api/admin/step-models')
      .then((res) => setStepModels(Array.isArray(res.data) ? res.data : (res.data?.models || [])))
      .catch(() => setStepModels([]))
  }, [adminAxios])

  async function handleSaveSettings(payload) {
    setSaving(true)
    try {
      await adminAxios.patch(`/api/admin/competitions/${id}`, payload)
      toast.success('Settings saved')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save settings')
    } finally {
      setSaving(false)
    }
  }

  async function handleCancel() {
    if (!window.confirm('Cancel this competition? All active entries will be withdrawn.')) return
    try {
      await adminAxios.post(`/api/admin/competitions/${id}/cancel`)
      toast.success('Competition cancelled')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not cancel competition')
    }
  }

  async function handleDisqualify(entryId, reason) {
    try {
      await adminAxios.post(`/api/admin/competitions/${id}/entries/${entryId}/disqualify`, { reason })
      toast.success('Entry disqualified')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not disqualify entry')
    }
  }

  async function handleCorrectBalance(entryId, amount, reason) {
    try {
      await adminAxios.post(`/api/admin/competitions/${id}/entries/${entryId}/correct-balance`, { amount, reason })
      toast.success('Balance corrected')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not correct balance')
    }
  }

  async function handleWithdrawBot(entryId) {
    if (!window.confirm('Withdraw this bot from the competition?')) return
    try {
      await adminAxios.post(`/api/admin/competitions/${id}/entries/${entryId}/withdraw-bot`)
      toast.success('Bot withdrawn')
      load()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not withdraw bot')
    }
  }

  if (loading) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Loading...</div>
  if (!competition) return <div style={{ padding: 'var(--space-7)', opacity: 0.7 }}>Competition not found</div>

  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <button className="admin-btn admin-btn-sm" style={{ marginBottom: 'var(--space-4)' }} onClick={() => navigate('/admin/competitions')}>
        ← Back to Competitions
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-5)' }}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>{competition.title}</h2>
          <div style={{ fontSize: 'var(--fs-sm)', opacity: 0.7 }}>Status: {competition.status} · {competition.entries?.length || 0} entries</div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <button className="admin-btn admin-btn-sm" onClick={() => navigate(`/admin/competitions/${id}/analytics`)}>
            View Trade Analytics
          </button>
          {['upcoming', 'active'].includes(competition.status) && (
            <button className="admin-btn admin-btn-sm" onClick={handleCancel}>Cancel Competition</button>
          )}
        </div>
      </div>

      <SettingsPanel competition={competition} onSave={handleSaveSettings} saving={saving} stepModels={stepModels} />

      <BotRosterPanel adminAxios={adminAxios} toast={toast} competition={competition} onEntered={load} />

      <Card style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-6)', overflowX: 'auto' }}>
        <h3 style={{ margin: '0 0 12px' }}>Entries</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
          <thead>
            <tr style={{ textAlign: 'left', opacity: 0.7 }}>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Trader</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Account</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Balance</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Status</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Final Rank</th>
              <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}></th>
            </tr>
          </thead>
          <tbody>
            {(competition.entries || []).map((entry) => (
              <tr key={entry.id} style={{ borderTop: '1px solid var(--admin-border)' }}>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>
                  {entry.full_name}
                  {entry.is_bot && (
                    <span style={{ marginLeft: 'var(--space-1-5)', fontSize: 'var(--fs-2xs)', padding: '2px 6px', borderRadius: '4px', background: 'var(--admin-bg-elevated)', border: '1px solid var(--admin-border)', opacity: 0.8 }}>
                      DEMO BOT
                    </span>
                  )}
                  <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.6 }}>{entry.email}</div>
                </td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)', fontFamily: 'monospace', fontSize: 'var(--fs-sm)' }}>{entry.account_uid || '—'}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{entry.current_balance != null ? `$${parseFloat(entry.current_balance).toFixed(2)}` : '—'}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>
                  {entry.status}
                  {entry.disqualified_reason && <div style={{ fontSize: 'var(--fs-xs)', opacity: 0.6 }}>{entry.disqualified_reason}</div>}
                </td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{entry.final_rank || '—'}</td>
                <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>
                  <div style={{ display: 'flex', gap: 'var(--space-1-5)', flexWrap: 'wrap' }}>
                    {entry.status === 'active' && !entry.is_bot && (
                      <DisqualifyButton onDisqualify={(reason) => handleDisqualify(entry.id, reason)} />
                    )}
                    {entry.status === 'active' && entry.is_bot && (
                      <button className="admin-btn admin-btn-sm" onClick={() => handleWithdrawBot(entry.id)}>Withdraw Bot</button>
                    )}
                    {['active', 'completed'].includes(competition.status) && entry.account_uid && (
                      <CorrectBalanceButton onCorrect={(amount, reason) => handleCorrectBalance(entry.id, amount, reason)} />
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {(competition.entries || []).length === 0 && (
              <tr><td colSpan={6} style={{ padding: 'var(--space-5)', textAlign: 'center', opacity: 0.6 }}>No entries yet</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      {competition.status === 'completed' && (
        <Card style={{ padding: 'var(--space-5)' }}>
          <h3 style={{ margin: '0 0 12px' }}>Final Leaderboard (for payout reference)</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-base)' }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.7 }}>
                <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Rank</th>
                <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Trader</th>
                <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Profit %</th>
                <th style={{ padding: 'var(--space-2) var(--space-2-5)' }}>Profit $</th>
              </tr>
            </thead>
            <tbody>
              {(competition.leaderboard || []).map((row) => (
                <tr key={row.entry_id} style={{ borderTop: '1px solid var(--admin-border)' }}>
                  <td style={{ padding: 'var(--space-2) var(--space-2-5)', fontWeight: 700 }}>#{row.rank}</td>
                  <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>
                    {row.full_name}
                    {row.is_bot && (
                      <span style={{ marginLeft: 'var(--space-1-5)', fontSize: 'var(--fs-2xs)', padding: '2px 6px', borderRadius: '4px', background: 'var(--admin-bg-elevated)', border: '1px solid var(--admin-border)', opacity: 0.8 }}>
                        DEMO BOT
                      </span>
                    )}
                  </td>
                  <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>{row.profit_pct.toFixed(2)}%</td>
                  <td style={{ padding: 'var(--space-2) var(--space-2-5)' }}>${row.profit_usd.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
