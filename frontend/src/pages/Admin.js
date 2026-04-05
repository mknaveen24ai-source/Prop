import React, { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'
const ax = axios.create({ baseURL: API_URL, withCredentials: true })

// FIX (MEDIUM #19): Add response interceptor to handle 401 errors gracefully.
// Previously, if admin token expired, API calls would fail silently or with
// generic errors instead of showing the admin login modal.
ax.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      // Redirect to admin login if not already there
      if (!window.location.pathname.includes('/admin')) {
        window.location.href = '/admin?expired=1'
      }
    }
    return Promise.reject(error)
  }
)

const COLOR_ACCENT = '#2962ff'
const COLOR_POS = '#00c896'
const COLOR_NEG = '#ff4757'
const COLOR_MUTED = 'var(--text-muted)'
// FIX: Removed COLOR_GOLD and COLOR_LAVENDER (no-unused-vars)

// ─── helpers ───────────────────────────────────────────────────────────
function fmt(n, dec = 2) { return parseFloat(n || 0).toFixed(dec) }
function fmtUSD(n) { return '$' + fmt(n) }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : 'N/A' }
function fmtDateTime(d) { return d ? new Date(d).toLocaleString() : '–' }
function fmtPct(n) { return fmt(n) + '%' }

function fmtTimerMinutes(minutes) {
  const m = Math.max(0, Math.floor(Number(minutes) || 0))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const mm = m % 60
  if (d > 0) return `${d}d ${h}h ${mm}m`
  if (h > 0) return `${h}h ${mm}m`
  return `${mm}m`
}

function calcRemainingSlaMinutes(createdAt, slaHours) {
  if (!createdAt) return null
  const startMs = new Date(createdAt).getTime()
  if (Number.isNaN(startMs)) return null
  const totalMs = Math.max(1, Number(slaHours) || 0) * 3600000
  const remainingMs = (startMs + totalMs) - Date.now()
  return Math.floor(remainingMs / 60000)
}

function toDateTimeLocalValue(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function StatusBadge({ status }) {
  const colors = {
    active: COLOR_ACCENT,
    passed: COLOR_POS,
    failed: COLOR_NEG,
    high: COLOR_NEG,
    medium: '#ffa502',
    low: COLOR_ACCENT,
    warning: '#ffa502',
    breach: COLOR_NEG,
    overdue: '#ff7f50',
    within_sla: COLOR_POS,
    ok: COLOR_POS,
    queued: COLOR_ACCENT,
    scheduled: '#ffa502',
    sent: COLOR_POS,
    read: COLOR_POS,
    in_progress: COLOR_ACCENT,
    pending_external: '#ffa502',
    urgent: COLOR_NEG,
    normal: COLOR_ACCENT,
    funded: COLOR_POS,
    expired: COLOR_MUTED,
    approved: COLOR_POS,
    pending: COLOR_ACCENT,
    rejected: COLOR_NEG,
    paid: COLOR_POS,
    open: COLOR_ACCENT,
    closed: COLOR_MUTED,
    cancelled: COLOR_MUTED,
    booked: COLOR_POS,
    skipped: COLOR_MUTED,
    phase1: COLOR_ACCENT,
    phase2: COLOR_ACCENT,
    locked: COLOR_NEG,
    banned: COLOR_NEG,
    disabled: COLOR_MUTED,
    healthy: COLOR_POS,
    watch: '#ffa502',
    critical: COLOR_NEG,
    operational: COLOR_POS,
    stale: '#ff7f50'
  }
  const c = colors[status] || COLOR_MUTED
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: '4px',
      fontSize: '11px', fontWeight: 600, letterSpacing: '0.06em',
      background: c + '22', color: c, border: `1px solid ${c}44`
    }}>
      {(status || '').toUpperCase()}
    </span>
  )
}

function Modal({ title, onClose, children, width = '520px' }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000, padding: '20px'
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '12px',
        padding: '28px', width, maxWidth: '95vw', maxHeight: '85vh',
        overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.6)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <h3 style={{ color: 'var(--text)', margin: 0 }}>{title}</h3>
          <button onClick={onClose} style={{
            background: 'none', border: '1px solid var(--navy-border)', color: 'var(--text-muted)',
            borderRadius: '6px', padding: '4px 10px', cursor: 'pointer', fontSize: '16px'
          }}>×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function Inp({ label, ...props }) {
  return (
    <div style={{ marginBottom: '14px' }}>
      {label && <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>{label}</label>}
      <input style={{
        width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)',
        borderRadius: '6px', padding: '9px 12px', color: 'var(--text)', fontSize: '14px'
      }} {...props} />
    </div>
  )
}

function Btn({ children, variant = 'default', style: s, ...props }) {
  const colors = {
    default: { bg: 'var(--navy-card)', border: 'var(--navy-border)', color: 'var(--text)' },
    accent:  { bg: '#2962ff', border: '#2962ff', color: '#ffffff' },
    green:   { bg: 'var(--green)', border: 'var(--green)', color: '#fff' },
    red:     { bg: 'var(--red)', border: 'var(--red)', color: '#fff' },
    cyan:    { bg: 'var(--accent)', border: 'var(--accent)', color: 'var(--navy-mid)' },
    ghost:   { bg: 'transparent', border: 'var(--navy-border)', color: 'var(--text)' }
  }
  const c = colors[variant] || colors.default
  return (
    <button style={{
      padding: '8px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px',
      fontWeight: 600, border: `1px solid ${c.border}`, background: c.bg, color: c.color,
      transition: 'opacity 0.15s', ...s
    }} {...props}>{children}</button>
  )
}

function StatCard({ label, value, color, sub }) {
  return (
    <div style={{
      background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '12px',
      padding: '18px 20px', position: 'relative', overflow: 'hidden',
      transition: 'all 0.3s cubic-bezier(0.4,0,0.2,1)',
    }}
    onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.3)'; }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px', background: color || 'var(--accent)', opacity: 0.6 }} />
      <div style={{ fontSize: '24px', fontWeight: 700, color: color || 'var(--text)', fontFamily: 'monospace' }}>{value}</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', letterSpacing: '0.06em' }}>{label}</div>
      {sub && <div style={{ fontSize: '11px', color: 'var(--text)', marginTop: '4px' }}>{sub}</div>}
    </div>
  )
}

function Table({ cols, rows, onRow }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key || c.label} style={{
                padding: '10px 12px', textAlign: 'left', borderBottom: '1px solid var(--navy-border)',
                color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.08em', whiteSpace: 'nowrap'
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={cols.length} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-dim)' }}>No data</td></tr>
          )}
          {rows.map((row, i) => (
            <tr key={row.id || i}
              onClick={() => onRow && onRow(row)}
              style={{
                borderBottom: '1px solid var(--navy-hover)', cursor: onRow ? 'pointer' : 'default',
                transition: 'background 0.1s'
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-hover)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              {cols.map(c => (
                <td key={c.key || c.label} style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                  {c.render ? c.render(row[c.key], row) : (row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function OverviewTab({ overview }) {
  if (!overview) return <div style={{ color: COLOR_MUTED }}>Loading...</div>
  const { users, accounts, trading, payouts, exposure } = overview
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px', fontFamily: 'Inter, sans-serif' }}>Overview</h2>

      {/* ── Core Stats Grid ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: '12px', marginBottom: '28px' }}>
        <StatCard label="Total Traders"    value={users?.total || 0} />
        <StatCard label="KYC Pending"      value={users?.pending_kyc || 0}   color={COLOR_ACCENT} />
        <StatCard label="KYC Approved"     value={users?.approved_kyc || 0}  color={COLOR_POS} />
        <StatCard label="Banned"           value={users?.banned || 0}         color={COLOR_NEG} />
        <StatCard label="Phase 1 Active"   value={accounts?.phase1 || 0}     color={COLOR_ACCENT} />
        <StatCard label="Phase 2 Active"   value={accounts?.phase2 || 0}     color={COLOR_ACCENT} />
        <StatCard label="Funded Traders"   value={accounts?.funded || 0}     color={COLOR_POS} />
        <StatCard label="Total Failed"     value={accounts?.failed || 0}     color={COLOR_NEG} />
        <StatCard label="Open Trades"      value={trading?.total_open_trades || 0} color={COLOR_ACCENT} />
        <StatCard label="Demo P&L"
          value={fmtUSD(trading?.total_demo_pnl || 0)}
          color={parseFloat(trading?.total_demo_pnl || 0) >= 0 ? COLOR_POS : COLOR_NEG} />
        <StatCard label="Pending Payouts"  value={payouts?.pending_payouts || 0} color={COLOR_ACCENT} />
        <StatCard label="Total Paid Out"   value={fmtUSD(payouts?.total_paid_out || 0)} color={COLOR_ACCENT} />
        {payouts?.flagged_count > 0 && (
          <StatCard label="🚩 Flagged Payouts" value={payouts.flagged_count} color={COLOR_NEG}
            sub="Review in Payouts tab" />
        )}
      </div>

      {/* ── Real-Money Hedge Exposure Report ── */}
      {exposure && exposure.length > 0 && (
        <div style={{ marginBottom: '28px' }}>
          <h3 style={{ color: 'var(--text)', marginBottom: '12px', fontSize: '15px' }}>
            📊 Live Hedge Exposure Report
          </h3>
          <p style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '14px' }}>
            Net simulated open positions – reverse-trade these in your real broker to hedge.
          </p>
          <div style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ background: 'var(--navy-card)' }}>
                  {['Instrument', 'Long Lots', 'Short Lots', 'Net Position', 'Direction', 'Open Trades'].map(h => (
                    <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.08em', borderBottom: '1px solid var(--navy-border)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exposure.map(row => (
                  <tr key={row.instrument} style={{ borderBottom: '1px solid var(--navy-mid)' }}>
                    <td style={{ padding: '10px 14px', fontWeight: '700', color: 'var(--text)', fontFamily: 'monospace' }}>{row.instrument}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{row.long_lots.toFixed(2)}</td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{row.short_lots.toFixed(2)}</td>
                    <td style={{ padding: '10px 14px', fontWeight: '700', fontFamily: 'monospace', color: Math.abs(row.net_lots) > 0 ? 'var(--text)' : 'var(--text-dim)' }}>
                      {row.net_lots > 0 ? '+' : ''}{row.net_lots.toFixed(2)}
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{
                        padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: '700',
                        background: row.net_direction === 'BUY' ? 'rgba(74, 74, 74, 0.2)' : 'rgba(97, 97, 97, 0.2)',
                        color: 'var(--text-muted)',
                        border: `1px solid ${row.net_direction === 'BUY' ? 'var(--green)' : 'var(--red)'}`
                      }}>
                        {row.net_direction}
                      </span>
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-muted)' }}>{row.trade_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {exposure.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: '13px', padding: '20px 0' }}>No open trades – no exposure to hedge.</div>
          )}
        </div>
      )}
      {exposure && exposure.length === 0 && (
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '20px 24px', marginBottom: '28px' }}>
          <div style={{ color: 'var(--text-dim)', fontSize: '13px' }}>📊 No open trades – hedge exposure is zero.</div>
        </div>
      )}
    </div>
  )
}

// ─── TRADERS TAB ─────────────────────────────────────────────────────────────
function TradersTab({ traders, onRefresh, showMsg }) {
  const [selected, setSelected]     = useState(null)
  const [notes, setNotes]           = useState([])
  const [newNote, setNewNote]       = useState('')
  const [kycReason, setKycReason]   = useState('')
  const [showKycReject, setShowKycReject] = useState(null)

  const [staleKyc, setStaleKyc]   = useState(null)
  const [staleLoading, setStaleLoading] = useState(false)

  useEffect(() => {
    ax.get('/api/admin/kyc/stale')
      .then(r => setStaleKyc(r.data))
      .catch(() => {})
  }, [])

  async function expireKyc(userId, userName) {
    if (!window.confirm(`Mark KYC as expired for ${userName}? They will need to re-submit documents.`)) return
    setStaleLoading(true)
    try {
      await ax.post('/api/admin/kyc/expire', { user_id: userId })
      showMsg(`KYC expired for ${userName} – they must re-submit`)
      const r = await ax.get('/api/admin/kyc/stale')
      setStaleKyc(r.data)
      onRefresh()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not expire KYC', true)
    }
    setStaleLoading(false)
  }

  async function loadNotes(userId) {
    try {
      const r = await ax.get(`/api/admin/notes/trader/${userId}`)
      setNotes(r.data)
    } catch { setNotes([]) }
  }

  async function addNote(userId) {
    if (!newNote.trim()) return
    try {
      await ax.post('/api/admin/notes', { entity_type: 'trader', entity_id: userId, note_text: newNote })
      setNewNote('')
      loadNotes(userId)
      showMsg('Note added')
    } catch { showMsg('Could not add note', true) }
  }

  async function deleteNote(noteId, userId) {
    try {
      await ax.delete(`/api/admin/notes/${noteId}`)
      loadNotes(userId)
    } catch { showMsg('Could not delete note', true) }
  }

  async function approveKyc(userId) {
    try {
      await ax.post('/api/admin/kyc/approve', { user_id: userId })
      showMsg('KYC approved')
      onRefresh()
    } catch { showMsg('Could not approve KYC', true) }
  }

  async function rejectKyc(userId, reason) {
    try {
      await ax.post('/api/admin/kyc/reject', { user_id: userId, rejection_reason: reason })
      showMsg('KYC rejected')
      setShowKycReject(null)
      onRefresh()
    } catch { showMsg('Could not reject KYC', true) }
  }

  async function banTrader(userId, isBanned) {
    try {
      await ax.post(isBanned ? '/api/admin/unban' : '/api/admin/ban', { user_id: userId })
      showMsg(isBanned ? 'Trader unbanned' : 'Trader banned')
      onRefresh()
    } catch { showMsg('Could not update ban status', true) }
  }

  const cols = [
    { key: 'full_name', label: 'Name' },
    { key: 'trader_uid', label: 'Trader ID', render: v => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px' }}>{v ? v.split('-')[0] : '—'}</span>
    )},
    { key: 'email',     label: 'Email' },
    { key: 'country',   label: 'Country' },
    { key: 'kyc_status', label: 'KYC', render: v => <StatusBadge status={v} /> },
    { key: 'total_accounts', label: 'Accounts' },
    { key: 'created_at', label: 'Joined', render: v => fmtDate(v) },
    { key: 'is_banned', label: 'Status', render: v => v ? <StatusBadge status="banned" /> : <StatusBadge status="active" /> },
    { key: '_actions', label: 'Actions', render: (_, row) => (
      <div style={{ display: 'flex', gap: '6px' }}>
        <Btn variant="ghost" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); setSelected(row); loadNotes(row.id) }}>Notes</Btn>
        {row.kyc_status === 'pending' && <>
          <Btn variant="ghost" style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--accent)' }} onClick={e => { e.stopPropagation(); window.open(`${API_URL}/api/admin/kyc/document/${row.id}/id`, '_blank') }}>View ID</Btn>
          <Btn variant="green" style={{ padding: '4px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); approveKyc(row.id) }}>Approve</Btn>
          <Btn variant="red"   style={{ padding: '4px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); setShowKycReject(row.id) }}>Reject</Btn>
        </>}
        <Btn variant={row.is_banned ? 'green' : 'red'} style={{ padding: '4px 8px', fontSize: '11px' }}
          onClick={e => { e.stopPropagation(); banTrader(row.id, row.is_banned) }}>
          {row.is_banned ? 'Unban' : 'Ban'}
        </Btn>
      </div>
    )}
  ]

  return (
    <div>
      {staleKyc && staleKyc.stale_count > 0 && (
        <div style={{ background: 'rgba(139, 139, 139, 0.08)', border: '1px solid rgba(139, 139, 139, 0.3)', borderRadius: '10px', padding: '14px 18px', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <span style={{ color: 'var(--text-muted)', fontWeight: '700', fontSize: '13px' }}>
              â° {staleKyc.stale_count} trader{staleKyc.stale_count !== 1 ? 's' : ''} with KYC older than {staleKyc.expiry_months} months
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Set KYC_EXPIRY_MONTHS in .env to configure</span>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {staleKyc.traders.map(t => (
              <div key={t.id} style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                <div>
                  <div style={{ fontSize: '12px', color: 'var(--text)', fontWeight: '600' }}>{t.full_name}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{t.months_since_kyc} months ago</div>
                </div>
                <Btn variant="red" style={{ padding: '3px 8px', fontSize: '10px' }}
                  onClick={() => expireKyc(t.id, t.full_name)} disabled={staleLoading}>
                  Expire
                </Btn>
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ color: 'var(--text)' }}>Traders ({traders.length})</h2>
        <Btn variant="ghost" onClick={() => { const link = document.createElement('a'); link.href = `${API_URL}/api/admin/export/traders`; link.click() }}>Export CSV</Btn>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table cols={cols} rows={traders} />
      </div>

      {selected && (
        <Modal title={`Notes – ${selected.full_name}`} onClose={() => setSelected(null)}>
          <div style={{ marginBottom: '16px' }}>
            {notes.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>No notes yet.</p>}
            {notes.map(n => (
              <div key={n.id} style={{ background: 'var(--navy-hover)', borderRadius: '6px', padding: '10px 12px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--text)' }}>{n.note_text}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{fmtDateTime(n.created_at)}</div>
                </div>
                <button onClick={() => deleteNote(n.id, selected.id)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer', fontSize: '14px' }}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input value={newNote} onChange={e => setNewNote(e.target.value)}
              placeholder="Add a note..." style={{ flex: 1, background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '9px 12px', color: 'var(--text)', fontSize: '13px' }}
              onKeyDown={e => e.key === 'Enter' && addNote(selected.id)} />
            <Btn variant="accent" onClick={() => addNote(selected.id)}>Add</Btn>
          </div>
        </Modal>
      )}

      {showKycReject && (
        <Modal title="Reject KYC – Reason" onClose={() => setShowKycReject(null)}>
          <Inp label="REJECTION REASON (optional)" value={kycReason} onChange={e => setKycReason(e.target.value)} placeholder="e.g. Document unclear, mismatch..." />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="red" onClick={() => rejectKyc(showKycReject, kycReason)}>Confirm Reject</Btn>
            <Btn onClick={() => setShowKycReject(null)}>Cancel</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── ACCOUNTS TAB ─────────────────────────────────────────────────────────────
function AccountsTab({ accounts, onRefresh, showMsg }) {
  const [selected, setSelected]     = useState(null)
  const [modal, setModal]           = useState(null)
  const [notes, setNotes]           = useState([])
  const [newNote, setNewNote]       = useState('')
  const [form, setForm]             = useState({})
  const [loading, setLoading]       = useState(false)

  const [filterStatus,  setFilterStatus]  = useState('')
  const [filterType,    setFilterType]    = useState('')
  const [filterCountry, setFilterCountry] = useState('')
  const [filterFrom,    setFilterFrom]    = useState('')
  const [filterTo,      setFilterTo]      = useState('')
  const [filterSearch,  setFilterSearch]  = useState('')

  const countries = [...new Set(accounts.map(a => a.country).filter(Boolean))].sort()

  const filtered = accounts.filter(a => {
    if (filterStatus  && a.status       !== filterStatus)       return false
    if (filterType    && a.account_type !== filterType)         return false
    if (filterCountry && a.country      !== filterCountry)      return false
    if (filterFrom    && new Date(a.created_at) < new Date(filterFrom)) return false
    if (filterTo      && new Date(a.created_at) > new Date(filterTo + 'T23:59:59')) return false
    if (filterSearch) {
      const q = filterSearch.toLowerCase()
      if (!(a.full_name?.toLowerCase().includes(q) || a.email?.toLowerCase().includes(q))) return false
    }
    return true
  })

  const hasFilter = filterStatus || filterType || filterCountry || filterFrom || filterTo || filterSearch

  const [checkedIds, setCheckedIds]   = useState(new Set())
  const [bulkAction, setBulkAction]   = useState('lock')
  const [bulkDays, setBulkDays]       = useState('7')
  const [bulkLoading, setBulkLoading] = useState(false)

  function toggleCheck(id) {
    setCheckedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (checkedIds.size === filtered.length) {
      setCheckedIds(new Set())
    } else {
      setCheckedIds(new Set(filtered.map(a => a.id)))
    }
  }

  async function applyBulkAction() {
    if (checkedIds.size === 0) return showMsg('Select at least one account', true)
    setBulkLoading(true)
    try {
      const body = { account_ids: Array.from(checkedIds), action: bulkAction }
      if (bulkAction === 'extend_time') body.days = parseInt(bulkDays)
      const r = await ax.post('/api/admin/accounts/bulk', body)
      showMsg(`✓ ${r.data.message} – ${r.data.affected} account(s) affected`)
      setCheckedIds(new Set())
      onRefresh()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Bulk action failed', true)
    }
    setBulkLoading(false)
  }

  const openModal = (acc, type) => { setSelected(acc); setModal(type); setForm({}) }
  const closeModal = () => { setModal(null); setSelected(null); setForm({}) }

  async function loadNotes(accId) {
    try { const r = await ax.get(`/api/admin/notes/account/${accId}`); setNotes(r.data) } catch { setNotes([]) }
  }

  async function addNote() {
    if (!newNote.trim() || !selected) return
    try {
      await ax.post('/api/admin/notes', { entity_type: 'account', entity_id: selected.id, note_text: newNote })
      setNewNote(''); loadNotes(selected.id); showMsg('Note added')
    } catch { showMsg('Could not add note', true) }
  }

  async function deleteNote(noteId) {
    try { await ax.delete(`/api/admin/notes/${noteId}`); loadNotes(selected.id) } catch {}
  }

  async function doAction(endpoint, body, successMsg) {
    setLoading(true)
    try {
      const r = await ax.post(`/api/admin/${endpoint}`, body)
      showMsg(r.data.message || successMsg)
      closeModal()
      onRefresh()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Action failed', true)
    }
    setLoading(false)
  }

  async function lockUnlock(acc) {
    try {
      const ep = acc.status === 'locked' ? '/api/admin/accounts/unlock' : '/api/admin/lock-account'
      const body = { account_id: acc.id }
      await ax.post(ep, body)
      showMsg(acc.status === 'locked' ? 'Account unlocked' : 'Account locked')
      onRefresh()
    } catch { showMsg('Could not update account', true) }
  }

  const cols = [
    { key: '_check', label: (
      <input type="checkbox" checked={checkedIds.size === accounts.length && accounts.length > 0}
        onChange={toggleAll} style={{ accentColor: 'var(--text)', cursor: 'pointer' }} />
    ), render: (_, row) => (
      <input type="checkbox" checked={checkedIds.has(row.id)}
        onChange={e => { e.stopPropagation(); toggleCheck(row.id) }}
        onClick={e => e.stopPropagation()}
        style={{ accentColor: 'var(--text)', cursor: 'pointer' }} />
    )},
    { key: 'full_name',    label: 'Trader' },
    { key: 'trader_uid',   label: 'Trader ID', render: v => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px', color: 'var(--text)' }}>{v ? v.split('-')[0] : '—'}</span>
    )},
    { key: 'account_uid',  label: 'Account ID', render: v => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px', color: 'var(--text)' }}>{v ? v.split('-')[0] : '—'}</span>
    )},
    { key: 'account_type', label: 'Type',    render: v => <StatusBadge status={v} /> },
    { key: 'account_size', label: 'Size',    render: v => fmtUSD(v) },
    { key: 'current_balance', label: 'Balance', render: v => fmtUSD(v) },
    { key: 'status',       label: 'Status',  render: v => <StatusBadge status={v} /> },
    { key: 'review_flagged', label: 'Flag',   render: v => v ? <span style={{ color: 'var(--red)', fontSize: '11px' }}>âš‘ REVIEW</span> : null },
    { key: 'phase_end_date', label: 'Expires', render: v => fmtDate(v) },
    { key: '_actions', label: 'Actions', render: (_, row) => (
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
        <Btn variant="ghost"  style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'notes'); loadNotes(row.id) }}>Notes</Btn>
        {row.status === 'active' && <>
          <Btn variant="red"  style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'forceclose') }}>Force Close</Btn>
          <Btn variant="accent" style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'time') }}>Time</Btn>
          <Btn variant="cyan" style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'promote') }}>Promote</Btn>
          <Btn variant="ghost" style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'lotoverride') }}>Lots</Btn>
          <Btn variant={row.review_flagged ? 'red' : 'ghost'} style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'flag') }}>
            {row.review_flagged ? 'âš‘ Unflag' : 'âš‘ Flag'}
          </Btn>
        </>}
        {['failed', 'expired'].includes(row.status) && (
          <Btn variant="green" style={{ padding: '3px 7px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); openModal(row, 'reset') }}>Reset</Btn>
        )}
        <Btn variant={row.status === 'locked' ? 'green' : 'red'} style={{ padding: '3px 7px', fontSize: '11px' }}
          onClick={e => { e.stopPropagation(); lockUnlock(row) }}>
          {row.status === 'locked' ? 'Unlock' : 'Lock'}
        </Btn>
      </div>
    )}
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h2 style={{ color: 'var(--text)' }}>Accounts ({filtered.length}{hasFilter ? ` / ${accounts.length}` : ''})</h2>
        <Btn variant="ghost" onClick={() => { const a = document.createElement('a'); a.href = `${API_URL}/api/admin/export/trades`; a.click() }}>Export Trades CSV</Btn>
      </div>

      {/* ── Account Filters ── */}
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px 16px', marginBottom: '12px' }}>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 160px' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>SEARCH</div>
            <input value={filterSearch} onChange={e => setFilterSearch(e.target.value)}
              placeholder="Trader name or email..."
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px' }} />
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>STATUS</div>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
              style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px' }}>
              <option value="">All statuses</option>
              {['active','failed','expired','passed','funded','locked'].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>TYPE</div>
            <select value={filterType} onChange={e => setFilterType(e.target.value)}
              style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px' }}>
              <option value="">All types</option>
              {['phase1','phase2','funded'].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {countries.length > 0 && (
            <div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>COUNTRY</div>
              <select value={filterCountry} onChange={e => setFilterCountry(e.target.value)}
                style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px' }}>
                <option value="">All countries</option>
                {countries.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          )}
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>CREATED FROM</div>
            <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
              style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px', colorScheme: 'dark' }} />
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px', letterSpacing: '0.08em' }}>TO</div>
            <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
              style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '7px 10px', color: 'var(--text)', fontSize: '12px', colorScheme: 'dark' }} />
          </div>
          {hasFilter && (
            <Btn variant="ghost" style={{ fontSize: '11px', padding: '7px 12px', alignSelf: 'flex-end' }}
              onClick={() => { setFilterStatus(''); setFilterType(''); setFilterCountry(''); setFilterFrom(''); setFilterTo(''); setFilterSearch('') }}>
              × Clear
            </Btn>
          )}
        </div>
        {hasFilter && <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text)' }}>Showing {filtered.length} of {accounts.length} accounts</div>}
      </div>

      {/* ── Bulk Action Toolbar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
        background: checkedIds.size > 0 ? 'rgba(148, 148, 148, 0.08)' : 'var(--navy-hover)',
        border: `1px solid ${checkedIds.size > 0 ? 'rgba(148, 148, 148, 0.3)' : 'var(--navy-border)'}`,
        borderRadius: '8px', padding: '10px 14px', marginBottom: '12px',
        transition: 'all 0.2s'
      }}>
        <span style={{ fontSize: '12px', color: checkedIds.size > 0 ? 'var(--text)' : 'var(--text-dim)', fontWeight: '600', minWidth: '100px' }}>
          {checkedIds.size > 0 ? `${checkedIds.size} selected` : 'Select accounts'}
        </span>
        <select
          value={bulkAction}
          onChange={e => setBulkAction(e.target.value)}
          disabled={checkedIds.size === 0}
          style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', color: 'var(--text)', borderRadius: '6px', padding: '6px 10px', fontSize: '12px', opacity: checkedIds.size === 0 ? 0.4 : 1 }}
        >
          <option value="lock">Lock Accounts</option>
          <option value="unlock">Unlock Accounts</option>
          <option value="fail">Fail Accounts</option>
          <option value="extend_time">Extend Time Limit</option>
        </select>
        {bulkAction === 'extend_time' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <input
              type="number" value={bulkDays} onChange={e => setBulkDays(e.target.value)}
              min="1" max="90"
              style={{ width: '60px', background: 'var(--navy-card)', border: '1px solid var(--navy-border)', color: 'var(--text)', borderRadius: '6px', padding: '6px 8px', fontSize: '12px' }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>days</span>
          </div>
        )}
        <Btn
          variant={checkedIds.size > 0 ? 'gold' : 'default'}
          onClick={applyBulkAction}
          style={{ opacity: checkedIds.size === 0 ? 0.4 : 1, cursor: checkedIds.size === 0 ? 'not-allowed' : 'pointer', fontSize: '12px', padding: '6px 16px' }}
          disabled={checkedIds.size === 0 || bulkLoading}
        >
          {bulkLoading ? '...' : 'Apply'}
        </Btn>
        {checkedIds.size > 0 && (
          <button onClick={() => setCheckedIds(new Set())} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: '12px', marginLeft: '4px' }}>
            Clear
          </button>
        )}
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table cols={cols} rows={filtered} />
      </div>

      {modal === 'forceclose' && selected && (
        <Modal title={`Force Close All Trades – ${selected.full_name}`} onClose={closeModal}>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
            This will close all open trades on this account at current live price. Use for risk management.
          </p>
          <Inp label="REASON" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Risk management – suspected manipulation" />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="red" disabled={loading} onClick={() => doAction('accounts/force-close', { account_id: selected.id, reason: form.reason }, 'Trades force-closed')}>
              {loading ? 'Closing...' : 'Force Close All'}
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'time' && selected && (
        <Modal title={`Adjust Time Limit – ${selected.full_name}`} onClose={closeModal}>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>
            Current deadline: <strong style={{ color: 'var(--text)' }}>{fmtDate(selected.phase_end_date)}</strong>
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: '12px', marginBottom: '16px' }}>Positive = extend, negative = shorten</p>
          <Inp label="DAYS (e.g. 7 to extend, -3 to shorten)" type="number" value={form.days || ''} onChange={e => setForm({ ...form, days: e.target.value })} placeholder="e.g. 7" />
          <Inp label="REASON (optional)" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Trader requested extension" />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="accent" disabled={loading} onClick={() => doAction('accounts/adjust-time', { account_id: selected.id, days: parseInt(form.days), reason: form.reason }, 'Time limit updated')}>
              {loading ? 'Saving...' : 'Apply'}
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'reset' && selected && (
        <Modal title={`Reset Account – ${selected.full_name}`} onClose={closeModal}>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>
            This will restore the account to its original starting balance of <strong style={{ color: 'var(--text)' }}>{fmtUSD(selected.starting_balance)}</strong> and restart the clock.
          </p>
          <p style={{ color: 'var(--red)', fontSize: '12px', marginBottom: '16px' }}>âš  All existing trade history will be cancelled.</p>
          <Inp label="REASON" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Goodwill reset – technical issue" />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="green" disabled={loading} onClick={() => doAction('accounts/reset', { account_id: selected.id, reason: form.reason }, 'Account reset')}>
              {loading ? 'Resetting...' : 'Confirm Reset'}
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'promote' && selected && (
        <Modal title={`Manual Promotion – ${selected.full_name}`} onClose={closeModal}>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>
            Force-promote <strong style={{ color: 'var(--text)' }}>{selected.account_type.toUpperCase()}</strong> â†’ <strong style={{ color: 'var(--accent)' }}>{selected.account_type === 'phase1' ? 'PHASE 2' : 'FUNDED'}</strong> without requiring profit target.
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: '12px', marginBottom: '16px' }}>Account must be active. Current phase will be marked as passed.</p>
          <Inp label="REASON" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Partnership agreement" />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="cyan" disabled={loading} onClick={() => doAction('accounts/promote', { account_id: selected.id, reason: form.reason }, 'Account promoted')}>
              {loading ? 'Promoting...' : `Promote to ${selected.account_type === 'phase1' ? 'Phase 2' : 'Funded'}`}
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'flag' && selected && (
        <Modal title={`${selected.review_flagged ? 'Remove' : 'Set'} Review Flag – ${selected.full_name}`} onClose={closeModal}>
          {!selected.review_flagged
            ? <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>Flagging blocks automated pass/fail. You'll need to manually review this account before any phase transitions occur.</p>
            : <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>Removing the flag allows the automated engine to process this account normally again.</p>
          }
          {!selected.review_flagged && (
            <Inp label="FLAG REASON" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Suspicious trading pattern – manual review required" />
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant={selected.review_flagged ? 'green' : 'red'} disabled={loading}
              onClick={() => doAction('accounts/set-review-flag', { account_id: selected.id, flagged: !selected.review_flagged, reason: form.reason }, 'Flag updated')}>
              {loading ? 'Saving...' : selected.review_flagged ? 'Remove Flag' : 'Flag Account'}
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'lotoverride' && selected && (
        <Modal title={`Lot Limit Override – ${selected.full_name}`} onClose={closeModal}>
          <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '4px' }}>
            Account size: <strong style={{ color: 'var(--text)' }}>{fmtUSD(selected.account_size)}</strong>
          </p>
          <p style={{ color: 'var(--text-dim)', fontSize: '12px', marginBottom: '16px' }}>
            Standard limits: Forex {(parseFloat(selected.account_size) / 1000 * 0.20).toFixed(2)} lots | Commodity {(parseFloat(selected.account_size) / 1000 * 0.02).toFixed(4)} lots
          </p>
          <Inp label="MAX FOREX LOTS (leave blank to keep standard)" type="number" step="0.01"
            value={form.max_lots_forex || ''} onChange={e => setForm({ ...form, max_lots_forex: e.target.value })} placeholder="e.g. 5.00" />
          <Inp label="MAX COMMODITY LOTS (leave blank to keep standard)" type="number" step="0.001"
            value={form.max_lots_commodity || ''} onChange={e => setForm({ ...form, max_lots_commodity: e.target.value })} placeholder="e.g. 0.50" />
          <Inp label="REASON" value={form.reason || ''} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="e.g. Special arrangement – senior trader" />
          <div style={{ display: 'flex', gap: '8px' }}>
            <Btn variant="accent" disabled={loading}
              onClick={() => doAction('accounts/set-lot-override', {
                account_id: selected.id,
                max_lots_forex: form.max_lots_forex ? parseFloat(form.max_lots_forex) : null,
                max_lots_commodity: form.max_lots_commodity ? parseFloat(form.max_lots_commodity) : null,
                reason: form.reason
              }, 'Lot override saved')}>
              {loading ? 'Saving...' : 'Save Override'}
            </Btn>
            <Btn variant="red" disabled={loading}
              onClick={() => doAction('accounts/set-lot-override', { account_id: selected.id, max_lots_forex: null, max_lots_commodity: null }, 'Override removed')}>
              Remove Override
            </Btn>
            <Btn onClick={closeModal}>Cancel</Btn>
          </div>
        </Modal>
      )}

      {modal === 'notes' && selected && (
        <Modal title={`Account Notes – ${selected.full_name}`} onClose={closeModal}>
          <div style={{ marginBottom: '16px' }}>
            {notes.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>No notes yet.</p>}
            {notes.map(n => (
              <div key={n.id} style={{ background: 'var(--navy-hover)', borderRadius: '6px', padding: '10px 12px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between' }}>
                <div>
                  <div style={{ fontSize: '13px', color: 'var(--text)' }}>{n.note_text}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{fmtDateTime(n.created_at)}</div>
                </div>
                <button onClick={() => deleteNote(n.id)} style={{ background: 'none', border: 'none', color: 'var(--red)', cursor: 'pointer' }}>×</button>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input value={newNote} onChange={e => setNewNote(e.target.value)}
              placeholder="Add a note..." style={{ flex: 1, background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '9px 12px', color: 'var(--text)', fontSize: '13px' }}
              onKeyDown={e => e.key === 'Enter' && addNote()} />
            <Btn variant="accent" onClick={addNote}>Add</Btn>
          </div>
        </Modal>
      )}
    </div>
  )
}

// ─── PAYOUTS TAB ──────────────────────────────────────────────────────────────
function PayoutsTab({ payouts, onRefresh, showMsg }) {
  async function approve(payoutId) {
    const txId = window.prompt('Enter transaction ID (or leave blank):')
    if (txId === null) return
    try {
      await ax.post('/api/admin/payouts/approve', { payout_id: payoutId, transaction_id: txId || null })
      showMsg('Payout approved')
      onRefresh()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not approve', true)
    }
  }

  async function reject(payoutId) {
    if (!window.confirm('Reject this payout request?')) return
    try {
      await ax.post('/api/admin/payouts/reject', { payout_id: payoutId })
      showMsg('Payout rejected')
      onRefresh()
    } catch {
      showMsg('Could not reject', true)
    }
  }

  const cols = [
    { key: 'full_name',        label: 'Trader' },
    { key: 'trader_uid',       label: 'Trader ID', render: v => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px' }}>{v ? v.split('-')[0] : '—'}</span>
    )},
    { key: 'account_uid',      label: 'Account ID', render: v => (
      <span style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px' }}>{v ? v.split('-')[0] : '—'}</span>
    )},
    { key: 'amount_requested', label: 'Requested', render: v => fmtUSD(v) },
    { key: 'amount_payable',   label: 'Trader Gets', render: v => fmtUSD(v) },
    { key: 'payment_method',   label: 'Method' },
    { key: 'status',           label: 'Status', render: v => <StatusBadge status={v} /> },
    { key: 'requested_at',     label: 'Requested', render: v => fmtDate(v) },
    { key: '_actions', label: 'Action', render: (_, row) => (
      <div style={{ display: 'flex', gap: '6px' }}>
        {row.status === 'pending' && <>
          <Btn variant="green" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); approve(row.id) }}>Approve</Btn>
          <Btn variant="red"   style={{ padding: '3px 8px', fontSize: '11px' }} onClick={e => { e.stopPropagation(); reject(row.id) }}>Reject</Btn>
        </>}
      </div>
    )}
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ color: 'var(--text)' }}>Payouts ({payouts.length})</h2>
        <Btn variant="ghost" onClick={() => { const a = document.createElement('a'); a.href = `${API_URL}/api/admin/export/payouts`; a.click() }}>Export CSV</Btn>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table cols={cols} rows={payouts} />
      </div>
    </div>
  )
}

// ─── LIVE RISK DASHBOARD ──────────────────────────────────────────────────────
function RiskTab({ showMsg }) {
  const [data, setData]   = useState(null)
  const [loading, setLoading] = useState(true)
  // FIX: Declared priceStaleness state (no-undef)
  const [priceStaleness, setPriceStaleness] = useState(null)
  const intervalRef = useRef(null)

  const load = useCallback(async () => {
    try {
      const [riskRes, stalenessRes] = await Promise.all([
        ax.get('/api/admin/risk-dashboard'),
        ax.get('/api/admin/price-staleness').catch(() => ({ data: null }))
      ])
      setData(riskRes.data)
      setPriceStaleness(stalenessRes.data)
    } catch { showMsg('Could not load risk dashboard', true) }
    setLoading(false)
  }, [showMsg])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(load, 5000)
    return () => clearInterval(intervalRef.current)
  }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading risk data...</div>
  if (!data) return null

  const { exposure, total_open_trades, total_floating_pnl, near_breach_accounts, near_target_accounts, updated_at } = data

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ color: 'var(--text)' }}>Live Risk Dashboard</h2>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Auto-refresh every 5s • {new Date(updated_at).toLocaleTimeString()}</span>
          <Btn variant="ghost" onClick={load}>↻ Refresh</Btn>
        </div>
      </div>

      {priceStaleness?.any_stale && (
        <div style={{ background: '#ff475722', border: '1px solid #ff4757', borderRadius: '8px', padding: '12px 16px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '18px' }}>âš ï¸</span>
          <div>
            <div style={{ color: '#ff4757', fontWeight: '700', fontSize: '13px' }}>PRICE FEED STALE</div>
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>
              {priceStaleness.stale_count} instrument(s) have not updated in over 30 seconds. Trading may be affected.
            </div>
          </div>
        </div>
      )}

      {/* Top stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: '12px', marginBottom: '20px' }}>
        <StatCard label="Open Trades" value={total_open_trades} color="var(--text)" />
        <StatCard label="Total Floating P&L" value={fmtUSD(total_floating_pnl)} color={total_floating_pnl >= 0 ? COLOR_POS : COLOR_NEG} />
        <StatCard label="Near DD Breach" value={near_breach_accounts.length} color="var(--red)" />
        <StatCard label="Near Profit Target" value={near_target_accounts.length} color="var(--green)" />
      </div>

      {/* Exposure table */}
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden', marginBottom: '20px' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--navy-border)' }}>
          <h3 style={{ color: 'var(--text)', margin: 0 }}>Net Exposure by Instrument</h3>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'var(--navy-hover)' }}>
              {['Instrument', 'Buy Lots', 'Sell Lots', 'Net Lots', 'Floating P&L', 'Trades', 'You Need to Hedge'].map(h => (
                <th key={h} style={{ padding: '10px 14px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px', letterSpacing: '0.06em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {exposure.map(row => (
              <tr key={row.instrument} style={{ borderTop: '1px solid var(--navy-hover)' }}>
                <td style={{ padding: '12px 14px', fontWeight: 700, color: 'var(--text)' }}>{row.instrument}</td>
                <td style={{ padding: '12px 14px', color: 'var(--green)' }}>{row.buy_lots}</td>
                <td style={{ padding: '12px 14px', color: 'var(--red)' }}>{row.sell_lots}</td>
                <td style={{ padding: '12px 14px', fontWeight: 700, color: row.net_lots >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {row.net_lots >= 0 ? '+' : ''}{row.net_lots}
                </td>
                <td style={{ padding: '12px 14px', color: row.floating_pnl >= 0 ? COLOR_POS : COLOR_NEG }}>
                  {row.floating_pnl >= 0 ? '+' : ''}{fmtUSD(row.floating_pnl)}
                </td>
                <td style={{ padding: '12px 14px' }}>{row.trade_count}</td>
                <td style={{ padding: '12px 14px' }}>
                  {row.reverse_lots > 0 ? (
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                      {row.reverse_direction.toUpperCase()} {row.reverse_lots} lots
                    </span>
                  ) : <span style={{ color: 'var(--text-dim)' }}>Balanced</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        <div style={{ background: 'var(--navy-card)', border: '1px solid #c0392b44', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--navy-border)', background: '#c0392b0a' }}>
            <h3 style={{ color: 'var(--red)', margin: 0 }}>âš  Near Drawdown Breach (≥70% used)</h3>
          </div>
          {near_breach_accounts.length === 0
            ? <p style={{ padding: '20px', color: 'var(--text-dim)', fontSize: '13px' }}>All clear – no accounts near breach.</p>
            : near_breach_accounts.map(a => (
              <div key={a.account_id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--navy-hover)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>{a.trader}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.account_type.toUpperCase()} • {fmtUSD(a.account_size)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: 'var(--red)', fontWeight: 700 }}>{fmtPct(a.drawdown_pct)} / {fmtPct(a.max_dd_pct)}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Equity {fmtUSD(a.equity)}</div>
                  </div>
                </div>
                <div style={{ marginTop: '8px', background: 'var(--navy-hover)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(a.dd_used_pct, 100)}%`, height: '100%', background: a.dd_used_pct >= 90 ? 'var(--red)' : 'var(--text)', borderRadius: '4px', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>{fmtPct(a.dd_used_pct)} of limit used</div>
              </div>
            ))
          }
        </div>

        <div style={{ background: 'var(--navy-card)', border: '1px solid #1a7a4a44', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--navy-border)', background: '#1a7a4a0a' }}>
            <h3 style={{ color: 'var(--green)', margin: 0 }}>🎯 Near Profit Target (≥70% reached)</h3>
          </div>
          {near_target_accounts.length === 0
            ? <p style={{ padding: '20px', color: COLOR_MUTED, fontSize: '13px' }}>No accounts near their target.</p>
            : near_target_accounts.map(a => (
              <div key={a.account_id} style={{ padding: '12px 16px', borderBottom: '1px solid var(--navy-hover)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: 'var(--text)' }}>{a.trader}</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.account_type.toUpperCase()} • {fmtUSD(a.account_size)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: COLOR_POS, fontWeight: 700 }}>{fmtPct(a.profit_pct)} of target</div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Target {fmtUSD(a.profit_target)}</div>
                  </div>
                </div>
                <div style={{ marginTop: '8px', background: 'var(--navy-hover)', borderRadius: '4px', height: '6px', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(a.profit_pct, 100)}%`, height: '100%', background: COLOR_POS, borderRadius: '4px' }} />
                </div>
              </div>
            ))
          }
        </div>
      </div>
    </div>
  )
}

// ─── MISSING TAB STUBS ────────────────────────────────────────────────────────
// FIX: Added all missing tab components (react/jsx-no-undef)
// Replace each stub body with your real implementation when ready.

function SuspiciousTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/suspicious-accounts')
      .then(r => setData(r.data))
      .catch(() => showMsg('Could not load suspicious accounts', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Scanning...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>🚨 Suspicious Activity</h2>
      {!data || data.total_flags === 0
        ? <div style={{ color: 'var(--text-dim)', padding: '20px' }}>No suspicious activity detected.</div>
        : data.flagged.map((item, i) => (
          <div key={i} style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px 20px', marginBottom: '12px' }}>
            <div style={{ fontWeight: 700, color: COLOR_NEG, marginBottom: '6px' }}>{item.flag_label}</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              {item.full_name && <span>{item.full_name} · {item.email} · {item.account_type?.toUpperCase()}</span>}
              {item.emails && <span>{item.emails.join(', ')}</span>}
            </div>
          </div>
        ))
      }
    </div>
  )
}

function BBookTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/bbook-report')
      .then(r => setData(r.data))
      .catch(() => showMsg('Could not load B-Book report', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading B-Book report...</div>
  if (!data) return null

  const { totals } = data
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📊 B-Book Report</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: '12px', marginBottom: '24px' }}>
        <StatCard label="Total Trader Losses" value={fmtUSD(totals.total_trader_losses)} color={COLOR_POS} />
        <StatCard label="Total Trader Profits" value={fmtUSD(totals.total_trader_profits)} color={COLOR_NEG} />
        <StatCard label="Total Paid Out" value={fmtUSD(totals.total_paid_out)} color={COLOR_NEG} />
        <StatCard label="Net Firm P&L" value={fmtUSD(totals.net_firm_pnl)} color={parseFloat(totals.net_firm_pnl) >= 0 ? COLOR_POS : COLOR_NEG} />
        <StatCard label="Accounts Failed" value={totals.total_failed} color={COLOR_NEG} />
        <StatCard label="Funded Active" value={totals.total_funded_active} color={COLOR_POS} />
      </div>
    </div>
  )
}

function AuditLogTab({ showMsg }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/audit-log')
      .then(r => setEntries(r.data.entries || []))
      .catch(() => showMsg('Could not load audit log', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  const cols = [
    { key: 'created_at',  label: 'Time',        render: v => fmtDateTime(v) },
    { key: 'action',      label: 'Action' },
    { key: 'entity_type', label: 'Entity' },
    { key: 'entity_id',   label: 'ID' },
    { key: 'details',     label: 'Details',      render: v => <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{JSON.stringify(v).slice(0, 80)}</span> },
  ]

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📋 Audit Log</h2>
      {loading
        ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={entries} />
          </div>
      }
    </div>
  )
}

function SettingsLogTab({ showMsg }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/settings-log')
      .then(r => setEntries(r.data || []))
      .catch(() => showMsg('Could not load settings log', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  const cols = [
    { key: 'changed_at', label: 'Time',      render: v => fmtDateTime(v) },
    { key: 'key',        label: 'Setting' },
    { key: 'old_value',  label: 'Old Value' },
    { key: 'new_value',  label: 'New Value' },
  ]

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📋 Settings Log</h2>
      {loading
        ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={entries} />
          </div>
      }
    </div>
  )
}

function PlatformAnalyticsTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/platform-analytics')
      .then(r => setData(r.data))
      .catch(() => showMsg('Could not load analytics', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading analytics...</div>
  if (!data) return null

  const { funnel } = data
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📊 Platform Analytics</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: '12px', marginBottom: '24px' }}>
        <StatCard label="Phase 1 Total"  value={funnel.phase1_total} />
        <StatCard label="Phase 1 Passed" value={funnel.phase1_passed} color={COLOR_POS} />
        <StatCard label="Phase 2 Total"  value={funnel.phase2_total} />
        <StatCard label="Phase 2 Passed" value={funnel.phase2_passed} color={COLOR_POS} />
        <StatCard label="Funded Total"   value={funnel.funded_total} color={COLOR_ACCENT} />
        <StatCard label="Funded Active"  value={funnel.funded_active} color={COLOR_POS} />
      </div>
    </div>
  )
}

function PriceFeedTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/price-feed-health')
      setData(r.data)
    } catch { showMsg('Could not load price feed', true) }
    setLoading(false)
  }, [showMsg])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5000)
    return () => clearInterval(iv)
  }, [load])

  const cols = [
    { key: 'instrument',           label: 'Instrument' },
    { key: 'bid',                  label: 'Bid' },
    { key: 'ask',                  label: 'Ask' },
    { key: 'seconds_since_update', label: 'Seconds Old' },
    { key: 'ticks_last_5min',      label: 'Ticks (5m)' },
    { key: 'status',               label: 'Status', render: v => <StatusBadge status={v} /> },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ color: 'var(--text)' }}>📡 Price Feed Health</h2>
        <Btn variant="ghost" onClick={load}>↻ Refresh</Btn>
      </div>
      {loading
        ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={data?.instruments || []} />
          </div>
      }
    </div>
  )
}

function RiskScoreTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    ax.get('/api/admin/risk-scores')
      .then(r => setRows(r.data || []))
      .catch(() => showMsg('Could not load risk scores', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  const cols = [
    { key: 'full_name',     label: 'Trader' },
    { key: 'email',         label: 'Email' },
    { key: 'risk_score',    label: 'Risk Score', render: v => (
      <span style={{ fontWeight: 700, color: v >= 60 ? COLOR_NEG : v >= 30 ? COLOR_ACCENT : COLOR_POS }}>{v}</span>
    )},
    { key: 'win_rate_pct',  label: 'Win Rate',   render: v => fmtPct(v) },
    { key: 'avg_hold_seconds', label: 'Avg Hold (s)' },
    { key: 'total_trades',  label: 'Trades' },
    { key: 'flagged_payouts', label: 'Flagged Payouts' },
  ]

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>🎯 Risk Scores</h2>
      {loading
        ? <div style={{ color: 'var(--text-muted)' }}>Calculating...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={rows} />
          </div>
      }
    </div>
  )
}

function ScalingPlanTab({ accounts, showMsg }) {
  const [selected, setSelected] = useState(null)
  const [planData, setPlanData] = useState(null)
  const [applying, setApplying] = useState(false)

  const fundedAccounts = accounts.filter(a => a.account_type === 'funded' && a.status === 'active')

  async function loadPlan(accountId) {
    try {
      const r = await ax.get(`/api/admin/scaling-plan/${accountId}`)
      setPlanData(r.data)
    } catch { showMsg('Could not load scaling plan', true) }
  }

  async function applyTier(tier) {
    if (!selected || !window.confirm(`Apply ${tier.label} to this account?`)) return
    setApplying(true)
    try {
      const r = await ax.post('/api/admin/scaling-plan/apply', { account_id: selected, tier: tier.tier })
      showMsg(r.data.message)
      loadPlan(selected)
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not apply tier', true)
    }
    setApplying(false)
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📈 Scaling Plan</h2>
      <div style={{ marginBottom: '16px' }}>
        <select onChange={e => { setSelected(e.target.value); loadPlan(e.target.value) }}
          style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', color: 'var(--text)', borderRadius: '8px', padding: '8px 12px', fontSize: '13px' }}>
          <option value="">Select a funded account...</option>
          {fundedAccounts.map(a => (
            <option key={a.id} value={a.id}>{a.full_name} – {fmtUSD(a.account_size)}</option>
          ))}
        </select>
      </div>
      {planData && (
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '20px' }}>
          <div style={{ marginBottom: '16px' }}>
            <span style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Profitable months: </span>
            <strong style={{ color: 'var(--text)' }}>{planData.profitable_months}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: '13px', marginLeft: '16px' }}>Current tier: </span>
            <strong style={{ color: COLOR_ACCENT }}>{planData.current_tier.label}</strong>
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            {planData.tiers.map(tier => (
              <Btn key={tier.tier} variant={tier.tier === planData.current_tier.tier ? 'accent' : 'ghost'}
                disabled={applying}
                onClick={() => applyTier(tier)}>
                {tier.label} ({tier.multiplier}x)
              </Btn>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── LIVE CHAT TAB ────────────────────────────────────────────────────────────
function ChatTab({ showMsg }) {
  const [conversations, setConversations] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedConv, setSelectedConv] = useState(null)
  const [messages, setMessages] = useState([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [stats, setStats] = useState(null)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const bottomRef = useRef()
  const socketRef = useRef(null)

  const limit = 20

  // Load stats
  async function loadStats() {
    try {
      const res = await ax.get('/api/chat/admin/chat-stats')
      setStats(res.data)
    } catch (err) {}
  }

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      const res = await ax.get(`/api/chat/admin/conversations?status=${filter}&page=${page}&limit=${limit}`)
      setConversations(res.data.conversations || [])
      setTotal(res.data.total || 0)
      setLoading(false)
    } catch (err) {
      showMsg('Could not load conversations', true)
      setLoading(false)
    }
  }, [filter, page, showMsg])

  useEffect(() => { loadConversations(); loadStats() }, [loadConversations])

  // Socket for real-time messages
  useEffect(() => {
    socketRef.current = require('socket.io-client')(API_URL, { withCredentials: true })
    
    socketRef.current.on('chat_new_message', (data) => {
      if (selectedConv && data.conversation_id === selectedConv.id) {
        setMessages(prev => [...prev, data.message])
        setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
      }
      loadConversations()
      loadStats()
    })

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect()
      }
    }
  }, [selectedConv, loadConversations])

  // Load conversation messages
  async function openChat(conv) {
    try {
      const res = await ax.get(`/api/chat/admin/conversations/${conv.id}`)
      setMessages(res.data.messages || [])
      setSelectedConv(res.data.conversation)
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      showMsg('Could not load conversation', true)
    }
  }

  // Send message
  async function handleSend() {
    if (!reply.trim() || !selectedConv) return
    setSending(true)
    try {
      await ax.post(`/api/chat/admin/conversations/${selectedConv.id}/messages`, { message: reply })
      setReply('')
      // Message will arrive via socket
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {
      showMsg('Failed to send message', true)
    }
    setSending(false)
  }

  // Update status
  async function updateStatus(id, newStatus) {
    try {
      await ax.patch(`/api/chat/admin/conversations/${id}`, { status: newStatus })
      showMsg('Conversation updated')
      loadConversations()
      loadStats()
      if (selectedConv && selectedConv.id === id) {
        setSelectedConv({...selectedConv, status: newStatus})
      }
    } catch (err) {
      showMsg('Update failed', true)
    }
  }

  // Assign to me
  async function assignToMe(id) {
    try {
      await ax.patch(`/api/chat/admin/conversations/${id}`, { assigned_to: 'me' })
      showMsg('Assigned to you')
      loadConversations()
    } catch (err) {
      showMsg('Assign failed', true)
    }
  }

  const cols = [
    { key: 'created_at', label: 'Date', render: v => fmtDateTime(v) },
    { key: 'user', label: 'User', render: (_, row) => (
        <div>
          <b>{row.user_name || 'Unknown'}</b>
          <br/>
          <span style={{fontSize:'11px', color:'var(--text-muted)'}}>{row.user_email}</span>
        </div>
      )
    },
    { key: 'subject', label: 'Subject', render: (v, row) => <b>{v}</b> },
    { key: 'status', label: 'Status', render: v => <StatusBadge status={v==='open' ? 'open' : v==='pending' ? 'pending' : v==='resolved' ? 'approved' : 'rejected'} /> },
    { key: 'last_message', label: 'Last Message', render: v => (
        <span style={{fontSize:'12px', color:'var(--text-muted)', maxWidth:'200px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block'}}>
          {v || 'No messages'}
        </span>
      )
    },
    { key: 'unread', label: 'Unread', render: (_, row) => (
        row.unread_user_count > 0 ? (
          <span style={{background:'var(--red)', color:'white', padding:'2px 8px', borderRadius:'10px', fontSize:'11px', fontWeight:'600'}}>
            {row.unread_user_count}
          </span>
        ) : <span style={{color:'var(--text-muted)'}}>—</span>
      )
    },
    { key: 'actions', label: 'Actions', render: (_, row) => (
       <div style={{display:'flex', gap:'5px'}}>
         <Btn variant="accent" onClick={() => openChat(row)}>Chat</Btn>
         {row.status === 'open' && <Btn variant="ghost" onClick={() => assignToMe(row.id)}>Assign</Btn>}
         {row.status !== 'resolved' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'resolved')}>Resolve</Btn>}
         {row.status !== 'closed' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'closed')}>Close</Btn>}
       </div>
    )}
  ]

  if (selectedConv) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '75vh', border:'1px solid var(--navy-border)', borderRadius:'12px', background:'var(--navy-card)', overflow:'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--navy-border)', display: 'flex', alignItems: 'center', background:'rgba(16, 24, 40, 0.4)', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button onClick={() => setSelectedConv(null)} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', marginRight:'16px', fontSize:'24px', lineHeight:'1' }}>”¹</button>
            <div>
              <h3 style={{ margin: 0, color: 'var(--text)', fontSize:'16px' }}>{selectedConv.subject}</h3>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop:'4px' }}>
                Chat #{selectedConv.id} • {selectedConv.user_name} ({selectedConv.user_email}) • {selectedConv.status.toUpperCase()}
              </div>
            </div>
          </div>
          <div style={{display:'flex', gap:'5px'}}>
            {selectedConv.status !== 'resolved' && <Btn variant="ghost" onClick={() => updateStatus(selectedConv.id, 'resolved')}>Set Resolved</Btn>}
            {selectedConv.status !== 'closed' && <Btn variant="ghost" onClick={() => updateStatus(selectedConv.id, 'closed')}>Set Closed</Btn>}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display:'flex', flexDirection:'column', gap:'12px', background:'rgba(16, 24, 40, 0.2)' }}>
          {messages.map((msg, idx) => {
            const isAdmin = msg.is_admin
            const showDate = idx === 0 || new Date(messages[idx-1]?.created_at).toDateString() !== new Date(msg.created_at).toDateString()
            return (
              <React.Fragment key={msg.id}>
                {showDate && (
                  <div style={{textAlign:'center', color:'var(--text-muted)', fontSize:'11px', margin:'8px 0'}}>
                    {new Date(msg.created_at).toLocaleDateString()}
                  </div>
                )}
                <div style={{ alignSelf: isAdmin ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                  <div style={{ fontSize:'11px', color:'var(--text-muted)', marginBottom:'4px', marginLeft:'4px', textAlign: isAdmin ? 'right' : 'left' }}>
                    {isAdmin ? 'Support' : (selectedConv.user_name || 'User')} • {new Date(msg.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}
                  </div>
                  <div style={{ 
                    background: isAdmin ? 'rgba(41, 98, 255, 0.2)' : 'var(--navy)', 
                    color: 'var(--text)', 
                    padding: '12px 16px', 
                    borderRadius: '16px', 
                    borderBottomRightRadius: isAdmin ? '4px' : '16px',
                    borderBottomLeftRadius: isAdmin ? '16px' : '4px',
                    lineHeight:'1.5', 
                    whiteSpace:'pre-wrap',
                    border: isAdmin ? '1px solid rgba(41, 98, 255, 0.3)' : '1px solid var(--navy-border)'
                  }}>
                    {msg.message}
                  </div>
                </div>
              </React.Fragment>
            )
          })}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: '16px 20px', borderTop: '1px solid var(--navy-border)', background:'rgba(16, 24, 40, 0.4)' }}>
          <div style={{ display: 'flex', gap: '10px' }}>
            <input
              value={reply}
              onChange={e => setReply(e.target.value)}
              onKeyPress={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), handleSend())}
              placeholder="Type your reply..."
              disabled={sending || selectedConv.status === 'closed'}
              style={{
                flex: 1,
                background: 'var(--navy)',
                border: '1px solid var(--navy-border)',
                borderRadius: '8px',
                padding: '12px 16px',
                color: 'var(--text)',
                fontSize: '14px',
                outline: 'none'
              }}
            />
            <Btn variant="accent" onClick={handleSend} disabled={sending || !reply.trim() || selectedConv.status === 'closed'}>
              {sending ? 'Sending...' : 'Send'}
            </Btn>
          </div>
          {selectedConv.status === 'closed' && (
            <div style={{fontSize:'12px', color:'var(--text-muted)', marginTop:'8px', textAlign:'center'}}>
              This conversation is closed
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ marginBottom: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ color: 'var(--text)', margin: 0 }}>💬 Live Chat Support</h3>
        {stats && (
          <div style={{ display: 'flex', gap: '12px' }}>
            <span style={{fontSize:'13px', color:'var(--text-muted)'}}>
              Open: <b style={{color:'var(--accent)'}}>{stats.open_count}</b>
            </span>
            <span style={{fontSize:'13px', color:'var(--text-muted)'}}>
              Unread: <b style={{color:'var(--red)'}}>{stats.unread_count}</b>
            </span>
            <span style={{fontSize:'13px', color:'var(--text-muted)'}}>
              24h Messages: <b style={{color:'var(--green)'}}>{stats.messages_24h}</b>
            </span>
          </div>
        )}
      </div>

      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
        {['', 'open', 'pending', 'resolved', 'closed'].map(s => (
          <Btn
            key={s || 'all'}
            variant={filter === s ? 'accent' : 'ghost'}
            onClick={() => { setFilter(s); setPage(1) }}
          >
            {s ? s.toUpperCase() : 'ALL'}
          </Btn>
        ))}
      </div>

      {loading ? (
        <div style={{padding:'40px', textAlign:'center', color:'var(--text-muted)'}}>Loading conversations...</div>
      ) : conversations.length === 0 ? (
        <div style={{padding:'40px', textAlign:'center', color:'var(--text-muted)'}}>
          No conversations found
        </div>
      ) : (
        <>
          <div style={{overflowX: 'auto'}}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--navy-border)', textAlign: 'left' }}>
                  {cols.map(c => (
                    <th key={c.key} style={{ padding: '10px 12px', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.05em' }}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {conversations.map(row => (
                  <tr key={row.id} style={{ borderBottom: '1px solid var(--navy-border)' }}>
                    {cols.map(c => (
                      <td key={c.key} style={{ padding: '12px', color: 'var(--text)' }}>
                        {c.render ? c.render(row[c.key], row) : row[c.key]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '8px', marginTop: '20px' }}>
            <Btn variant="ghost" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>
              Previous
            </Btn>
            <span style={{ padding: '8px 16px', color: 'var(--text-muted)' }}>
              Page {page} of {Math.ceil(total / limit)}
            </span>
            <Btn variant="ghost" onClick={() => setPage(p => p + 1)} disabled={page >= Math.ceil(total / limit)}>
              Next
            </Btn>
          </div>
        </>
      )}
    </div>
  )
}



function SupportTab({ showMsg }) {
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedTicket, setSelectedTicket] = useState(null)
  const [messages, setMessages] = useState([])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef()

  const loadTickets = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/support-tickets')
      setTickets(r.data)
    } catch { showMsg('Could not load tickets', true) }
    setLoading(false)
  }, [showMsg])

  useEffect(() => { loadTickets() }, [loadTickets])

  async function loadThread(ticketId) {
    try {
      const res = await ax.get(`/api/admin/support-tickets/${ticketId}`)
      setMessages(res.data || [])
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 100)
    } catch (err) {}
  }

  async function openChat(ticket) {
    setSelectedTicket(ticket)
    setMessages([])
    await loadThread(ticket.id)
  }

  async function handleSend() {
    if (!reply.trim()) return
    setSending(true)
    try {
      await ax.post(`/api/admin/support-tickets/${selectedTicket.id}/reply`, { message: reply })
      setReply('')
      await loadThread(selectedTicket.id)
      loadTickets()
    } catch {}
    setSending(false)
  }

  async function updateStatus(id, newStatus) {
    try {
      await ax.patch(`/api/admin/support-tickets/${id}`, { status: newStatus })
      showMsg('Ticket updated')
      loadTickets()
      if (selectedTicket && selectedTicket.id === id) {
        setSelectedTicket({...selectedTicket, status: newStatus})
      }
    } catch (err) {
      showMsg('Update failed', true)
    }
  }

  const cols = [
    { key: 'created_at', label: 'Date', render: v => fmtDateTime(v) },
    { key: 'email', label: 'User', render: (v, row) => <div><b>{row.name || 'Unknown'}</b><br/><span style={{fontSize:'11px', color:'var(--text-muted)'}}>{v}</span></div> },
    { key: 'category', label: 'Category', render: v => String(v).toUpperCase() },
    { key: 'subject', label: 'Subject', render: (v, row) => <b>{v}</b> },
    { key: 'status', label: 'Status', render: v => <StatusBadge status={v==='open' ? 'pending' : v==='resolved' ? 'approved' : 'rejected'} /> },
    { key: 'actions', label: 'Actions', render: (_, row) => (
       <div style={{display:'flex', gap:'5px'}}>
         <Btn variant="accent" onClick={() => openChat(row)}>Chat</Btn>
         {row.status !== 'resolved' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'resolved')}>Resolve</Btn>}
         {row.status !== 'closed' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'closed')}>Close</Btn>}
       </div>
    )}
  ]

  if (selectedTicket) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '75vh', border:'1px solid var(--navy-border)', borderRadius:'12px', background:'var(--navy-card)', overflow:'hidden' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--navy-border)', display: 'flex', alignItems: 'center', background:'rgba(16, 24, 40, 0.4)', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <button onClick={() => setSelectedTicket(null)} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', marginRight:'16px', fontSize:'24px', lineHeight:'1' }}>”¹</button>
            <div>
              <h3 style={{ margin: 0, color: 'var(--text)', fontSize:'16px' }}>{selectedTicket.subject}</h3>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop:'4px' }}>Ticket #{selectedTicket.id} • {selectedTicket.name} ({selectedTicket.email}) • {selectedTicket.status.toUpperCase()}</div>
            </div>
          </div>
          <div style={{display:'flex', gap:'5px'}}>
            {selectedTicket.status !== 'resolved' && <Btn variant="ghost" onClick={() => updateStatus(selectedTicket.id, 'resolved')}>Set Resolved</Btn>}
            {selectedTicket.status !== 'closed' && <Btn variant="ghost" onClick={() => updateStatus(selectedTicket.id, 'closed')}>Set Closed</Btn>}
          </div>
        </div>
        
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display:'flex', flexDirection:'column', gap:'16px' }}>
          {/* Original message */}
          <div style={{ alignSelf: 'flex-start', maxWidth: '75%' }}>
            <div style={{ fontSize:'11px', color:'var(--text-muted)', marginBottom:'4px', marginLeft:'4px' }}>{selectedTicket.name || 'User'} • {fmtDateTime(selectedTicket.created_at)}</div>
            <div style={{ background: 'var(--navy)', color: 'var(--text)', padding: '12px 16px', borderRadius: '16px', borderBottomLeftRadius: '4px', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
              {selectedTicket.message}
            </div>
          </div>

          {messages.map(m => (
            <div key={m.id} style={{ alignSelf: m.sender_type === 'admin' ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
              <div style={{ fontSize:'11px', color:'var(--text-muted)', marginBottom:'4px', marginLeft: m.sender_type === 'admin' ? 0 : '4px', marginRight: m.sender_type === 'admin' ? '4px' : 0, textAlign: m.sender_type === 'admin' ? 'right' : 'left' }}>
                {m.sender_name || (m.sender_type==='admin'?'Support Team':selectedTicket.name)} • {fmtDateTime(m.created_at)}
              </div>
              <div style={{ background: m.sender_type === 'admin' ? 'var(--accent)' : 'var(--navy)', color: m.sender_type === 'admin' ? '#fff' : 'var(--text)', padding: '12px 16px', borderRadius: '16px', borderBottomRightRadius: m.sender_type === 'admin' ? '4px' : '16px', borderBottomLeftRadius: m.sender_type === 'user' ? '4px' : '16px', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
                {m.message}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div style={{ padding: '16px', borderTop: '1px solid var(--navy-border)', background:'rgba(16, 24, 40, 0.4)' }}>
          <div style={{ display: 'flex', gap: '12px' }}>
            <input 
               value={reply} 
               onChange={e => setReply(e.target.value)} 
               onKeyDown={e => e.key === 'Enter' && handleSend()}
               autoFocus
               placeholder="Type admin reply..." 
               style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', border: '1px solid var(--navy-border)', background: 'var(--navy)', color: 'var(--text)', outline: 'none' }} 
            />
            <button 
               onClick={handleSend} 
               disabled={sending} 
               style={{ padding: '0 24px', borderRadius: '24px', background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer' }}>
               Send
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
         <h2 style={{ color: 'var(--text)', margin: 0 }}>🎧 Support Tickets</h2>
         <Btn variant="ghost" onClick={loadTickets}>↻ Refresh</Btn>
      </div>
      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={tickets} />
          </div>}
    </div>
  )
}

function DisputesAdminTab({ showMsg }) {
  const [disputes, setDisputes] = useState([])
  const [loading, setLoading] = useState(true)

  const loadDisputes = useCallback(async () => {
    try {
      const r = await ax.get('/api/disputes/all')
      setDisputes(r.data)
    } catch { showMsg('Could not load disputes', true) }
    setLoading(false)
  }, [showMsg])

  useEffect(() => { loadDisputes() }, [loadDisputes])

  async function updateStatus(id, newStatus) {
    const reply = window.prompt(`Enter admin reply for placing dispute to ${newStatus}:`)
    if (reply === null) return // cancelled
    try {
      await ax.patch(`/api/disputes/${id}`, { status: newStatus, admin_reply: reply })
      showMsg('Dispute updated')
      loadDisputes()
    } catch (err) { showMsg(err.response?.data?.error || 'Update failed', true) }
  }

  const cols = [
    { key: 'created_at', label: 'Date', render: v => fmtDateTime(v) },
    { key: 'user_email', label: 'Trader', render: (v, row) => <div><b>{row.full_name || 'Unknown'}</b><br/><span style={{fontSize:'11px', color:'var(--text-muted)'}}>{v}</span></div> },
    { key: 'account_id', label: 'Account ID', render: v => <span style={{ fontFamily: 'monospace', fontSize: '11px' }}>{v || '—'}</span> },
    { key: 'reason', label: 'Reason / Description', render: (v, row) => (
      <details style={{cursor:'pointer'}}>
        <summary style={{fontWeight:600}}>{v}</summary>
        <div style={{marginTop:'8px', padding:'10px', background:'var(--navy)', borderRadius:'6px', fontSize:'13px', whiteSpace:'pre-wrap'}}>
          {row.description}
          {row.admin_reply && (
             <div style={{marginTop:'12px', paddingTop:'8px', borderTop:'1px solid var(--navy-border)', color:'var(--accent)'}}>
               <b>Admin Reply:</b> {row.admin_reply}
             </div>
          )}
        </div>
      </details>
    )},
    { key: 'status', label: 'Status', render: v => <StatusBadge status={v==='open' ? 'pending' : v==='resolved' ? 'approved' : 'rejected'} /> },
    { key: 'actions', label: 'Actions', render: (_, row) => (
       <div style={{display:'flex', gap:'5px'}}>
         {row.status !== 'resolved' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'resolved')}>Resolve</Btn>}
         {row.status !== 'rejected' && <Btn variant="ghost" onClick={() => updateStatus(row.id, 'rejected')}>Reject</Btn>}
       </div>
    )}
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
         <h2 style={{ color: 'var(--text)', margin: 0 }}>⚖️ Disputes</h2>
         <Btn variant="ghost" onClick={loadDisputes}>↻ Refresh</Btn>
      </div>
      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div>
        : <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table cols={cols} rows={disputes} />
          </div>}
    </div>
  )
}

function CopierTab({ showMsg }) {
  const [loading, setLoading]         = useState(true)
  const [refreshing, setRefreshing]   = useState(false)
  const [saving, setSaving]           = useState(false)
  const [openTrades, setOpenTrades]   = useState([])
  const [stats, setStats]             = useState({ open_trades: 0, closed_last_hour: 0, closed_last_24h: 0 })
  const [config, setConfig]           = useState({
    enabled: true,
    mode: 'mirror',
    lot_multiplier: '1',
    only_funded: true
  })

  useEffect(() => {
    loadCopierData()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMsg])

  async function loadCopierData(isManualRefresh = false) {
    if (isManualRefresh) setRefreshing(true)
    else setLoading(true)

    try {
      const [statusRes, tradesRes] = await Promise.all([
        ax.get('/api/admin/copier/status'),
        ax.get('/api/admin/copier/open-trades')
      ])

      const cfg = statusRes?.data?.config || {}
      const s = statusRes?.data?.stats || {}

      setConfig({
        enabled: cfg.enabled !== false,
        mode: cfg.mode === 'reverse' ? 'reverse' : 'mirror',
        lot_multiplier: String(cfg.lot_multiplier ?? 1),
        only_funded: cfg.only_funded !== false
      })
      setStats({
        open_trades: Number(s.open_trades || 0),
        closed_last_hour: Number(s.closed_last_hour || 0),
        closed_last_24h: Number(s.closed_last_24h || 0)
      })
      setOpenTrades(Array.isArray(tradesRes?.data) ? tradesRes.data : [])

      if (isManualRefresh) showMsg('Copier status refreshed')
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not load copier data', true)
    }

    if (isManualRefresh) setRefreshing(false)
    else setLoading(false)
  }

  async function saveConfig() {
    const lm = parseFloat(config.lot_multiplier)
    if (isNaN(lm) || lm <= 0 || lm > 10) {
      showMsg('Lot multiplier must be between 0.01 and 10', true)
      return
    }

    setSaving(true)
    try {
      await ax.post('/api/admin/copier/config', {
        enabled: config.enabled,
        mode: config.mode,
        lot_multiplier: lm,
        only_funded: config.only_funded
      })
      showMsg('Copier config saved')
      loadCopierData(true)
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save copier config', true)
    }
    setSaving(false)
  }

  const tradeCols = [
    { key: 'instrument', label: 'Instrument', render: v => <span style={{ fontFamily: 'DM Mono, monospace' }}>{v || '—'}</span> },
    { key: 'direction', label: 'Direction', render: v => <StatusBadge status={String(v || '').toLowerCase() === 'buy' ? 'approved' : 'rejected'} /> },
    { key: 'lot_size', label: 'Lots', render: v => fmt(v, 2) },
    { key: 'open_price', label: 'Open', render: v => fmt(v, 5) },
    { key: 'stop_loss', label: 'SL', render: v => v ? fmt(v, 5) : '—' },
    { key: 'take_profit', label: 'TP', render: v => v ? fmt(v, 5) : '—' },
    { key: 'account_type', label: 'Account', render: v => <StatusBadge status={v || 'active'} /> },
    { key: 'email', label: 'Trader' },
    { key: 'open_time', label: 'Opened', render: v => fmtDateTime(v) }
  ]

  if (loading) {
    return <div style={{ color: 'var(--text-muted)', padding: '30px' }}>Loading copier status...</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '10px', flexWrap: 'wrap' }}>
        <h2 style={{ color: 'var(--text)', margin: 0 }}>🔄 Trade Copier</h2>
        <div style={{ display: 'flex', gap: '8px' }}>
          <Btn variant="ghost" onClick={() => loadCopierData(true)} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </Btn>
          <Btn variant="accent" onClick={saveConfig} disabled={saving}>
            {saving ? 'Saving...' : 'Save Config'}
          </Btn>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: '12px', marginBottom: '18px' }}>
        <StatCard label="Open Trades" value={stats.open_trades} color={COLOR_ACCENT} />
        <StatCard label="Closed (1h)" value={stats.closed_last_hour} color={COLOR_POS} />
        <StatCard label="Closed (24h)" value={stats.closed_last_24h} color={COLOR_POS} />
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px 18px', marginBottom: '18px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '14px', alignItems: 'end' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>COPIER ENABLED</label>
            <Btn
              variant={config.enabled ? 'green' : 'red'}
              onClick={() => setConfig(v => ({ ...v, enabled: !v.enabled }))}
              style={{ width: '100%' }}
            >
              {config.enabled ? 'Enabled' : 'Disabled'}
            </Btn>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>COPY MODE</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <Btn
                variant={config.mode === 'mirror' ? 'accent' : 'ghost'}
                onClick={() => setConfig(v => ({ ...v, mode: 'mirror' }))}
                style={{ flex: 1 }}
              >
                Mirror
              </Btn>
              <Btn
                variant={config.mode === 'reverse' ? 'accent' : 'ghost'}
                onClick={() => setConfig(v => ({ ...v, mode: 'reverse' }))}
                style={{ flex: 1 }}
              >
                Reverse
              </Btn>
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>LOT MULTIPLIER</label>
            <input
              type="number"
              min="0.01"
              max="10"
              step="0.01"
              value={config.lot_multiplier}
              onChange={e => setConfig(v => ({ ...v, lot_multiplier: e.target.value }))}
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', fontSize: '13px' }}
            />
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>TRADE SCOPE</label>
            <Btn
              variant={config.only_funded ? 'accent' : 'ghost'}
              onClick={() => setConfig(v => ({ ...v, only_funded: !v.only_funded }))}
              style={{ width: '100%' }}
            >
              {config.only_funded ? 'Funded Only' : 'All Accounts'}
            </Btn>
          </div>
        </div>
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)', fontSize: '13px', fontWeight: 600 }}>
          Open Trades Being Copied ({openTrades.length})
        </div>
        <Table cols={tradeCols} rows={openTrades} />
      </div>
    </div>
  )
}

// ─── SETTINGS PANEL ───────────────────────────────────────────────────────────
const SETTINGS_GROUPS = [
  {
    title: '🏆 Phase 1 Rules',
    fields: [
      { key: 'phase1_profit_target_pct', label: 'Profit Target (%)', type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_max_drawdown_pct',  label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_day_limit',         label: 'Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'phase1_drawdown_type',     label: 'Drawdown Type',    type: 'select', options: ['trailing', 'static'] },
    ]
  },
  {
    title: '🎯 Phase 2 Rules',
    fields: [
      { key: 'phase2_profit_target_pct', label: 'Profit Target (%)', type: 'number', hint: 'e.g. 5' },
      { key: 'phase2_max_drawdown_pct',  label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 10' },
      { key: 'phase2_day_limit',         label: 'Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'phase2_drawdown_type',     label: 'Drawdown Type',    type: 'select', options: ['trailing', 'static'] },
    ]
  },
  {
    title: '💰 Funded Account Rules',
    fields: [
      { key: 'funded_max_drawdown_pct', label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 5' },
      { key: 'funded_drawdown_type',    label: 'Drawdown Type',    type: 'select', options: ['trailing', 'static'] },
      { key: 'profit_share_pct',        label: 'Profit Share (%)', type: 'number', hint: 'e.g. 80 (trader keeps 80%)' },
    ]
  },
  {
    title: '⚙️ Trading Rules',
    fields: [
      { key: 'min_hold_seconds',       label: 'Min Hold Time (seconds)',      type: 'number', hint: 'e.g. 60' },
      { key: 'min_lot_size',           label: 'Minimum Lot Size',             type: 'number', hint: 'e.g. 0.01' },
      { key: 'forex_lots_per_1k',      label: 'Forex Lots per $1k',           type: 'number', hint: 'e.g. 0.20' },
      { key: 'commodity_lots_per_1k',  label: 'Commodity Lots per $1k',       type: 'number', hint: 'e.g. 0.02' },
      { key: 'max_trades_per_1k',      label: 'Max Open Trades per $1k',      type: 'number', hint: 'e.g. 1' },
    ]
  },
  {
    title: '👥 Account Quotas',
    fields: [
      { key: 'max_total_accounts',  label: 'Max Total Active Accounts', type: 'number', hint: 'Leave blank for unlimited' },
      { key: 'max_accounts_per_user', label: 'Max Accounts per User',   type: 'number', hint: 'Leave blank for unlimited' },
      { key: 'quota_1000',   label: '$1,000 Quota',   type: 'number', hint: 'Max accounts this period' },
      { key: 'quota_2000',   label: '$2,000 Quota',   type: 'number', hint: '' },
      // FIX: Removed \$ escape (no-useless-escape) — $ does not need escaping in JSX strings
      { key: 'quota_2500',   label: '$2,500 Quota',   type: 'number', hint: '' },
      { key: 'quota_5000',   label: '$5,000 Quota',   type: 'number', hint: '' },
      { key: 'quota_10000',  label: '$10,000 Quota',  type: 'number', hint: '' },
      { key: 'quota_25000',  label: '$25,000 Quota',  type: 'number', hint: '' },
      { key: 'quota_50000',  label: '$50,000 Quota',  type: 'number', hint: '' },
      { key: 'quota_100000', label: '$100,000 Quota', type: 'number', hint: '' },
      { key: 'quota_200000', label: '$200,000 Quota', type: 'number', hint: '' },
    ]
  },
  {
    title: '📅 Quota Period',
    fields: [
      { key: 'max_accounts_period_start', label: 'Period Start', type: 'date', hint: 'Click to pick a date' },
      { key: 'max_accounts_period_end',   label: 'Period End',   type: 'date', hint: 'Click to pick a date' },
    ]
  },
]

function SettingsPanelTab({ showMsg }) {
  const [values, setValues]   = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [dirty, setDirty]     = useState(false)

  useEffect(() => {
    ax.get('/api/admin/settings')
      .then(r => { setValues(r.data || {}); setDirty(false) })
      .catch(() => showMsg('Could not load settings', true))
      .finally(() => setLoading(false))
  }, [showMsg])

  function handleChange(key, value) {
    setValues(v => ({ ...v, [key]: value }))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const payload = {}
      for (const [k, v] of Object.entries(values)) {
        payload[k] = v === '' ? '' : v
      }
      await ax.post('/api/admin/settings', payload)
      showMsg('✓ Settings saved successfully')
      setDirty(false)
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save settings', true)
    }
    setSaving(false)
  }

  if (loading) return <div style={{ color: 'var(--text-muted)', padding: '40px' }}>Loading settings...</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h2 style={{ color: 'var(--text)', marginBottom: '4px' }}>⚙️ Platform Settings</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: '12px' }}>Changes are audited and take effect immediately (30s cache on trading rules).</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {dirty && <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>● Unsaved changes</span>}
          <Btn variant="ghost" onClick={() => {
            setLoading(true)
            ax.get('/api/admin/settings')
              .then(r => { setValues(r.data || {}); setDirty(false) })
              .finally(() => setLoading(false))
          }}>↺ Reset</Btn>
          <Btn variant="accent" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : '💾 Save All Settings'}
          </Btn>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '16px' }}>
        {SETTINGS_GROUPS.map(group => (
          <div key={group.title} style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '18px 20px' }}>
            <h3 style={{ color: 'var(--text)', fontSize: '13px', marginBottom: '16px', letterSpacing: '0.06em' }}>{group.title}</h3>
            {group.fields.map(field => (
              <div key={field.key} style={{ marginBottom: '12px' }}>
                <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '5px', letterSpacing: '0.06em' }}>
                  {field.label.toUpperCase()}
                  {field.hint && <span style={{ color: 'var(--text-dim)', fontWeight: '400', marginLeft: '6px', textTransform: 'none', letterSpacing: 0 }}>{field.hint}</span>}
                </label>
                {field.type === 'select' ? (
                  <select
                    value={values[field.key] || ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', fontSize: '13px' }}
                  >
                    <option value="">– not set –</option>
                    {field.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type}
                    value={values[field.key] ?? ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    placeholder={field.hint || ''}
                    step={field.type === 'number' ? 'any' : undefined}
                    style={{ width: '100%', background: 'var(--navy-hover)', border: `1px solid ${dirty && values[field.key] !== undefined ? 'rgba(148, 148, 148, 0.4)' : 'var(--navy-border)'}`, borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', fontSize: '13px', fontFamily: field.type === 'date' ? 'DM Sans, sans-serif' : 'DM Mono, monospace', colorScheme: 'dark' }}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{ marginTop: '20px', padding: '14px 18px', background: 'rgba(148, 148, 148, 0.06)', border: '1px solid rgba(148, 148, 148, 0.2)', borderRadius: '8px', fontSize: '12px', color: 'var(--text-muted)' }}>
        âš ï¸ <strong style={{ color: 'var(--text)' }}>Important:</strong> Leave a field blank to remove/reset it to the system default. All changes are logged in the Settings Log tab.
      </div>
    </div>
  )
}

// ─── ANNOUNCEMENT TAB ─────────────────────────────────────────────────────────
function AnnouncementTab({ showMsg }) {
  const [current, setCurrent]       = useState(null)
  const [message, setMessage]       = useState('')
  const [type, setType]             = useState('info')
  const [expiresHours, setExpires]  = useState('')
  const [loading, setLoading]       = useState(false)

  useEffect(() => { fetchCurrent() }, [showMsg])

  async function fetchCurrent() {
    try {
      const r = await ax.get('/api/admin/announcement')
      setCurrent(r.data)
    } catch { setCurrent(null) }
  }

  async function publish() {
    if (!message.trim()) return showMsg('Message is required', true)
    setLoading(true)
    try {
      await ax.post('/api/admin/announcement', {
        message: message.trim(), type,
        expires_hours: expiresHours ? parseInt(expiresHours) : null
      })
      showMsg('Announcement published – all logged-in traders will see it')
      setMessage(''); setExpires('')
      fetchCurrent()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not publish', true)
    }
    setLoading(false)
  }

  async function clearAnnouncement() {
    try {
      await ax.delete('/api/admin/announcement')
      showMsg('Announcement cleared')
      setCurrent(null)
    } catch { showMsg('Could not clear', true) }
  }

  const typeColors = { info: 'var(--accent)', warning: 'var(--text-muted)', success: 'var(--text-muted)', error: 'var(--text-muted)' }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '20px' }}>📢 Platform Announcement</h2>

      <div style={{ marginBottom: '24px' }}>
        <h3 style={{ color: 'var(--text-muted)', fontSize: '12px', letterSpacing: '0.1em', marginBottom: '12px' }}>CURRENT ANNOUNCEMENT</h3>
        {current ? (
          <div style={{ background: typeColors[current.type] + '18', border: `1px solid ${typeColors[current.type]}44`, borderRadius: '10px', padding: '16px 20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: '11px', fontWeight: '700', color: typeColors[current.type], textTransform: 'uppercase', marginBottom: '8px', display: 'block' }}>
                  {current.type}
                </span>
                <div style={{ fontSize: '14px', color: 'var(--text)', lineHeight: '1.6' }}>{current.message}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '8px' }}>
                  Set {fmtDateTime(current.created_at)}
                  {current.expires_at && ` · Expires ${fmtDateTime(current.expires_at)}`}
                </div>
              </div>
              <Btn variant="red" style={{ padding: '6px 12px', fontSize: '11px', flexShrink: 0 }} onClick={clearAnnouncement}>Clear</Btn>
            </div>
          </div>
        ) : (
          <div style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '20px', color: 'var(--text-dim)', fontSize: '13px' }}>
            No active announcement
          </div>
        )}
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '20px' }}>
        <h3 style={{ color: 'var(--text-muted)', fontSize: '12px', letterSpacing: '0.1em', marginBottom: '16px' }}>PUBLISH NEW ANNOUNCEMENT</h3>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>TYPE</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {['info', 'warning', 'success', 'error'].map(t => (
              <button key={t} onClick={() => setType(t)} style={{
                padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: '600',
                border: `1px solid ${type === t ? typeColors[t] : 'var(--navy-border)'}`,
                background: type === t ? typeColors[t] + '22' : 'transparent',
                color: type === t ? typeColors[t] : 'var(--text-dim)',
                textTransform: 'capitalize'
              }}>{t}</button>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>MESSAGE</label>
          <textarea
            value={message} onChange={e => setMessage(e.target.value)}
            placeholder="e.g. Scheduled maintenance tonight at 22:00 UTC for 30 minutes."
            rows={3} maxLength={500}
            style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '10px 12px', color: 'var(--text)', fontSize: '13px', fontFamily: 'DM Sans, sans-serif', resize: 'vertical', lineHeight: '1.5' }}
          />
          <div style={{ fontSize: '11px', color: 'var(--text-dim)', textAlign: 'right', marginTop: '4px' }}>{message.length}/500</div>
        </div>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', letterSpacing: '0.08em' }}>EXPIRES IN (hours, optional)</label>
          <input type="number" value={expiresHours} onChange={e => setExpires(e.target.value)}
            min="1" max="720" placeholder="Leave blank for no expiry"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--text)', fontSize: '13px', width: '200px' }} />
        </div>
        <Btn variant="accent" onClick={publish} disabled={loading || !message.trim()}>
          {loading ? 'Publishing...' : '📢 Publish Announcement'}
        </Btn>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ADMIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
const CORE_TABS = [
  { id: 'overview',     label: 'Overview' },
  { id: 'risk',         label: '⚡ Risk' },
  { id: 'traders',      label: 'Traders' },
  { id: 'accounts',     label: 'Accounts' },
  { id: 'payouts',      label: 'Payouts' },
  { id: 'suspicious',   label: '🚨 Suspicious' },
  { id: 'bbook',        label: '📊 B-Book' },
  { id: 'auditlog',     label: '📋 Audit Log' },
  { id: 'analytics',    label: '📊 Analytics' },
  { id: 'settings',     label: '⚙️ Settings' },
  { id: 'settingslog',  label: '📋 Settings Log' },
  { id: 'pricefeed',    label: '📡 Price Feed' },
  { id: 'riskscores',   label: '🎯 Risk Scores' },
  { id: 'scaling',      label: '📈 Scaling Plan' },
  { id: 'chat',         label: '💬 Live Chat' },
  { id: 'support',      label: '🎧 Support' },
  { id: 'disputes',     label: '⚖️ Disputes' },
  { id: 'copier',       label: '🔄 Copier' },
  { id: 'announcement', label: '📢 Announce' },
]

const PLANNED_FEATURES = [
  { id: 'feat_incident_center',   label: 'Incident Center',            description: 'Live incidents, outages, and severity handling in one place.' },
  { id: 'feat_rule_builder',      label: 'Rule Builder',               description: 'No-code engine for risk and compliance rules.' },
  { id: 'feat_auto_enforcement',  label: 'Auto Enforcement',           description: 'Automatic actions like lock, lot-reduce, and force-close.' },
  { id: 'feat_account_health',    label: 'Account Health Score',       description: 'Unified account-level risk and health scoring.' },
  { id: 'feat_exposure_heatmap',  label: 'Exposure Heatmap',           description: 'Visual net exposure by symbol, session, and country.' },
  { id: 'feat_news_protection',   label: 'News Protection Mode',       description: 'Auto-tighten rules around high-impact economic events.' },
  { id: 'feat_rollover_guard',    label: 'Rollover Guard',             description: 'Controls and protections around rollover windows.' },
  { id: 'feat_slippage_monitor',  label: 'Slippage Monitor',           description: 'Detect spread/slippage abuse patterns.' },
  { id: 'feat_feed_anomaly',      label: 'Feed Anomaly Detector',      description: 'Detect stale or anomalous feed behavior and alerting.' },
  { id: 'feat_challenge_funnel',  label: 'Challenge Funnel',           description: 'Phase conversion and drop-off analytics.' },
  { id: 'feat_cohort_analytics',  label: 'Cohort Analytics',           description: 'Performance by signup cohort, source, and region.' },
  { id: 'feat_payout_fraud',      label: 'Payout Fraud Scoring',       description: 'Risk score payout requests before approval.' },
  { id: 'feat_device_graph',      label: 'Device/IP Link Graph',       description: 'Entity links for devices, IPs, and accounts.' },
  { id: 'feat_aml_velocity',      label: 'AML Velocity Checks',        description: 'Velocity-based checks on suspicious account behavior.' },
  { id: 'feat_kyc_sla',           label: 'KYC SLA Queue',              description: 'Prioritized KYC queue with SLA views.' },
  { id: 'feat_kyc_quality',       label: 'KYC Quality Flags',          description: 'Auto document quality and liveness flags.' },
  { id: 'feat_immutable_audit',   label: 'Immutable Audit Log',        description: 'Tamper-evident admin audit trail.' },
  { id: 'feat_four_eyes',         label: '4-Eyes Approvals',           description: 'Dual approvals for sensitive actions.' },
  { id: 'feat_feature_flags',     label: 'Feature Flags',              description: 'Controlled rollout toggles by environment/segment.' },
  { id: 'feat_notifications',     label: 'Notification Center',        description: 'Admin alerts to email/chat/webhooks.' },
  { id: 'feat_case_management',   label: 'Case Management',            description: 'Case ownership, notes, and lifecycle tracking.' },
  { id: 'feat_dispute_workflow',  label: 'Dispute Workflow',           description: 'Timer-based dispute queues and owner assignment.' },
  { id: 'feat_ai_triage',         label: 'AI Ticket Triage',           description: 'Auto-priority and category suggestion for tickets.' },
  { id: 'feat_copier_guardrails', label: 'Copier Guardrails',          description: 'Risk limits and kill-logic for copier operations.' },
  { id: 'feat_hedge_recon',       label: 'Hedge Reconciliation',       description: 'Match simulated exposure with broker hedge activity.' },
  { id: 'feat_stress_simulator',  label: 'Stress Test Simulator',      description: 'What-if simulation under market shocks.' },
  { id: 'feat_rule_simulator',    label: 'Rule Impact Simulator',      description: 'Preview account impact before publishing new rules.' },
  { id: 'feat_scheduled_reports', label: 'Scheduled Reports',          description: 'Automated daily/weekly risk and PnL reports.' },
  { id: 'feat_status_page',       label: 'Status Page Publisher',      description: 'Publish operational status updates.' },
  { id: 'feat_emergency_kill',    label: 'Emergency Kill Switch',      description: 'Global emergency stop with controlled recovery steps.' },
]

function IncidentCenterTab({ showMsg }) {
  const [incidents, setIncidents] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [source, setSource] = useState('manual')
  const [details, setDetails] = useState('')
  const [selectedIncidentId, setSelectedIncidentId] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/incidents')
      const rows = r.data || []
      setIncidents(rows)
      setSelectedIncidentId(prev => prev || (rows.length > 0 ? String(rows[0].id) : ''))
    } catch {
      showMsg('Could not load incidents', true)
    }
    setLoading(false)
  }, [showMsg])

  useEffect(() => { load() }, [load])

  async function createIncident() {
    if (!title.trim()) return showMsg('Title is required', true)
    try {
      await ax.post('/api/admin/incidents', { title, severity, source, details })
      setTitle('')
      setDetails('')
      showMsg('Incident created')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not create incident', true)
    }
  }

  async function setStatus(id, status) {
    try {
      await ax.post(`/api/admin/incidents/${id}/status`, { status })
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not update incident', true)
    }
  }

  const sevColor = { low: '#4b7bec', medium: '#ffa502', high: '#ff7f50', critical: '#ff4757' }
  const selectedIncident = incidents.find(i => String(i.id) === String(selectedIncidentId)) || incidents[0] || null
  const timelineEvents = selectedIncident ? [
    { label: 'Created', at: selectedIncident.created_at, color: '#2962ff' },
    { label: 'Acknowledged', at: selectedIncident.acknowledged_at, color: '#ffa502' },
    { label: 'Resolved', at: selectedIncident.resolved_at, color: '#00c896' },
  ] : []

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Incident Center</h2>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Incident title"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <select value={severity} onChange={e => setSeverity(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['low', 'medium', 'high', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={source} onChange={e => setSource(e.target.value)} placeholder="Source"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        </div>
        <textarea value={details} onChange={e => setDetails(e.target.value)} rows={2} placeholder="Details (optional)"
          style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', marginBottom: '10px' }} />
        <Btn variant="accent" onClick={createIncident}>Create Incident</Btn>
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div> : (
        <>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ background: 'var(--navy-hover)' }}>
                {['Time', 'Title', 'Severity', 'Status', 'Source', 'Actions'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {incidents.map(i => (
                <tr
                  key={i.id}
                  onClick={() => setSelectedIncidentId(String(i.id))}
                  style={{
                    borderBottom: '1px solid var(--navy-border)',
                    cursor: 'pointer',
                    background: String(i.id) === String(selectedIncidentId) ? 'rgba(41,98,255,0.08)' : 'transparent'
                  }}
                >
                  <td style={{ padding: '10px 12px', color: 'var(--text-dim)' }}>{fmtDateTime(i.created_at)}</td>
                  <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{i.title}</td>
                  <td style={{ padding: '10px 12px', color: sevColor[i.severity] || 'var(--text)' }}>{String(i.severity).toUpperCase()}</td>
                  <td style={{ padding: '10px 12px' }}><StatusBadge status={i.status} /></td>
                  <td style={{ padding: '10px 12px', color: 'var(--text-muted)' }}>{i.source || 'manual'}</td>
                  <td style={{ padding: '10px 12px', display: 'flex', gap: '6px' }}>
                    <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setStatus(i.id, 'acknowledged')}>Ack</Btn>
                    <Btn variant="green" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setStatus(i.id, 'resolved')}>Resolve</Btn>
                    <Btn variant="red" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setStatus(i.id, 'open')}>Reopen</Btn>
                  </td>
                </tr>
              ))}
              {incidents.length === 0 && <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-dim)' }}>No incidents</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ marginTop: '12px', background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px' }}>
          <div style={{ color: 'var(--text)', fontSize: '13px', fontWeight: 600, marginBottom: '10px' }}>Incident Timeline</div>
          {!selectedIncident && <div style={{ color: 'var(--text-dim)', fontSize: '12px' }}>Select an incident row to view lifecycle timeline.</div>}
          {selectedIncident && (
            <>
              <div style={{ marginBottom: '10px' }}>
                <div style={{ color: 'var(--text)', fontWeight: 700 }}>{selectedIncident.title}</div>
                <div style={{ color: 'var(--text-dim)', fontSize: '12px', marginTop: '3px' }}>
                  {(selectedIncident.details || '').trim() || 'No details provided'}
                </div>
              </div>
              <div style={{ position: 'relative', paddingLeft: '16px' }}>
                {timelineEvents.map((event, idx) => (
                  <div key={event.label} style={{ position: 'relative', paddingBottom: idx === timelineEvents.length - 1 ? 0 : '12px' }}>
                    <div style={{
                      position: 'absolute',
                      left: '-16px',
                      top: '4px',
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: event.at ? event.color : 'var(--navy-border)',
                      border: '1px solid rgba(255,255,255,0.2)'
                    }} />
                    {idx !== timelineEvents.length - 1 && (
                      <div style={{
                        position: 'absolute',
                        left: '-13px',
                        top: '12px',
                        width: '2px',
                        height: '18px',
                        background: 'var(--navy-border)'
                      }} />
                    )}
                    <div style={{ color: 'var(--text)', fontSize: '12px', fontWeight: 600 }}>{event.label}</div>
                    <div style={{ color: event.at ? 'var(--text-muted)' : 'var(--text-dim)', fontSize: '12px' }}>
                      {event.at ? fmtDateTime(event.at) : 'Pending'}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </>)}
    </div>
  )
}

function RuleBuilderTab({ showMsg }) {
  const [rules, setRules] = useState([])
  const [dragRuleId, setDragRuleId] = useState('')
  const [reordering, setReordering] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('global')
  const [priority, setPriority] = useState('100')
  const [conditionJson, setConditionJson] = useState('{"metric":"drawdown_pct","op":">","value":8}')
  const [actionType, setActionType] = useState('lock_account')
  const [actionValue, setActionValue] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/rules')
      setRules(r.data || [])
    } catch {
      showMsg('Could not load rules', true)
    }
  }, [showMsg])

  useEffect(() => { load() }, [load])

  async function createRule() {
    try {
      const condition = JSON.parse(conditionJson || '{}')
      const action = { type: actionType, value: actionValue || null }
      await ax.post('/api/admin/rules', {
        name,
        scope,
        priority: parseInt(priority, 10),
        condition_json: condition,
        action_json: action,
        enabled: true
      })
      setName('')
      setActionValue('')
      showMsg('Rule created')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Invalid JSON or failed to create rule', true)
    }
  }

  async function toggleRule(id) {
    try { await ax.post(`/api/admin/rules/${id}/toggle`); load() } catch { showMsg('Could not toggle rule', true) }
  }
  async function deleteRule(id) {
    if (!window.confirm('Delete this rule?')) return
    try { await ax.delete(`/api/admin/rules/${id}`); load() } catch { showMsg('Could not delete rule', true) }
  }

  async function persistOrder(nextRules) {
    const orderedIds = nextRules.map(r => r.id)
    if (!orderedIds.length) return
    setReordering(true)
    try {
      const r = await ax.post('/api/admin/rules/reorder', { ordered_ids: orderedIds })
      setRules(r.data || [])
      showMsg('Rule priorities updated')
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not reorder rules', true)
      load()
    }
    setReordering(false)
  }

  function handleDrop(targetRuleId) {
    if (!dragRuleId || String(dragRuleId) === String(targetRuleId)) return
    const sourceIndex = rules.findIndex(r => String(r.id) === String(dragRuleId))
    const targetIndex = rules.findIndex(r => String(r.id) === String(targetRuleId))
    if (sourceIndex < 0 || targetIndex < 0) return
    const next = [...rules]
    const [moved] = next.splice(sourceIndex, 1)
    next.splice(targetIndex, 0, moved)
    setRules(next)
    setDragRuleId('')
    persistOrder(next)
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Rule Builder</h2>
      <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '10px' }}>
        Drag and drop rows to reorder rule execution priority.
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Rule name"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <select value={scope} onChange={e => setScope(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['global', 'account', 'symbol'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={priority} onChange={e => setPriority(e.target.value)} placeholder="Priority"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        </div>
        <textarea rows={2} value={conditionJson} onChange={e => setConditionJson(e.target.value)} placeholder='Condition JSON'
          style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', marginBottom: '8px', fontFamily: 'monospace' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '8px' }}>
          <select value={actionType} onChange={e => setActionType(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['lock_account', 'force_close_open_trades', 'flag_for_review'].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <input value={actionValue} onChange={e => setActionValue(e.target.value)} placeholder="Action value (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={createRule}>Create</Btn>
        </div>
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden', opacity: reordering ? 0.75 : 1 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ background: 'var(--navy-hover)' }}>
              {['Order', 'Name', 'Scope', 'Priority', 'Enabled', 'Action', 'Triggers', 'Actions'].map(h => (
                <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: 'var(--text-muted)', fontSize: '11px' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rules.map((r, idx) => (
              <tr
                key={r.id}
                draggable
                onDragStart={() => setDragRuleId(String(r.id))}
                onDragOver={e => e.preventDefault()}
                onDrop={() => handleDrop(r.id)}
                style={{
                  borderBottom: '1px solid var(--navy-border)',
                  cursor: 'grab',
                  background: String(dragRuleId) === String(r.id) ? 'rgba(41,98,255,0.08)' : 'transparent'
                }}
              >
                <td style={{ padding: '10px 12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{idx + 1}</td>
                <td style={{ padding: '10px 12px' }}>{r.name}</td>
                <td style={{ padding: '10px 12px' }}>{r.scope}</td>
                <td style={{ padding: '10px 12px' }}>{r.priority}</td>
                <td style={{ padding: '10px 12px' }}><StatusBadge status={r.enabled ? 'active' : 'disabled'} /></td>
                <td style={{ padding: '10px 12px', fontFamily: 'monospace', fontSize: '11px' }}>{r.action_json?.type || '—'}</td>
                <td style={{ padding: '10px 12px' }}>{r.trigger_count || 0}</td>
                <td style={{ padding: '10px 12px', display: 'flex', gap: '6px' }}>
                  <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => toggleRule(r.id)}>
                    {r.enabled ? 'Disable' : 'Enable'}
                  </Btn>
                  <Btn variant="red" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => deleteRule(r.id)}>Delete</Btn>
                </td>
              </tr>
            ))}
            {rules.length === 0 && <tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: 'var(--text-dim)' }}>No rules</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AutoEnforcementTab({ accounts, showMsg }) {
  const [events, setEvents] = useState([])
  const [action, setAction] = useState('lock_account')
  const [accountId, setAccountId] = useState('')
  const [reason, setReason] = useState('')
  const [ruleId, setRuleId] = useState('')
  const [payloadJson, setPayloadJson] = useState('{}')

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0].id)
  }, [accounts, accountId])

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/enforcement/events')
      setEvents(r.data || [])
    } catch {
      showMsg('Could not load enforcement events', true)
    }
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function applyAction() {
    try {
      const payload = JSON.parse(payloadJson || '{}')
      const r = await ax.post('/api/admin/enforcement/apply', {
        account_id: accountId,
        action,
        reason,
        rule_id: ruleId ? parseInt(ruleId, 10) : null,
        payload
      })
      showMsg(r.data?.message || 'Action applied')
      setReason('')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not apply enforcement', true)
    }
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Auto Enforcement</h2>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px', marginBottom: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr', gap: '8px', marginBottom: '8px' }}>
          <select value={accountId} onChange={e => setAccountId(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>
                {a.account_uid || a.id} ({a.account_type})
              </option>
            ))}
          </select>
          <select value={action} onChange={e => setAction(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['lock_account', 'force_close_open_trades', 'flag_for_review'].map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <input value={ruleId} onChange={e => setRuleId(e.target.value)} placeholder="Rule ID (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={applyAction}>Apply</Btn>
        </div>
        <input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason"
          style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', marginBottom: '8px' }} />
        <textarea rows={2} value={payloadJson} onChange={e => setPayloadJson(e.target.value)} placeholder="Payload JSON"
          style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', fontFamily: 'monospace' }} />
      </div>

      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'created_at', label: 'Time', render: v => fmtDateTime(v) },
            { key: 'account_id', label: 'Account' },
            { key: 'action', label: 'Action' },
            { key: 'status', label: 'Status', render: v => <StatusBadge status={v} /> },
            { key: 'message', label: 'Message' },
          ]}
          rows={events}
        />
      </div>
    </div>
  )
}

function PayoutFraudScoringTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/payout-fraud-scores')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load payout fraud scores', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading payout fraud scores...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Payout Fraud Scoring</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'full_name', label: 'Trader' },
            { key: 'amount_requested', label: 'Amount', render: v => fmtUSD(v) },
            { key: 'score', label: 'Score', render: v => <span style={{ color: v >= 70 ? COLOR_NEG : v >= 40 ? '#ffa502' : COLOR_POS, fontWeight: 700 }}>{v}</span> },
            { key: 'risk_level', label: 'Risk', render: v => <StatusBadge status={v} /> },
            { key: 'account_age_days', label: 'Acct Age (d)' },
            { key: 'shared_ip_users', label: 'Shared IP Users' },
            { key: 'reasons', label: 'Reasons', render: v => (Array.isArray(v) && v.length ? v.join('; ') : '—') },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function DeviceIpGraphTab({ showMsg }) {
  const [rows, setRows] = useState({ nodes: [], edges: [] })
  const [loading, setLoading] = useState(true)
  const [userId, setUserId] = useState('')

  async function load() {
    setLoading(true)
    try {
      const r = await ax.get('/api/admin/device-link-graph', { params: userId ? { user_id: userId } : {} })
      setRows({ nodes: r.data?.nodes || [], edges: r.data?.edges || [] })
    } catch {
      showMsg('Could not load device link graph', true)
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [showMsg]) // eslint-disable-line react-hooks/exhaustive-deps

  const topEdges = [...rows.edges].sort((a, b) => b.weight - a.weight).slice(0, 200)

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Device/IP Link Graph</h2>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
        <input value={userId} onChange={e => setUserId(e.target.value)} placeholder="Optional user_id focus"
          style={{ width: '320px', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        <Btn variant="accent" onClick={load}>Load Graph</Btn>
      </div>

      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading graph...</div> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(130px,1fr))', gap: '10px', marginBottom: '14px' }}>
            <StatCard label="Nodes" value={rows.nodes.length} />
            <StatCard label="Edges" value={rows.edges.length} />
            <StatCard label="Top Edges Shown" value={topEdges.length} />
          </div>
          <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
            <Table
              cols={[
                { key: 'from', label: 'From' },
                { key: 'to', label: 'To' },
                { key: 'type', label: 'Type' },
                { key: 'weight', label: 'Weight' },
              ]}
              rows={topEdges}
            />
          </div>
        </>
      )}
    </div>
  )
}

function NewsProtectionTab({ showMsg }) {
  const [settings, setSettings] = useState({
    enabled: false,
    lookahead_minutes: 45,
    max_lots_multiplier: 0.6,
    block_new_orders: true
  })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/news-protection')
      setSettings(r.data || settings)
    } catch {
      showMsg('Could not load news protection settings', true)
    }
  }, [showMsg]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    try {
      await ax.post('/api/admin/news-protection', settings)
      showMsg('News protection settings saved')
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save settings', true)
    }
    setSaving(false)
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>News Protection Mode</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '18px 20px', maxWidth: '760px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={!!settings.enabled} onChange={e => setSettings(s => ({ ...s, enabled: e.target.checked }))} style={{ marginRight: '8px' }} />
            Enable news protection
          </label>
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={!!settings.block_new_orders} onChange={e => setSettings(s => ({ ...s, block_new_orders: e.target.checked }))} style={{ marginRight: '8px' }} />
            Block new orders in window
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: '6px' }}>LOOKAHEAD WINDOW (minutes)</div>
            <input type="number" value={settings.lookahead_minutes} onChange={e => setSettings(s => ({ ...s, lookahead_minutes: parseInt(e.target.value || '0', 10) }))}
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: '6px' }}>MAX LOTS MULTIPLIER</div>
            <input type="number" step="0.05" value={settings.max_lots_multiplier} onChange={e => setSettings(s => ({ ...s, max_lots_multiplier: parseFloat(e.target.value || '0') }))}
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          </div>
        </div>
        <Btn variant="accent" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</Btn>
      </div>
    </div>
  )
}

function RolloverGuardTab({ showMsg }) {
  const [settings, setSettings] = useState({
    enabled: true,
    start_utc: '21:55',
    end_utc: '22:05',
    block_new_orders: true
  })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/rollover-guard')
      setSettings(r.data || settings)
    } catch {
      showMsg('Could not load rollover guard settings', true)
    }
  }, [showMsg]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  async function save() {
    setSaving(true)
    try {
      await ax.post('/api/admin/rollover-guard', settings)
      showMsg('Rollover guard settings saved')
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save settings', true)
    }
    setSaving(false)
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Rollover Guard</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '18px 20px', maxWidth: '760px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={!!settings.enabled} onChange={e => setSettings(s => ({ ...s, enabled: e.target.checked }))} style={{ marginRight: '8px' }} />
            Enable rollover guard
          </label>
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={!!settings.block_new_orders} onChange={e => setSettings(s => ({ ...s, block_new_orders: e.target.checked }))} style={{ marginRight: '8px' }} />
            Block new orders in rollover window
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: '6px' }}>START UTC (HH:MM)</div>
            <input value={settings.start_utc} onChange={e => setSettings(s => ({ ...s, start_utc: e.target.value }))}
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          </div>
          <div>
            <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginBottom: '6px' }}>END UTC (HH:MM)</div>
            <input value={settings.end_utc} onChange={e => setSettings(s => ({ ...s, end_utc: e.target.value }))}
              style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          </div>
        </div>
        <Btn variant="accent" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Settings'}</Btn>
      </div>
    </div>
  )
}

function SlippageMonitorTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/slippage-monitor')
      setData(r.data || null)
    } catch {
      showMsg('Could not load slippage monitor', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading slippage monitor...</div>
  if (!data) return null

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Slippage Monitor</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Suspicious Quick Moves" value={data.suspicious_quick_moves || 0} color={COLOR_NEG} />
        <StatCard label="Samples (24h)" value={data.sample_count || 0} />
        <StatCard label="Spread Alerts" value={(data.spread_monitor || []).filter(r => r.is_alert).length} color={COLOR_ACCENT} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Live Spread Monitor</div>
          <Table
            cols={[
              { key: 'instrument', label: 'Instrument' },
              { key: 'spread_points', label: 'Spread (pts)' },
              { key: 'threshold_points', label: 'Threshold' },
              { key: 'is_alert', label: 'Alert', render: v => v ? <StatusBadge status="warning" /> : <StatusBadge status="ok" /> },
            ]}
            rows={data.spread_monitor || []}
          />
        </div>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Drift Proxy by Instrument (24h)</div>
          <Table
            cols={[
              { key: 'instrument', label: 'Instrument' },
              { key: 'trades', label: 'Trades' },
              { key: 'avg_move_points', label: 'Avg Move (pts)' },
              { key: 'suspicious_quick_moves', label: 'Quick Moves' },
            ]}
            rows={data.drift_monitor || []}
          />
        </div>
      </div>
    </div>
  )
}

function FeedAnomalyTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/feed-anomalies')
      setData(r.data || null)
    } catch {
      showMsg('Could not load feed anomalies', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading feed anomaly detector...</div>
  if (!data) return null

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Feed Anomaly Detector</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Any Anomaly" value={data.any_anomaly ? 'YES' : 'NO'} color={data.any_anomaly ? COLOR_NEG : COLOR_POS} />
        <StatCard label="Stale Instruments" value={data.stale_count || 0} color={COLOR_NEG} />
        <StatCard label="Wide Spreads" value={data.wide_spread_count || 0} color={COLOR_ACCENT} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'instrument', label: 'Instrument' },
            { key: 'seconds_since_update', label: 'Age (s)' },
            { key: 'spread_points', label: 'Spread (pts)' },
            { key: 'stale', label: 'Stale', render: v => v ? <StatusBadge status="warning" /> : <StatusBadge status="ok" /> },
            { key: 'wide_spread', label: 'Wide Spread', render: v => v ? <StatusBadge status="warning" /> : <StatusBadge status="ok" /> },
          ]}
          rows={data.instruments || []}
        />
      </div>
    </div>
  )
}

function ChallengeFunnelTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/challenge-funnel')
      setData(r.data || null)
    } catch {
      showMsg('Could not load challenge funnel', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading challenge funnel...</div>
  if (!data) return null
  const f = data.funnel || {}
  const o = data.outcomes || {}

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Challenge Funnel</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Phase 1 Total" value={f.phase1_total || 0} />
        <StatCard label="Phase 1 Passed" value={f.phase1_passed || 0} color={COLOR_POS} />
        <StatCard label="Phase 1 Pass Rate" value={`${f.phase1_pass_rate || 0}%`} color={COLOR_ACCENT} />
        <StatCard label="Phase 2 Total" value={f.phase2_total || 0} />
        <StatCard label="Phase 2 Passed" value={f.phase2_passed || 0} color={COLOR_POS} />
        <StatCard label="Phase 2 Pass Rate" value={`${f.phase2_pass_rate || 0}%`} color={COLOR_ACCENT} />
        <StatCard label="Funded Total" value={f.funded_total || 0} />
        <StatCard label="Funded Active" value={f.funded_active || 0} color={COLOR_POS} />
        <StatCard label="Funded Activation" value={`${f.funded_activation_rate || 0}%`} color={COLOR_ACCENT} />
        <StatCard label="Failed Total" value={o.failed_total || 0} color={COLOR_NEG} />
        <StatCard label="Expired Total" value={o.expired_total || 0} color={COLOR_NEG} />
      </div>
    </div>
  )
}

function CohortAnalyticsTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/cohort-analytics')
      setData(r.data || null)
    } catch {
      showMsg('Could not load cohort analytics', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading cohort analytics...</div>
  if (!data) return null

  const monthly = data.monthly || []
  const cohorts = data.cohorts || []
  const topCountries = data.top_countries || []
  const totalSignups = monthly.reduce((sum, m) => sum + (parseInt(m.signups || 0, 10) || 0), 0)
  const totalFunded = monthly.reduce((sum, m) => sum + (parseInt(m.funded_accounts || 0, 10) || 0), 0)
  const totalPaid = monthly.reduce((sum, m) => sum + (parseFloat(m.paid_out || 0) || 0), 0)

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Cohort Analytics</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Months in View" value={data.months_back || 12} />
        <StatCard label="Total Signups" value={totalSignups} color={COLOR_ACCENT} />
        <StatCard label="Funded Accounts" value={totalFunded} color={COLOR_POS} />
        <StatCard label="Paid Out" value={fmtUSD(totalPaid)} color={COLOR_ACCENT} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '12px' }}>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Monthly Cohorts</div>
          <Table
            cols={[
              { key: 'month', label: 'Month' },
              { key: 'signups', label: 'Signups' },
              { key: 'kyc_approved', label: 'KYC Approved' },
              { key: 'kyc_approval_rate', label: 'KYC Rate', render: v => `${fmt(v)}%` },
              { key: 'funded_accounts', label: 'Funded' },
              { key: 'paid_out', label: 'Paid Out', render: v => fmtUSD(v) },
            ]}
            rows={monthly}
          />
        </div>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Top Countries</div>
          <Table
            cols={[
              { key: 'country', label: 'Country' },
              { key: 'signups', label: 'Signups' },
            ]}
            rows={topCountries}
          />
        </div>
      </div>
      <div style={{ marginTop: '12px', background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Cohort Breakdown</div>
        <Table
          cols={[
            { key: 'cohort_month', label: 'Cohort Month', render: v => v ? new Date(v).toISOString().slice(0, 10) : '-' },
            { key: 'source', label: 'Source' },
            { key: 'country', label: 'Country' },
            { key: 'signups', label: 'Signups' },
            { key: 'kyc_approved', label: 'KYC Approved' },
            { key: 'funded_accounts', label: 'Funded' },
            { key: 'paid_out', label: 'Paid Out', render: v => fmtUSD(v) },
          ]}
          rows={cohorts.slice(0, 250)}
        />
      </div>
    </div>
  )
}

function AmlVelocityTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/aml-velocity')
      setData(r.data || null)
    } catch {
      showMsg('Could not load AML velocity checks', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading AML velocity checks...</div>
  if (!data) return null

  const rows = data.rows || []
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>AML Velocity Checks</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Flagged Users" value={data.flagged_count || 0} color={COLOR_ACCENT} />
        <StatCard label="High Risk" value={data.high_risk_count || 0} color={COLOR_NEG} />
        <StatCard label="Medium Risk" value={data.medium_risk_count || 0} color="#ffa502" />
        <StatCard label="Snapshot Time" value={new Date(data.generated_at).toLocaleTimeString()} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'full_name', label: 'Trader' },
            { key: 'risk_score', label: 'Risk Score', render: v => <span style={{ color: v >= 70 ? COLOR_NEG : v >= 40 ? '#ffa502' : COLOR_POS, fontWeight: 700 }}>{v}</span> },
            { key: 'risk_level', label: 'Risk Level', render: v => <StatusBadge status={v} /> },
            { key: 'login_1h', label: 'Logins 1h' },
            { key: 'login_24h', label: 'Logins 24h' },
            { key: 'unique_ip_24h', label: 'Unique IP 24h' },
            { key: 'trade_1h', label: 'Trades 1h' },
            { key: 'trade_24h', label: 'Trades 24h' },
            { key: 'payout_req_7d', label: 'Payout Req 7d' },
            { key: 'payout_amt_7d', label: 'Payout Amt 7d', render: v => fmtUSD(v) },
            { key: 'flags', label: 'Flags', render: v => (Array.isArray(v) && v.length ? v.join('; ') : '-') },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function KycSlaTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [nowTick, setNowTick] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/kyc-sla')
      setData(r.data || null)
    } catch {
      showMsg('Could not load KYC SLA queue', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading KYC SLA queue...</div>
  if (!data) return null

  const summary = data.summary || {}
  const queue = data.queue || []
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>KYC SLA Queue</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Pending KYC" value={summary.pending_total || 0} color={COLOR_ACCENT} />
        <StatCard label="Overdue" value={summary.overdue_total || 0} color="#ff7f50" />
        <StatCard label="Breached" value={summary.breach_total || 0} color={COLOR_NEG} />
        <StatCard label="Avg Wait (h)" value={summary.avg_wait_hours || 0} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'full_name', label: 'Trader' },
            { key: 'email', label: 'Email' },
            { key: 'country', label: 'Country' },
            { key: 'submitted_at', label: 'Submitted', render: v => fmtDateTime(v) },
            { key: 'wait_hours', label: 'Wait (h)' },
            {
              key: 'remaining_sla',
              label: 'SLA Timer',
              render: (_, row) => {
                const remainingRaw = calcRemainingSlaMinutes(row.submitted_at, data.sla_hours || 24)
                const remaining = remainingRaw == null ? null : remainingRaw + (nowTick ? 0 : 0)
                if (remaining == null) return '-'
                if (remaining <= 0) return <span style={{ color: COLOR_NEG, fontWeight: 700 }}>Breached</span>
                return <span style={{ color: remaining <= 60 ? '#ff7f50' : 'var(--text)' }}>{fmtTimerMinutes(remaining)}</span>
              }
            },
            { key: 'sla_status', label: 'SLA', render: v => <StatusBadge status={v} /> },
            { key: 'accounts_total', label: 'Accounts' },
            { key: 'funded_accounts', label: 'Funded' },
          ]}
          rows={queue}
        />
      </div>
    </div>
  )
}

function KycQualityTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/kyc-quality-flags')
      setData(r.data || null)
    } catch {
      showMsg('Could not load KYC quality flags', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading KYC quality flags...</div>
  if (!data) return null

  const summary = data.summary || {}
  const rows = data.rows || []
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>KYC Quality Flags</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Profiles" value={summary.total_profiles || 0} />
        <StatCard label="High Risk" value={summary.high_risk_count || 0} color={COLOR_NEG} />
        <StatCard label="Medium Risk" value={summary.medium_risk_count || 0} color="#ffa502" />
        <StatCard label="Missing Files" value={summary.missing_file_count || 0} color={COLOR_NEG} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'full_name', label: 'Trader' },
            { key: 'kyc_status', label: 'KYC', render: v => <StatusBadge status={v} /> },
            { key: 'submitted_at', label: 'Submitted', render: v => fmtDateTime(v) },
            { key: 'id_file_exists', label: 'ID File', render: v => v ? <StatusBadge status="ok" /> : <StatusBadge status="failed" /> },
            { key: 'selfie_file_exists', label: 'Selfie File', render: v => v ? <StatusBadge status="ok" /> : <StatusBadge status="failed" /> },
            { key: 'quality_score', label: 'Score', render: v => <span style={{ color: v >= 60 ? COLOR_NEG : v >= 30 ? '#ffa502' : COLOR_POS, fontWeight: 700 }}>{v}</span> },
            { key: 'risk_level', label: 'Risk', render: v => <StatusBadge status={v} /> },
            { key: 'flags', label: 'Flags', render: v => (Array.isArray(v) && v.length ? v.join('; ') : '-') },
          ]}
          rows={rows.slice(0, 300)}
        />
      </div>
    </div>
  )
}

function ImmutableAuditTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/immutable-audit')
      setData(r.data || null)
    } catch {
      showMsg('Could not load immutable audit log', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading immutable audit log...</div>
  if (!data) return null

  const integrity = data.integrity || {}
  const rows = data.entries || []
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Immutable Audit Log</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Chain Valid" value={integrity.valid ? 'YES' : 'NO'} color={integrity.valid ? COLOR_POS : COLOR_NEG} />
        <StatCard label="Entries Checked" value={integrity.checked_entries || 0} />
        <StatCard label="Broken Links" value={integrity.broken_links || 0} color={(integrity.broken_links || 0) > 0 ? COLOR_NEG : COLOR_POS} />
        <StatCard label="Chain Head" value={integrity.chain_head ? String(integrity.chain_head).slice(0, 10) : '-'} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'created_at', label: 'Time', render: v => fmtDateTime(v) },
            { key: 'event_type', label: 'Event' },
            { key: 'entity_type', label: 'Entity' },
            { key: 'entity_id', label: 'Entity ID' },
            { key: 'is_valid', label: 'Valid', render: v => v ? <StatusBadge status="ok" /> : <StatusBadge status="failed" /> },
            { key: 'prev_hash', label: 'Prev Hash', render: v => String(v || '').slice(0, 14) },
            { key: 'entry_hash', label: 'Entry Hash', render: v => String(v || '').slice(0, 14) },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function FourEyesTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionType, setActionType] = useState('payout_approval')
  const [targetType, setTargetType] = useState('payout')
  const [targetId, setTargetId] = useState('')
  const [requiredApprovals, setRequiredApprovals] = useState('2')
  const [payloadJson, setPayloadJson] = useState('{}')
  const [approver, setApprover] = useState('admin_reviewer_2')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/four-eyes/queue')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load 4-eyes queue', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function createRequest() {
    try {
      const payload = JSON.parse(payloadJson || '{}')
      await ax.post('/api/admin/four-eyes/request', {
        action_type: actionType,
        target_type: targetType,
        target_id: targetId,
        required_approvals: parseInt(requiredApprovals, 10),
        payload
      })
      setTargetId('')
      setPayloadJson('{}')
      showMsg('4-eyes request created')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not create request', true)
    }
  }

  async function decide(id, decision) {
    try {
      await ax.post(`/api/admin/four-eyes/${id}/decision`, { decision, approver })
      showMsg(`Decision submitted: ${decision}`)
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not submit decision', true)
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading 4-eyes approvals...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>4-Eyes Approvals</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 120px', gap: '8px', marginBottom: '8px' }}>
          <input value={actionType} onChange={e => setActionType(e.target.value)} placeholder="Action type"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={targetType} onChange={e => setTargetType(e.target.value)} placeholder="Target type"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={targetId} onChange={e => setTargetId(e.target.value)} placeholder="Target ID"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={requiredApprovals} onChange={e => setRequiredApprovals(e.target.value)} type="number" min="2" max="5"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px auto', gap: '8px' }}>
          <textarea rows={2} value={payloadJson} onChange={e => setPayloadJson(e.target.value)} placeholder="Payload JSON"
            style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)', fontFamily: 'monospace' }} />
          <input value={approver} onChange={e => setApprover(e.target.value)} placeholder="Approver username"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={createRequest}>Create Request</Btn>
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'created_at', label: 'Created', render: v => fmtDateTime(v) },
            { key: 'action_type', label: 'Action' },
            { key: 'target_type', label: 'Target Type' },
            { key: 'target_id', label: 'Target ID' },
            { key: 'required_approvals', label: 'Required' },
            { key: 'approvals_count', label: 'Current' },
            { key: 'status', label: 'Status', render: v => <StatusBadge status={v} /> },
            {
              key: 'id',
              label: 'Actions',
              render: (v, row) => row.status === 'pending' ? (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <Btn variant="green" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => decide(v, 'approve')}>Approve</Btn>
                  <Btn variant="red" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => decide(v, 'reject')}>Reject</Btn>
                </div>
              ) : <span style={{ color: 'var(--text-dim)' }}>-</span>
            },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function FeatureFlagsTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [flagKey, setFlagKey] = useState('')
  const [description, setDescription] = useState('')
  const [rolloutPct, setRolloutPct] = useState('100')
  const [segment, setSegment] = useState('all')
  const [enabled, setEnabled] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/feature-flags')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load feature flags', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function saveFlag() {
    try {
      await ax.post('/api/admin/feature-flags', {
        flag_key: flagKey,
        description,
        enabled,
        rollout_pct: parseInt(rolloutPct, 10),
        segment
      })
      setFlagKey('')
      setDescription('')
      setRolloutPct('100')
      setSegment('all')
      setEnabled(false)
      showMsg('Feature flag saved')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save feature flag', true)
    }
  }

  async function toggleFlag(id) {
    try {
      await ax.post(`/api/admin/feature-flags/${id}/toggle`)
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not toggle flag', true)
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading feature flags...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Feature Flags</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1.5fr 120px 140px auto auto', gap: '8px', alignItems: 'center' }}>
          <input value={flagKey} onChange={e => setFlagKey(e.target.value)} placeholder="flag_key"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={description} onChange={e => setDescription(e.target.value)} placeholder="Description"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={rolloutPct} onChange={e => setRolloutPct(e.target.value)} type="number" min="0" max="100" placeholder="Rollout %"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={segment} onChange={e => setSegment(e.target.value)} placeholder="Segment"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ marginRight: '6px' }} />
            Enabled
          </label>
          <Btn variant="accent" onClick={saveFlag}>Save</Btn>
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'flag_key', label: 'Flag Key' },
            { key: 'description', label: 'Description' },
            { key: 'enabled', label: 'Enabled', render: v => v ? <StatusBadge status="active" /> : <StatusBadge status="failed" /> },
            { key: 'rollout_pct', label: 'Rollout %' },
            { key: 'segment', label: 'Segment' },
            { key: 'updated_at', label: 'Updated', render: v => fmtDateTime(v) },
            { key: 'id', label: 'Actions', render: v => <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => toggleFlag(v)}>Toggle</Btn> },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function NotificationCenterTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [type, setType] = useState('info')
  const [channel, setChannel] = useState('web')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [audience, setAudience] = useState('all')
  const [scheduledFor, setScheduledFor] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/notifications')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load notifications', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function createNotification() {
    try {
      await ax.post('/api/admin/notifications', {
        type,
        channel,
        title,
        message,
        audience,
        scheduled_for: scheduledFor ? new Date(scheduledFor).toISOString() : null
      })
      setTitle('')
      setMessage('')
      setScheduledFor('')
      showMsg('Notification queued')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not create notification', true)
    }
  }

  async function updateStatus(id, status) {
    try {
      await ax.post(`/api/admin/notifications/${id}/status`, { status })
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not update notification', true)
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading notifications...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Notification Center</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 120px 1fr', gap: '8px', marginBottom: '8px' }}>
          <select value={type} onChange={e => setType(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['info', 'warning', 'success', 'error'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={channel} onChange={e => setChannel(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['web', 'email', 'webhook'].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 220px auto', gap: '8px' }}>
          <textarea rows={2} value={message} onChange={e => setMessage(e.target.value)} placeholder="Notification message"
            style={{ width: '100%', background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={audience} onChange={e => setAudience(e.target.value)} placeholder="Audience"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input
            type="datetime-local"
            value={scheduledFor}
            onChange={e => setScheduledFor(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}
            title="Optional scheduled send time"
          />
          <Btn variant="accent" onClick={createNotification} disabled={!message.trim()}>Create</Btn>
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'created_at', label: 'Created', render: v => fmtDateTime(v) },
            { key: 'type', label: 'Type', render: v => <StatusBadge status={v} /> },
            { key: 'channel', label: 'Channel' },
            { key: 'title', label: 'Title' },
            { key: 'message', label: 'Message' },
            { key: 'audience', label: 'Audience' },
            { key: 'scheduled_for', label: 'Scheduled', render: v => v ? fmtDateTime(v) : '-' },
            { key: 'status', label: 'Status', render: v => <StatusBadge status={v} /> },
            {
              key: 'id',
              label: 'Actions',
              render: (v, row) => (
                <div style={{ display: 'flex', gap: '6px' }}>
                  {row.status !== 'sent' && <Btn variant="green" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => updateStatus(v, 'sent')}>Mark Sent</Btn>}
                  {row.status !== 'cancelled' && <Btn variant="red" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => updateStatus(v, 'cancelled')}>Cancel</Btn>}
                </div>
              )
            },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function CaseManagementTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [sourceType, setSourceType] = useState('manual')
  const [sourceId, setSourceId] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [priority, setPriority] = useState('normal')
  const [owner, setOwner] = useState('')
  const [notes, setNotes] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/cases')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load cases', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function createCase() {
    try {
      await ax.post('/api/admin/cases', {
        title,
        source_type: sourceType,
        source_id: sourceId,
        severity,
        priority,
        owner: owner || null,
        notes
      })
      setTitle('')
      setSourceId('')
      setOwner('')
      setNotes('')
      showMsg('Case created')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not create case', true)
    }
  }

  async function assignCase(id) {
    const newOwner = window.prompt('Assign owner username:')
    if (!newOwner) return
    try {
      await ax.post(`/api/admin/cases/${id}/assign`, { owner: newOwner })
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not assign case', true)
    }
  }

  async function setStatus(id, status) {
    try {
      await ax.post(`/api/admin/cases/${id}/status`, { status })
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not update case status', true)
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading cases...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Case Management</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 120px 150px 120px 120px', gap: '8px', marginBottom: '8px' }}>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Case title"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={sourceType} onChange={e => setSourceType(e.target.value)} placeholder="Source"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={sourceId} onChange={e => setSourceId(e.target.value)} placeholder="Source ID"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <select value={severity} onChange={e => setSeverity(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['low', 'medium', 'high', 'critical'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={priority} onChange={e => setPriority(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['low', 'normal', 'high', 'urgent'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr auto', gap: '8px' }}>
          <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="Owner (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={createCase}>Create Case</Btn>
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'created_at', label: 'Created', render: v => fmtDateTime(v) },
            { key: 'title', label: 'Title' },
            { key: 'source_type', label: 'Source' },
            { key: 'source_id', label: 'Source ID' },
            { key: 'severity', label: 'Severity', render: v => <StatusBadge status={v} /> },
            { key: 'priority', label: 'Priority', render: v => <StatusBadge status={v} /> },
            { key: 'owner', label: 'Owner', render: v => v || 'unassigned' },
            { key: 'status', label: 'Status', render: v => <StatusBadge status={v} /> },
            {
              key: 'id',
              label: 'Actions',
              render: (v, row) => (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => assignCase(v)}>Assign</Btn>
                  {row.status !== 'in_progress' && <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setStatus(v, 'in_progress')}>Start</Btn>}
                  {row.status !== 'resolved' && <Btn variant="green" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => setStatus(v, 'resolved')}>Resolve</Btn>}
                </div>
              )
            },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function DisputeWorkflowTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [nowTick, setNowTick] = useState(Date.now())
  const [selectedId, setSelectedId] = useState('')
  const [owner, setOwner] = useState('')
  const [priority, setPriority] = useState('normal')
  const [slaHours, setSlaHours] = useState('48')
  const [status, setStatus] = useState('under_review')
  const [adminResponse, setAdminResponse] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/dispute-workflow')
      const d = r.data || null
      setData(d)
      if (!selectedId && d?.rows?.length) {
        setSelectedId(String(d.rows[0].dispute_id))
      }
    } catch {
      showMsg('Could not load dispute workflow', true)
    }
    setLoading(false)
  }, [showMsg, selectedId])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 60000)
    return () => clearInterval(t)
  }, [])

  useEffect(() => {
    const row = (data?.rows || []).find(r => String(r.dispute_id) === String(selectedId))
    if (!row) return
    setOwner(row.owner && row.owner !== 'unassigned' ? row.owner : '')
    setPriority(row.priority || 'normal')
    setSlaHours(String(row.sla_hours || 48))
    setStatus(row.status || 'under_review')
  }, [data, selectedId])

  async function updateMeta() {
    if (!selectedId) return
    try {
      await ax.post(`/api/admin/dispute-workflow/${selectedId}/meta`, {
        owner: owner || null,
        priority,
        sla_hours: parseInt(slaHours, 10)
      })
      showMsg('Dispute metadata updated')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not update dispute metadata', true)
    }
  }

  async function updateStatus() {
    if (!selectedId) return
    try {
      await ax.post(`/api/admin/dispute-workflow/${selectedId}/status`, {
        status,
        admin_response: adminResponse
      })
      showMsg('Dispute status updated')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not update dispute status', true)
    }
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading dispute workflow...</div>
  if (!data) return null

  const rows = data.rows || []
  const summary = data.summary || {}

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Dispute Workflow</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(120px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Total" value={summary.total || 0} />
        <StatCard label="Open" value={summary.open || 0} color={COLOR_ACCENT} />
        <StatCard label="Under Review" value={summary.under_review || 0} color="#ffa502" />
        <StatCard label="Resolved" value={summary.resolved || 0} color={COLOR_POS} />
        <StatCard label="Overdue" value={summary.overdue || 0} color="#ff7f50" />
        <StatCard label="Breach" value={summary.breach || 0} color={COLOR_NEG} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 180px 120px 120px 160px auto', gap: '8px', marginBottom: '8px' }}>
          <input value={selectedId} onChange={e => setSelectedId(e.target.value)} placeholder="Dispute ID"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={owner} onChange={e => setOwner(e.target.value)} placeholder="Owner"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <select value={priority} onChange={e => setPriority(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['low', 'normal', 'high', 'urgent'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <input value={slaHours} onChange={e => setSlaHours(e.target.value)} type="number" min="1" max="336" placeholder="SLA Hrs"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="ghost" onClick={updateMeta}>Update Meta</Btn>
          <div />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr auto', gap: '8px' }}>
          <select value={status} onChange={e => setStatus(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['open', 'under_review', 'resolved', 'rejected'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={adminResponse} onChange={e => setAdminResponse(e.target.value)} placeholder="Admin response (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={updateStatus}>Update Status</Btn>
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          onRow={row => setSelectedId(String(row.dispute_id))}
          cols={[
            { key: 'dispute_id', label: 'Dispute ID' },
            { key: 'created_at', label: 'Created', render: v => fmtDateTime(v) },
            { key: 'full_name', label: 'Trader' },
            { key: 'account_uid', label: 'Account' },
            { key: 'reason', label: 'Reason' },
            { key: 'owner', label: 'Owner' },
            { key: 'priority', label: 'Priority', render: v => <StatusBadge status={v} /> },
            { key: 'status', label: 'Status', render: v => <StatusBadge status={v} /> },
            { key: 'age_hours', label: 'Age (h)' },
            {
              key: 'sla_timer',
              label: 'SLA Timer',
              render: (_, row) => {
                const remainingRaw = calcRemainingSlaMinutes(row.created_at, row.sla_hours || 48)
                const remaining = remainingRaw == null ? null : remainingRaw + (nowTick ? 0 : 0)
                if (remaining == null) return '-'
                if (remaining <= 0) return <span style={{ color: COLOR_NEG, fontWeight: 700 }}>Breached</span>
                return <span style={{ color: remaining <= 60 ? '#ff7f50' : 'var(--text)' }}>{fmtTimerMinutes(remaining)}</span>
              }
            },
            { key: 'sla_status', label: 'SLA', render: v => <StatusBadge status={v} /> },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function AccountHealthTab({ showMsg }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/account-health')
      setData(r.data || null)
    } catch {
      showMsg('Could not load account health scores', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading account health scores...</div>
  if (!data) return null

  const summary = data.summary || {}
  const rows = data.rows || []

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Account Health Score</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(130px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Accounts" value={summary.total || 0} />
        <StatCard label="Healthy" value={summary.healthy || 0} color={COLOR_POS} />
        <StatCard label="Watch" value={summary.watch || 0} color="#ffa502" />
        <StatCard label="Critical" value={summary.critical || 0} color={COLOR_NEG} />
        <StatCard label="Avg Score" value={summary.avg_health_score || 0} color={COLOR_ACCENT} />
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
        <Table
          cols={[
            { key: 'account_uid', label: 'Account' },
            { key: 'full_name', label: 'Trader' },
            { key: 'account_type', label: 'Type' },
            { key: 'account_status', label: 'Status', render: v => <StatusBadge status={v} /> },
            {
              key: 'health_score',
              label: 'Health Score',
              render: v => <span style={{ fontWeight: 700, color: v >= 75 ? COLOR_POS : v >= 45 ? '#ffa502' : COLOR_NEG }}>{v}</span>
            },
            { key: 'health_band', label: 'Band', render: v => <StatusBadge status={v} /> },
            { key: 'win_rate_pct', label: 'Win Rate', render: v => `${fmt(v)}%` },
            { key: 'closed_trades', label: 'Closed Trades' },
            { key: 'flagged_payouts', label: 'Flagged Payouts' },
            { key: 'open_disputes', label: 'Open Disputes' },
            { key: 'reasons', label: 'Risk Signals', render: v => (Array.isArray(v) && v.length ? v.join('; ') : '-') },
          ]}
          rows={rows}
        />
      </div>
    </div>
  )
}

function StressTestSimulatorTab({ showMsg }) {
  const [shockPct, setShockPct] = useState('2')
  const [slippagePoints, setSlippagePoints] = useState('0')
  const [instrument, setInstrument] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  async function runSimulation() {
    setLoading(true)
    try {
      const r = await ax.post('/api/admin/stress-simulator', {
        shock_pct: parseFloat(shockPct),
        slippage_points: parseFloat(slippagePoints),
        instrument: instrument.trim().toUpperCase() || null
      })
      setData(r.data || null)
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not run stress simulation', true)
    }
    setLoading(false)
  }

  useEffect(() => { runSimulation() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Stress Test Simulator</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 150px 160px auto', gap: '8px' }}>
          <input type="number" min="0.1" max="25" step="0.1" value={shockPct} onChange={e => setShockPct(e.target.value)}
            placeholder="Shock %"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input type="number" min="0" max="500" step="1" value={slippagePoints} onChange={e => setSlippagePoints(e.target.value)}
            placeholder="Slippage points"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={instrument} onChange={e => setInstrument(e.target.value)} placeholder="Instrument (optional)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <Btn variant="accent" onClick={runSimulation} disabled={loading}>{loading ? 'Running...' : 'Run Simulation'}</Btn>
        </div>
      </div>

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,minmax(130px,1fr))', gap: '10px', marginBottom: '14px' }}>
            <StatCard label="Open Trades" value={data.summary?.open_trades || 0} />
            <StatCard label="Affected Accounts" value={data.summary?.affected_accounts || 0} />
            <StatCard label="Current P&L" value={fmtUSD(data.summary?.current_total_pnl || 0)} color={COLOR_ACCENT} />
            <StatCard label="Stressed P&L" value={fmtUSD(data.summary?.stressed_total_pnl || 0)} color={COLOR_NEG} />
            <StatCard label="P&L Delta" value={fmtUSD(data.summary?.pnl_delta || 0)} color={(data.summary?.pnl_delta || 0) < 0 ? COLOR_NEG : COLOR_POS} />
          </div>
          <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden', marginBottom: '12px' }}>
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--navy-border)', color: 'var(--text)' }}>Account Impact</div>
            <Table
              cols={[
                { key: 'account_uid', label: 'Account' },
                { key: 'full_name', label: 'Trader' },
                { key: 'account_type', label: 'Type' },
                { key: 'trade_count', label: 'Trades' },
                { key: 'current_pnl', label: 'Current P&L', render: v => fmtUSD(v) },
                { key: 'stressed_pnl', label: 'Stressed P&L', render: v => fmtUSD(v) },
                { key: 'pnl_delta', label: 'Delta', render: v => <span style={{ color: v < 0 ? COLOR_NEG : COLOR_POS }}>{fmtUSD(v)}</span> },
              ]}
              rows={data.by_account || []}
            />
          </div>
        </>
      )}
    </div>
  )
}

function ScheduledReportsTab({ showMsg }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState('')
  const [reportKey, setReportKey] = useState('risk_digest')
  const [title, setTitle] = useState('Daily Risk Digest')
  const [channel, setChannel] = useState('email')
  const [recipients, setRecipients] = useState('ops@company.com')
  const [scheduleCron, setScheduleCron] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState('UTC')
  const [nextRun, setNextRun] = useState('')
  const [enabled, setEnabled] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await ax.get('/api/admin/scheduled-reports')
      setRows(r.data || [])
    } catch {
      showMsg('Could not load scheduled reports', true)
    }
    setLoading(false)
  }, [showMsg])
  useEffect(() => { load() }, [load])

  async function save() {
    try {
      await ax.post('/api/admin/scheduled-reports', {
        id: editingId || null,
        report_key: reportKey,
        title,
        channel,
        recipients,
        schedule_cron: scheduleCron,
        timezone,
        enabled,
        next_run_at: nextRun ? new Date(nextRun).toISOString() : null
      })
      showMsg('Scheduled report saved')
      setEditingId('')
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not save scheduled report', true)
    }
  }

  async function toggle(id) {
    try {
      await ax.post(`/api/admin/scheduled-reports/${id}/toggle`)
      load()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not toggle scheduled report', true)
    }
  }

  function edit(row) {
    setEditingId(String(row.id))
    setReportKey(row.report_key || '')
    setTitle(row.title || '')
    setChannel(row.channel || 'email')
    setRecipients(row.recipients || '')
    setScheduleCron(row.schedule_cron || '0 9 * * *')
    setTimezone(row.timezone || 'UTC')
    setNextRun(toDateTimeLocalValue(row.next_run_at))
    setEnabled(!!row.enabled)
  }

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Scheduled Reports</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '14px', marginBottom: '14px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 120px 1fr', gap: '8px', marginBottom: '8px' }}>
          <input value={reportKey} onChange={e => setReportKey(e.target.value)} placeholder="report_key"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <select value={channel} onChange={e => setChannel(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }}>
            {['email', 'web', 'webhook'].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="Recipients (comma-separated)"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px 220px auto auto', gap: '8px', alignItems: 'center' }}>
          <input value={scheduleCron} onChange={e => setScheduleCron(e.target.value)} placeholder="Cron e.g. 0 9 * * *"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input value={timezone} onChange={e => setTimezone(e.target.value)} placeholder="Timezone"
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <input type="datetime-local" value={nextRun} onChange={e => setNextRun(e.target.value)}
            style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
          <label style={{ color: 'var(--text)', fontSize: '13px' }}>
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ marginRight: '6px' }} />
            Enabled
          </label>
          <Btn variant="accent" onClick={save}>{editingId ? 'Update' : 'Create'}</Btn>
        </div>
      </div>
      {loading ? <div style={{ color: 'var(--text-muted)' }}>Loading...</div> : (
        <>
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', overflow: 'hidden' }}>
          <Table
            cols={[
              { key: 'report_key', label: 'Key' },
              { key: 'title', label: 'Title' },
              { key: 'channel', label: 'Channel' },
              { key: 'schedule_cron', label: 'Schedule' },
              { key: 'timezone', label: 'TZ' },
              { key: 'next_run_at', label: 'Next Run', render: v => v ? fmtDateTime(v) : '-' },
              { key: 'enabled', label: 'Enabled', render: v => <StatusBadge status={v ? 'active' : 'disabled'} /> },
              {
                key: 'id',
                label: 'Actions',
                render: (v, row) => (
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => edit(row)}>Edit</Btn>
                    <Btn variant="ghost" style={{ padding: '3px 8px', fontSize: '11px' }} onClick={() => toggle(v)}>
                      {row.enabled ? 'Disable' : 'Enable'}
                    </Btn>
                  </div>
                )
              },
            ]}
            rows={rows}
          />
        </div>
        </>
      )}
    </div>
  )
}

function EmergencyKillSwitchTab({ showMsg }) {
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [preview, setPreview] = useState(null)
  const [confirmPhrase, setConfirmPhrase] = useState('')
  const [reEnableCopier, setReEnableCopier] = useState(false)
  const [working, setWorking] = useState(false)

  async function loadStatus() {
    try {
      const r = await ax.get('/api/admin/emergency-kill/status')
      setStatus(r.data || null)
    } catch {
      showMsg('Could not load emergency kill status', true)
    }
    setLoading(false)
  }
  useEffect(() => { loadStatus() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function runDryRun() {
    setWorking(true)
    try {
      const r = await ax.post('/api/admin/emergency-kill/execute', { dry_run: true })
      setPreview(r.data || null)
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not run dry run', true)
    }
    setWorking(false)
  }

  async function executeKill() {
    setWorking(true)
    try {
      const r = await ax.post('/api/admin/emergency-kill/execute', {
        dry_run: false,
        confirm_phrase: confirmPhrase
      })
      showMsg(`Emergency kill executed. Closed ${r.data?.closed_trades || 0} trades.`)
      setConfirmPhrase('')
      setPreview(null)
      loadStatus()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not execute emergency kill', true)
    }
    setWorking(false)
  }

  async function resetKill() {
    setWorking(true)
    try {
      await ax.post('/api/admin/emergency-kill/reset', { reenable_copier: reEnableCopier })
      showMsg('Emergency kill switch reset')
      loadStatus()
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Could not reset emergency kill switch', true)
    }
    setWorking(false)
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>Loading emergency kill switch...</div>

  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '16px' }}>Emergency Kill Switch</h2>
      <div style={{ background: 'rgba(255,71,87,0.08)', border: '1px solid rgba(255,71,87,0.25)', color: '#ff6b7a', borderRadius: '10px', padding: '12px 14px', marginBottom: '14px', fontSize: '13px' }}>
        Use only during platform emergencies. This action force-closes all open trades and disables copier.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(140px,1fr))', gap: '10px', marginBottom: '14px' }}>
        <StatCard label="Kill Enabled" value={status?.enabled ? 'YES' : 'NO'} color={status?.enabled ? COLOR_NEG : COLOR_POS} />
        <StatCard label="Open Trades" value={status?.open_trades || 0} color={COLOR_ACCENT} />
        <StatCard label="Copier" value={status?.copier_enabled ? 'ON' : 'OFF'} color={status?.copier_enabled ? COLOR_POS : COLOR_NEG} />
        <StatCard label="Last Triggered" value={status?.last_triggered_at ? fmtDateTime(status.last_triggered_at) : '-'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto auto', gap: '8px', alignItems: 'center', marginBottom: '12px' }}>
        <Btn variant="ghost" onClick={runDryRun} disabled={working}>Dry Run</Btn>
        <input value={confirmPhrase} onChange={e => setConfirmPhrase(e.target.value)} placeholder='Type KILL ALL TRADES'
          style={{ background: 'var(--navy-hover)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 10px', color: 'var(--text)' }} />
        <Btn variant="red" onClick={executeKill} disabled={working}>Execute Kill</Btn>
        <Btn variant="ghost" onClick={loadStatus} disabled={working}>Refresh</Btn>
      </div>
      {preview && (
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px' }}>
          <div style={{ color: 'var(--text)', marginBottom: '8px', fontWeight: 600 }}>Dry Run Preview</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' }}>
            Open trades: {preview.open_trades || 0} | Affected accounts: {preview.affected_accounts || 0}
          </div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center' }}>
        <label style={{ color: 'var(--text)', fontSize: '13px' }}>
          <input type="checkbox" checked={reEnableCopier} onChange={e => setReEnableCopier(e.target.checked)} style={{ marginRight: '6px' }} />
          Re-enable copier when resetting kill switch
        </label>
        <Btn variant="accent" onClick={resetKill} disabled={working}>Reset Kill Switch</Btn>
      </div>
    </div>
  )
}

function PlannedFeatureTab({ feature }) {
  if (!feature) return null
  return (
    <div>
      <h2 style={{ color: 'var(--text)', marginBottom: '14px' }}>{feature.label}</h2>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '18px 20px', marginBottom: '14px' }}>
        <div style={{ color: 'var(--text)', fontSize: '14px', marginBottom: '10px' }}>{feature.description}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '12px', lineHeight: '1.6' }}>
          Sidebar module is ready. Backend rules, data models, and automation can now be implemented feature by feature.
        </div>
      </div>
      <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '10px', padding: '16px 20px' }}>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: '8px' }}>IMPLEMENTATION CHECKLIST</div>
        {[
          'Define schema and migrations',
          'Create API endpoints and permissions',
          'Build module UI actions and filters',
          'Add alerts, audit entries, and retries',
          'Add tests and staged rollout gating',
        ].map(step => (
          <div key={step} style={{ fontSize: '13px', color: 'var(--text)', padding: '6px 0' }}>
            - {step}
          </div>
        ))}
      </div>
    </div>
  )
}

function Admin() {
  const [token, setToken]               = useState(false)
  const [checkingSession, setChecking]  = useState(true)
  const [password, setPassword]         = useState('')
  const [activeTab, setActiveTab]       = useState('overview')
  const [overview, setOverview]         = useState(null)
  const [traders, setTraders]           = useState([])
  const [accounts, setAccounts]         = useState([])
  const [payouts, setPayouts]           = useState([])
  const [msg, setMsg]                   = useState({ text: '', isError: false })
  const [loginLoading, setLoginLoading] = useState(false)
  const msgTimer = useRef(null)
  // 2FA admin login state
  const [adminLoginStep, setAdminLoginStep]     = useState('password')  // 'password' | 'totp'
  const [adminPre2faToken, setAdminPre2faToken] = useState('')
  const [totpDigits, setTotpDigits]             = useState(['', '', '', '', '', ''])
  const totpRefs = [useRef(), useRef(), useRef(), useRef(), useRef(), useRef()]

  useEffect(() => { ax.defaults.withCredentials = true }, [])
  useEffect(() => { checkSession() }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (token) {
      fetchAll()
      const iv = setInterval(fetchOverview, 15000)
      return () => clearInterval(iv)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  function showMsg(text, isError = false) {
    if (msgTimer.current) clearTimeout(msgTimer.current)
    setMsg({ text, isError })
    msgTimer.current = setTimeout(() => setMsg({ text: '', isError: false }), 4000)
  }

  function handleAuthExpiry(err) {
    const status = err?.response?.status
    if (status === 401 || status === 403) {
      setToken(false)
      showMsg('Admin session expired. Please log in again.', true)
      return true
    }
    return false
  }

  async function checkSession() {
    try { await ax.get('/api/admin/overview'); setToken(true) } catch { setToken(false) }
    setChecking(false)
  }

  async function handleLogin(e) {
    e.preventDefault()
    setLoginLoading(true)
    try {
      const r = await ax.post('/api/admin/login', { password })
      if (r.data.requires2FA) {
        setAdminPre2faToken(r.data.pre2faToken)
        setAdminLoginStep('totp')
        setTotpDigits(['', '', '', '', '', ''])
        setTimeout(() => totpRefs[0].current?.focus(), 50)
      } else {
        setToken(true); setPassword('')
      }
    } catch { showMsg('Invalid admin password', true) }
    setLoginLoading(false)
  }

  async function handleAdminTotpVerify(code) {
    setLoginLoading(true)
    try {
      await ax.post(
        '/api/admin/2fa/validate',
        { token: code },
        { headers: { Authorization: `Bearer ${adminPre2faToken}` } }
      )
      setToken(true)
      setAdminLoginStep('password')
      setAdminPre2faToken('')
      setPassword('')
    } catch (err) {
      showMsg(err?.response?.data?.error || 'Invalid code. Please try again.', true)
    }
    setLoginLoading(false)
  }

  function handleAdminTotpDigit(index, value) {
    const d = value.replace(/\D/g, '').slice(0, 1)
    const next = [...totpDigits]
    next[index] = d
    setTotpDigits(next)
    if (d && index < 5) totpRefs[index + 1].current?.focus()
    if (d && index === 5) {
      const code = [...next.slice(0, 5), d].join('')
      if (code.length === 6) handleAdminTotpVerify(code)
    }
  }

  function handleAdminTotpKeyDown(index, e) {
    if (e.key === 'Backspace' && !totpDigits[index] && index > 0) {
      totpRefs[index - 1].current?.focus()
    }
    if (e.key === 'Enter') {
      const code = totpDigits.join('')
      if (code.length === 6) handleAdminTotpVerify(code)
    }
  }

  async function handleLogout() {
    try { await ax.post('/api/admin/logout') } catch {}
    setToken(false); setOverview(null); setTraders([]); setAccounts([]); setPayouts([])
    setActiveTab('overview')
  }

  async function fetchAll() {
    fetchOverview(); fetchTraders(); fetchAccounts(); fetchPayouts()
  }

  async function fetchOverview() {
    try {
      const { data: d } = await ax.get('/api/admin/overview')
      setOverview({
        users: {
          total:        d.users?.total        ?? 0,
          pending_kyc:  d.users?.pending_kyc  ?? 0,
          approved_kyc: d.users?.approved_kyc ?? 0,
          banned:       d.users?.banned       ?? 0,
        },
        accounts: {
          phase1:  d.accounts?.phase1  ?? 0,
          phase2:  d.accounts?.phase2  ?? 0,
          funded:  d.accounts?.funded  ?? 0,
          failed:  d.accounts?.failed  ?? 0,
          expired: d.accounts?.expired ?? 0,
          passed:  d.accounts?.passed  ?? 0,
        },
        trading: {
          total_open_trades: d.trades?.open      ?? 0,
          total_demo_pnl:    parseFloat(d.trades?.total_pnl) || 0,
        },
        payouts: {
          pending_payouts: d.payouts?.pending      ?? 0,
          total_paid_out:  parseFloat(d.payouts?.total_paid) || 0,
          flagged_count:   d.payouts?.flagged_count ?? 0,
        },
        exposure: d.exposure  ?? [],
        settings: d.settings  ?? {}
      })
    } catch (err) {
      if (handleAuthExpiry(err)) return
    }
  }

  async function fetchTraders()  {
    try {
      const r = await ax.get('/api/admin/traders')
      setTraders(r.data)
    } catch (err) {
      if (handleAuthExpiry(err)) return
    }
  }
  async function fetchAccounts() {
    try {
      const r = await ax.get('/api/admin/accounts')
      setAccounts(r.data)
    } catch (err) {
      if (handleAuthExpiry(err)) return
    }
  }
  async function fetchPayouts()  {
    try {
      const r = await ax.get('/api/admin/payouts')
      setPayouts(r.data)
    } catch (err) {
      if (handleAuthExpiry(err)) return
    }
  }

  if (!token && checkingSession) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ color: 'var(--text-muted)' }}>Checking session...</div>
      </div>
    )
  }

  if (!token) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--navy)', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: '30%', left: '50%', transform: 'translate(-50%, -50%)', width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(41,98,255,0.06), transparent 70%)', pointerEvents: 'none' }} />
        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--navy-border)', borderRadius: '16px', padding: '40px', width: '400px', position: 'relative', boxShadow: '0 24px 64px rgba(0,0,0,0.4)' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '14px', background: 'linear-gradient(135deg, rgba(41,98,255,0.15), rgba(123,97,255,0.1))', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', border: '1px solid rgba(41,98,255,0.2)' }}>
            <span style={{ fontSize: '22px' }}>{adminLoginStep === 'totp' ? '🔐' : '⚡'}</span>
          </div>
          <h1 style={{ color: 'var(--text)', textAlign: 'center', marginBottom: '6px', fontSize: '22px', fontFamily: 'Inter, sans-serif', fontWeight: 700 }}>ADMIN PANEL</h1>
          <p style={{ color: 'var(--text-dim)', textAlign: 'center', fontSize: '13px', marginBottom: '28px' }}>
            {adminLoginStep === 'totp' ? 'Enter your authenticator code' : 'Prop Firm Control Centre'}
          </p>
          {msg.text && <div style={{ background: msg.isError ? 'rgba(255,71,87,0.08)' : 'rgba(0,200,150,0.08)', border: `1px solid ${msg.isError ? 'rgba(255,71,87,0.2)' : 'rgba(0,200,150,0.2)'}`, color: msg.isError ? '#ff6b7a' : '#00c896', borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', fontSize: '13px' }}>{msg.text}</div>}

          {adminLoginStep === 'password' && (
            <form onSubmit={handleLogin}>
              <Inp label="ADMIN PASSWORD" type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter admin password" />
              <Btn variant="accent" type="submit" style={{ width: '100%', padding: '12px', borderRadius: '10px', background: 'linear-gradient(135deg, #2962ff, #4d82ff)', boxShadow: '0 4px 16px rgba(41,98,255,0.3)' }} disabled={loginLoading}>
                {loginLoading ? 'Logging in...' : 'Login'}
              </Btn>
            </form>
          )}

          {adminLoginStep === 'totp' && (
            <div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '20px' }}
                onPaste={e => {
                  const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
                  if (pasted.length === 6) { setTotpDigits(pasted.split('')); handleAdminTotpVerify(pasted) }
                }}>
                {totpDigits.map((d, i) => (
                  <input
                    key={i}
                    ref={totpRefs[i]}
                    id={`admin-totp-digit-${i}`}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={1}
                    value={d}
                    onChange={e => handleAdminTotpDigit(i, e.target.value)}
                    onKeyDown={e => handleAdminTotpKeyDown(i, e)}
                    style={{
                      width: '44px', height: '52px', textAlign: 'center',
                      fontSize: '22px', fontFamily: 'monospace', fontWeight: 700,
                      background: 'var(--navy-hover)',
                      border: `2px solid ${d ? '#2962ff' : 'var(--navy-border)'}`,
                      borderRadius: '10px', color: 'var(--text)', outline: 'none',
                    }}
                  />
                ))}
              </div>
              <Btn variant="accent"
                onClick={() => handleAdminTotpVerify(totpDigits.join(''))}
                disabled={loginLoading || totpDigits.join('').length < 6}
                style={{ width: '100%', padding: '12px', borderRadius: '10px', marginBottom: '10px', opacity: (loginLoading || totpDigits.join('').length < 6) ? 0.5 : 1 }}>
                {loginLoading ? 'Verifying…' : 'Verify Code'}
              </Btn>
              <button
                onClick={() => { setAdminLoginStep('password'); setAdminPre2faToken(''); showMsg('') }}
                style={{ width: '100%', background: 'transparent', border: '1px solid var(--navy-border)', color: 'var(--text-muted)', padding: '10px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px' }}>
                ← Back
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const implementedFeatureIds = new Set([
    'feat_incident_center',
    'feat_rule_builder',
    'feat_auto_enforcement',
    'feat_account_health',
    'feat_payout_fraud',
    'feat_device_graph',
    'feat_news_protection',
    'feat_rollover_guard',
    'feat_slippage_monitor',
    'feat_feed_anomaly',
    'feat_challenge_funnel',
    'feat_cohort_analytics',
    'feat_aml_velocity',
    'feat_kyc_sla',
    'feat_kyc_quality',
    'feat_immutable_audit',
    'feat_four_eyes',
    'feat_feature_flags',
    'feat_notifications',
    'feat_case_management',
    'feat_dispute_workflow',
    'feat_stress_simulator',
    'feat_scheduled_reports',
    'feat_emergency_kill',
  ])
  const activePlannedFeature = PLANNED_FEATURES.find(
    f => f.id === activeTab && !implementedFeatureIds.has(f.id)
  )

  return (
    <div className="dashboard-layout">
      <aside className="sidebar sidebar-admin" style={{ padding: '14px 12px', borderRight: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <div style={{ padding: '10px 10px 14px', borderBottom: '1px solid var(--border)', marginBottom: '10px' }}>
          <div style={{ color: 'var(--admin-accent)', fontWeight: 700, fontSize: '14px', letterSpacing: '0.08em' }}>ADMIN PORTAL</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '11px', marginTop: '4px' }}>Operations and Risk Control</div>
        </div>

        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', letterSpacing: '0.1em', margin: '8px 10px' }}>LIVE MODULES</div>
        <div className="sidebar-nav" style={{ padding: 0 }}>
          {CORE_TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`sidebar-item ${activeTab === tab.id ? 'active' : ''}`}
              style={{
                width: '100%',
                border: 'none',
                background: activeTab === tab.id ? undefined : 'transparent',
                textAlign: 'left',
              }}
            >
              {tab.label}
            </button>
          ))}

        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', letterSpacing: '0.1em', margin: '14px 10px 8px' }}>
          FEATURE ROADMAP ({PLANNED_FEATURES.length})
        </div>
        {PLANNED_FEATURES.map(feature => (
          <button
            key={feature.id}
            onClick={() => setActiveTab(feature.id)}
            className={`sidebar-item ${activeTab === feature.id ? 'active' : ''}`}
            style={{
              width: '100%',
              border: 'none',
              background: activeTab === feature.id ? undefined : 'transparent',
              textAlign: 'left',
            }}
            title={feature.description}
          >
            {feature.label}
          </button>
        ))}
        </div>

        <div className="sidebar-footer">
          <button className="btn btn-danger" onClick={handleLogout} style={{ width: '100%' }}>
            Logout
          </button>
        </div>
      </aside>

      <div className="dashboard-main animate-fade-up">
        {msg.text && (
          <div style={{
            background: msg.isError ? 'var(--danger-bg)' : 'var(--success-bg)',
            borderBottom: `1px solid ${msg.isError ? 'var(--danger)' : 'var(--success)'}`,
            color: msg.isError ? 'var(--danger)' : 'var(--success)',
            padding: '10px 24px', fontSize: '13px', fontWeight: 500, borderRadius: 'var(--radius-sm)', marginBottom: '16px'
          }}>{msg.text}</div>
        )}

        <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
          {activeTab === 'overview'     && <OverviewTab overview={overview} />}
          {activeTab === 'risk'         && <RiskTab showMsg={showMsg} />}
          {activeTab === 'traders'      && <TradersTab traders={traders} onRefresh={fetchTraders} showMsg={showMsg} />}
          {activeTab === 'accounts'     && <AccountsTab accounts={accounts} onRefresh={() => { fetchAccounts(); fetchOverview() }} showMsg={showMsg} />}
          {activeTab === 'payouts'      && <PayoutsTab payouts={payouts} onRefresh={() => { fetchPayouts(); fetchOverview() }} showMsg={showMsg} />}
          {activeTab === 'suspicious'   && <SuspiciousTab showMsg={showMsg} />}
          {activeTab === 'bbook'        && <BBookTab showMsg={showMsg} />}
          {activeTab === 'auditlog'     && <AuditLogTab showMsg={showMsg} />}
          {activeTab === 'settingslog'  && <SettingsLogTab showMsg={showMsg} />}
          {activeTab === 'settings'     && <SettingsPanelTab showMsg={showMsg} />}
          {activeTab === 'analytics'    && <PlatformAnalyticsTab showMsg={showMsg} />}
          {activeTab === 'pricefeed'    && <PriceFeedTab showMsg={showMsg} />}
          {activeTab === 'riskscores'   && <RiskScoreTab showMsg={showMsg} />}
          {activeTab === 'scaling'      && <ScalingPlanTab accounts={accounts} showMsg={showMsg} />}
          {activeTab === 'chat'         && <ChatTab showMsg={showMsg} />}
          {activeTab === 'support'      && <SupportTab showMsg={showMsg} />}
          {activeTab === 'disputes'     && <DisputesAdminTab showMsg={showMsg} />}
          {activeTab === 'announcement' && <AnnouncementTab showMsg={showMsg} />}
          {activeTab === 'copier'       && <CopierTab showMsg={showMsg} />}
          {activeTab === 'feat_incident_center' && <IncidentCenterTab showMsg={showMsg} />}
          {activeTab === 'feat_rule_builder'    && <RuleBuilderTab showMsg={showMsg} />}
          {activeTab === 'feat_auto_enforcement' && <AutoEnforcementTab accounts={accounts} showMsg={showMsg} />}
          {activeTab === 'feat_account_health'  && <AccountHealthTab showMsg={showMsg} />}
          {activeTab === 'feat_payout_fraud'    && <PayoutFraudScoringTab showMsg={showMsg} />}
          {activeTab === 'feat_device_graph'    && <DeviceIpGraphTab showMsg={showMsg} />}
          {activeTab === 'feat_news_protection' && <NewsProtectionTab showMsg={showMsg} />}
          {activeTab === 'feat_rollover_guard'  && <RolloverGuardTab showMsg={showMsg} />}
          {activeTab === 'feat_slippage_monitor' && <SlippageMonitorTab showMsg={showMsg} />}
          {activeTab === 'feat_feed_anomaly'    && <FeedAnomalyTab showMsg={showMsg} />}
          {activeTab === 'feat_challenge_funnel' && <ChallengeFunnelTab showMsg={showMsg} />}
          {activeTab === 'feat_cohort_analytics' && <CohortAnalyticsTab showMsg={showMsg} />}
          {activeTab === 'feat_aml_velocity'     && <AmlVelocityTab showMsg={showMsg} />}
          {activeTab === 'feat_kyc_sla'          && <KycSlaTab showMsg={showMsg} />}
          {activeTab === 'feat_kyc_quality'      && <KycQualityTab showMsg={showMsg} />}
          {activeTab === 'feat_immutable_audit'  && <ImmutableAuditTab showMsg={showMsg} />}
          {activeTab === 'feat_four_eyes'        && <FourEyesTab showMsg={showMsg} />}
          {activeTab === 'feat_feature_flags'    && <FeatureFlagsTab showMsg={showMsg} />}
          {activeTab === 'feat_notifications'    && <NotificationCenterTab showMsg={showMsg} />}
          {activeTab === 'feat_case_management'  && <CaseManagementTab showMsg={showMsg} />}
          {activeTab === 'feat_dispute_workflow' && <DisputeWorkflowTab showMsg={showMsg} />}
          {activeTab === 'feat_stress_simulator' && <StressTestSimulatorTab showMsg={showMsg} />}
          {activeTab === 'feat_scheduled_reports' && <ScheduledReportsTab showMsg={showMsg} />}
          {activeTab === 'feat_emergency_kill'   && <EmergencyKillSwitchTab showMsg={showMsg} />}
          {activePlannedFeature && <PlannedFeatureTab feature={activePlannedFeature} />}
        </div>
      </div>
    </div>
  )
}

export default Admin

