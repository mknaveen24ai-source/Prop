import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import './admin.css'
import AdminDataTable from '../../components/admin/AdminDataTable'
import AdminBadge from '../../components/admin/AdminBadge'
import AdminModal from '../../components/admin/AdminModal'
import AdminFilterBar from '../../components/admin/AdminFilterBar'
import { useAdminSession } from '../../providers/AdminSessionProvider'
import { AdminLoginScreen } from './AdminLayout'
import { renderIcon } from '../../utils/iconMap'
import Card from '../../components/ui/Card'

// Standalone admin tool — not nested under AdminLayout/AdminSidebar, reachable
// only via the button in AdminTopBar. Reuses the same Ledger Desk tokens/
// classes (admin.css) so it reads as part of the same product.

const SECTIONS = [
  { id: 'tickets', label: 'Support Tickets', icon: 'chat' },
  { id: 'appeals', label: 'Breach Appeals Queue', icon: 'dispute' },
  { id: 'notifications', label: 'Notification Center', icon: 'bell' },
  { id: 'compliance', label: 'Compliance Log', icon: 'audit-log' },
  { id: 'tos', label: 'ToS & Agreement Tracking', icon: 'journal' },
]

function SectionHeader({ eyebrow, title, subtitle }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <div className="lx-card__eyebrow">{eyebrow}</div>
      <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 2.4vw, 28px)', fontWeight: 700, color: 'var(--admin-text)', margin: '4px 0 8px' }}>
        {title}
      </h1>
      {subtitle && (
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', maxWidth: '640px' }}>{subtitle}</p>
      )}
    </div>
  )
}

function formatCountdown(deadlineIso) {
  const diffMs = new Date(deadlineIso).getTime() - Date.now()
  const breached = diffMs < 0
  const abs = Math.abs(diffMs)
  const hours = Math.floor(abs / (1000 * 60 * 60))
  const mins = Math.floor((abs % (1000 * 60 * 60)) / (1000 * 60))
  const text = `${hours}h ${mins}m`
  return { breached, text: breached ? `-${text}` : text }
}

// ── Support Tickets ─────────────────────────────────────────────────────────

const TICKET_STATUSES = ['All', 'open', 'resolved', 'closed']
const TICKET_STATUS_LABELS = { open: 'Open', resolved: 'Resolved', closed: 'Closed' }

function SupportTicketsSection() {
  const { adminAxios } = useAdminSession()
  const [tickets, setTickets] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [slaRiskOnly, setSlaRiskOnly] = useState(false)
  const [selectedId, setSelectedId] = useState(null)
  const [thread, setThread] = useState([])
  const [noteDraft, setNoteDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [replyDraft, setReplyDraft] = useState('')

  const fetchTickets = async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/support-tickets')
      setTickets(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load support tickets')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchTickets() }, [])

  const selected = tickets.find((t) => t.id === selectedId) || null

  const filtered = tickets.filter((t) => {
    if (statusFilter !== 'All' && t.status !== statusFilter) return false
    if (slaRiskOnly && t.sla_due_at && !formatCountdown(t.sla_due_at).breached && new Date(t.sla_due_at) - Date.now() > 1000 * 60 * 60 * 2) return false
    if (search && !`${t.email || ''} ${t.name || ''} ${t.subject}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const openTicket = async (ticket) => {
    setSelectedId(ticket.id)
    setNoteDraft(ticket.internal_notes || '')
    setReplyDraft('')
    try {
      const res = await adminAxios.get(`/api/admin/support-tickets/${ticket.id}`)
      setThread(res.data?.messages || [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load ticket thread')
    }
  }

  const setStatus = async (status) => {
    try {
      const res = await adminAxios.patch(`/api/admin/support-tickets/${selected.id}`, { status })
      setTickets((current) => current.map((t) => (t.id === selected.id ? res.data.ticket : t)))
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update status')
    }
  }

  const saveNotesAndReply = async () => {
    setSaving(true)
    try {
      const res = await adminAxios.patch(`/api/admin/support-tickets/${selected.id}`, { internal_notes: noteDraft })
      setTickets((current) => current.map((t) => (t.id === selected.id ? res.data.ticket : t)))
      if (replyDraft.trim()) {
        const replyRes = await adminAxios.post(`/api/admin/support-tickets/${selected.id}/reply`, { message: replyDraft })
        setThread((current) => [...current, replyRes.data.reply])
        setReplyDraft('')
      }
      toast.success('Ticket updated')
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to save ticket')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    { header: 'Trader', render: (row) => row.name || row.email || `User #${row.user_id}` || 'Guest' },
    { header: 'Subject', key: 'subject' },
    { header: 'Category', key: 'category' },
    { header: 'Status', render: (row) => <AdminBadge bracket status={row.status === 'resolved' ? 'approved' : row.status === 'closed' ? 'neutral' : 'danger'} label={TICKET_STATUS_LABELS[row.status] || row.status} /> },
    {
      header: 'SLA', render: (row) => {
        if (!row.sla_due_at) return <span style={{ color: 'var(--admin-text-faint)' }}>—</span>
        const { breached, text } = formatCountdown(row.sla_due_at)
        return <span style={{ fontFamily: 'var(--font-mono)', color: breached ? 'var(--admin-danger)' : 'var(--admin-text)' }}>{text}</span>
      }
    },
    { header: 'Agent', render: (row) => row.assigned_agent || <span style={{ color: 'var(--admin-text-faint)' }}>Unassigned</span> },
  ]

  return (
    <>
      <AdminFilterBar searchPlaceholder="Search by trader email/name or keyword..." searchValue={search} onSearchChange={setSearch}>
        {TICKET_STATUSES.map((status) => (
          <button key={status} className={`admin-filter-chip ${statusFilter === status ? 'active' : ''}`} onClick={() => setStatusFilter(status)}>{status === 'All' ? 'All Statuses' : TICKET_STATUS_LABELS[status]}</button>
        ))}
        <button className={`admin-filter-chip ${slaRiskOnly ? 'active' : ''}`} onClick={() => setSlaRiskOnly((v) => !v)}>SLA Breach Risk</button>
      </AdminFilterBar>

      <Card flush>
        <AdminDataTable columns={columns} data={filtered} loading={loading} emptyMessage="No tickets found" emptyIcon="chat" onRowClick={openTicket} />
      </Card>

      <AdminModal isOpen={!!selected} onClose={() => setSelectedId(null)} title={selected ? `Ticket #${selected.id} — ${selected.subject}` : ''} size="lg"
        footer={selected && (
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setSelectedId(null)}>Close</button>
            <button className="admin-btn admin-btn-primary" disabled={saving} onClick={saveNotesAndReply}>{saving ? 'Saving...' : 'Save & Send Reply'}</button>
          </>
        )}
      >
        {selected && (
          <div>
            <div className="admin-form-group">
              <label className="admin-label">Status</label>
              <div style={{ display: 'flex', gap: '10px' }}>
                {['open', 'resolved', 'closed'].map((status) => (
                  <button key={status} className={`admin-filter-chip ${selected.status === status ? 'active' : ''}`} onClick={() => setStatus(status)}>{TICKET_STATUS_LABELS[status]}</button>
                ))}
              </div>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Message Thread</label>
              <div style={{ border: '1px solid var(--rule)', padding: '12px' }}>
                <div style={{ marginBottom: thread.length ? '12px' : 0 }}>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--admin-text-faint)' }}>{selected.name || selected.email || 'Trader'} • {new Date(selected.created_at).toLocaleString()}</div>
                  <div style={{ fontSize: 'var(--fs-md)', color: 'var(--admin-text)' }}>{selected.message}</div>
                </div>
                {thread.map((msg, i) => (
                  <div key={msg.id || i} style={{ marginBottom: i === thread.length - 1 ? 0 : '12px' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--admin-text-faint)' }}>{msg.sender_name} • {new Date(msg.created_at).toLocaleString()}</div>
                    <div style={{ fontSize: 'var(--fs-md)', color: 'var(--admin-text)' }}>{msg.message}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Reply to Trader</label>
              <textarea className="admin-textarea" rows={3} value={replyDraft} onChange={(e) => setReplyDraft(e.target.value)} placeholder="Sent to the trader as an admin reply..." />
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Internal Notes</label>
              <textarea className="admin-textarea" rows={3} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Notes visible only to admin staff..." />
            </div>
          </div>
        )}
      </AdminModal>
    </>
  )
}


// ── Breach Appeals Queue ────────────────────────────────────────────────────

function accountStatusBadge(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'active' || s === 'passed' || s === 'funded') return { status: 'approved', label: status }
  if (s === 'locked' || s === 'failed') return { status: 'danger', label: status || 'Unknown' }
  return { status: 'warning', label: status || 'No Account' }
}

function BreachAppealsSection() {
  const { adminAxios } = useAdminSession()
  const [appeals, setAppeals] = useState([])
  const [loading, setLoading] = useState(true)
  const [breachFilter, setBreachFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [evidence, setEvidence] = useState([])
  const [reviewerNote, setReviewerNote] = useState('')
  const [deciding, setDeciding] = useState(false)

  const fetchAppeals = async () => {
    setLoading(true)
    try {
      // Fetches all violations (not just open) so per-trader appeal history
      // (resolved rows) is available from the same list without a second call.
      const res = await adminAxios.get('/api/admin/violations')
      setAppeals(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load breach appeals')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchAppeals() }, [])

  const selected = appeals.find((a) => a.id === selectedId) || null
  const openQueue = appeals.filter((a) => a.status === 'open')

  const breachTypes = ['All', ...Array.from(new Set(openQueue.map((a) => a.violation_type)))]

  const filtered = openQueue.filter((a) => {
    if (breachFilter !== 'All' && a.violation_type !== breachFilter) return false
    if (search && !String(a.user_id || '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  // Prior appeals by the same trader — derived from the same fetched list
  // rather than a separate endpoint, since violations already carry user_id.
  const historyFor = (userId) => appeals
    .filter((a) => a.user_id === userId && a.status === 'resolved' && a.id !== selectedId)
    .map((a) => ({ date: a.resolved_at ? new Date(a.resolved_at).toLocaleDateString() : '—', outcome: a.resolution_type, reviewer: a.payload_json?.resolved_by_role || 'admin' }))

  const openAppeal = async (appeal) => {
    setSelectedId(appeal.id)
    setReviewerNote('')
    try {
      const res = await adminAxios.get(`/api/admin/violations/${appeal.id}/evidence`)
      setEvidence(res.data?.trades || [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load evidence')
    }
  }

  const decide = async (resolutionType) => {
    if (!reviewerNote.trim() || !selected) return
    setDeciding(true)
    try {
      await adminAxios.post(`/api/admin/violations/${selected.id}/resolve`, { resolution_type: resolutionType, note: reviewerNote })
      if (resolutionType === 'waived' && selected.account_id) {
        await adminAxios.post(`/api/admin/accounts/${selected.account_id}/override`, { action: 'restore_active' })
      }
      toast.success('Appeal decision recorded')
      setSelectedId(null)
      setReviewerNote('')
      fetchAppeals()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to record decision')
    } finally {
      setDeciding(false)
    }
  }

  const columns = [
    { header: 'Trader (User ID)', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{row.user_id}</span> },
    { header: 'Breach Type', key: 'violation_type' },
    { header: 'Detected', render: (row) => new Date(row.first_detected_at).toLocaleString() },
    { header: 'Account Status', render: (row) => { const b = accountStatusBadge(row.account_status); return <AdminBadge bracket status={b.status} label={b.label} /> } },
  ]

  return (
    <>
      <AdminFilterBar searchPlaceholder="Search by user ID..." searchValue={search} onSearchChange={setSearch}>
        {breachTypes.map((type) => (
          <button key={type} className={`admin-filter-chip ${breachFilter === type ? 'active' : ''}`} onClick={() => setBreachFilter(type)}>{type}</button>
        ))}
      </AdminFilterBar>

      <Card flush>
        <AdminDataTable columns={columns} data={filtered} loading={loading} emptyMessage="No open appeals" emptyIcon="dispute" onRowClick={openAppeal} />
      </Card>

      <AdminModal isOpen={!!selected} onClose={() => setSelectedId(null)} title={selected ? `Violation #${selected.id} — ${selected.violation_type}` : ''} size="lg"
        footer={selected && (
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setSelectedId(null)}>Cancel</button>
            <button className="admin-btn admin-btn-warning" disabled={!reviewerNote.trim() || deciding} onClick={() => decide('more_info_requested')}>Request More Info</button>
            <button className="admin-btn admin-btn-danger" disabled={!reviewerNote.trim() || deciding} onClick={() => decide('resolved')}>Deny Appeal</button>
            <button className="admin-btn admin-btn-success" disabled={!reviewerNote.trim() || deciding} onClick={() => decide('waived')}>Approve Appeal</button>
          </>
        )}
      >
        {selected && (
          <div>
            <div className="admin-form-group">
              <label className="admin-label">Violation Message</label>
              <p style={{ fontSize: 'var(--fs-md)', color: 'var(--admin-text)' }}>{selected.message}</p>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Evidence Snapshot (trades around time of breach)</label>
              <Card flush>
                <AdminDataTable
                  columns={[
                    { header: 'Opened', render: (row) => new Date(row.open_time).toLocaleTimeString(), isMono: true },
                    { header: 'Instrument', key: 'instrument' },
                    { header: 'Direction', key: 'direction' },
                    { header: 'Lots', key: 'lot_size', isMono: true },
                    { header: 'PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: (row.demo_pnl || 0) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)' }}>{Number(row.demo_pnl || 0).toFixed(2)}</span> },
                  ]}
                  data={evidence}
                  emptyMessage="No trade data available for this account/window"
                />
              </Card>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Appeal History (this trader)</label>
              {historyFor(selected.user_id).length === 0 ? (
                <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)' }}>No prior appeals.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: '18px', fontSize: 'var(--fs-base)', color: 'var(--admin-text-muted)' }}>
                  {historyFor(selected.user_id).map((h, i) => (
                    <li key={i}>{h.date} — {h.outcome} ({h.reviewer})</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Reviewer Note (required for any decision)</label>
              <textarea className="admin-textarea" rows={3} value={reviewerNote} onChange={(e) => setReviewerNote(e.target.value)} placeholder="Explain the basis for your decision..." />
            </div>
          </div>
        )}
      </AdminModal>
    </>
  )
}

// ── Notification Center ─────────────────────────────────────────────────────
// Real channel/type enums are constrained by the backend (routes/admin.js):
// channel: web | email | webhook (no SMS — dropped from the mock UI since
// there's no SMS provider wired up); type: info | warning | success | error.
// "Send" persists the notification as queued; a scheduler tick
// (services/notificationDeliveryService.js) picks it up, actually delivers it
// (websocket broadcast for "web", real email for "email" — "webhook" always
// fails since no destination is configured yet), and flips the status to
// sent/failed. Status here reflects real delivery, not just composition.

const NOTIFICATION_CHANNELS = ['web', 'email', 'webhook']
const NOTIFICATION_TYPES = ['info', 'warning', 'success', 'error']
const NOTIFICATION_STATUS_BADGE = { sent: 'approved', failed: 'danger', cancelled: 'danger', queued: 'warning', scheduled: 'warning', read: 'info' }

function NotificationCenterSection() {
  const { adminAxios } = useAdminSession()
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState('all')
  const [segmentText, setSegmentText] = useState('')
  const [singleTrader, setSingleTrader] = useState('')
  const [channel, setChannel] = useState('web')
  const [type, setType] = useState('info')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const fetchHistory = async () => {
    setLoading(true)
    try {
      const res = await adminAxios.get('/api/admin/notifications')
      setHistory(Array.isArray(res.data) ? res.data : [])
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load notification history')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchHistory() }, [])

  const send = async () => {
    if (!message.trim()) return
    const audience = scope === 'all' ? 'all' : scope === 'segment' ? (segmentText.trim() || 'segment') : (singleTrader.trim() || 'unknown')
    setSending(true)
    try {
      await adminAxios.post('/api/admin/notifications', { type, channel, title, message: message.trim(), audience })
      toast.success('Notification queued — a background job delivers it within moments')
      setMessage('')
      setTitle('')
      fetchHistory()
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to queue notification')
    } finally {
      setSending(false)
    }
  }

  const columns = [
    { header: 'Created', render: (row) => new Date(row.created_at).toLocaleString(), isMono: true },
    { header: 'Audience', key: 'audience' },
    { header: 'Channel', key: 'channel' },
    { header: 'Type', key: 'type' },
    { header: 'Message', render: (row) => <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>{row.title ? `${row.title} — ` : ''}{row.message}</span> },
    { header: 'Status', render: (row) => <AdminBadge bracket status={NOTIFICATION_STATUS_BADGE[row.status] || 'neutral'} label={row.status} /> },
  ]

  return (
    <>
      <Card style={{ marginBottom: '20px' }}>
        <h2 className="admin-h2">Compose Broadcast</h2>

        <div className="admin-form-group">
          <label className="admin-label">Recipient Scope</label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {[{ id: 'all', label: 'All Traders' }, { id: 'segment', label: 'Segment' }, { id: 'single', label: 'Single Trader' }].map((opt) => (
              <button key={opt.id} className={`admin-filter-chip ${scope === opt.id ? 'active' : ''}`} onClick={() => setScope(opt.id)}>{opt.label}</button>
            ))}
          </div>
        </div>

        {scope === 'segment' && (
          <div className="admin-form-group">
            <label className="admin-label">Segment</label>
            <input className="admin-input" value={segmentText} onChange={(e) => setSegmentText(e.target.value)} placeholder="e.g. funded, phase1, kyc_pending" />
          </div>
        )}

        {scope === 'single' && (
          <div className="admin-form-group">
            <label className="admin-label">Trader Email or User ID</label>
            <input className="admin-input" value={singleTrader} onChange={(e) => setSingleTrader(e.target.value)} placeholder="trader@example.com" />
          </div>
        )}

        <div className="admin-form-group">
          <label className="admin-label">Channel</label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {NOTIFICATION_CHANNELS.map((ch) => (
              <button key={ch} className={`admin-filter-chip ${channel === ch ? 'active' : ''}`} onClick={() => setChannel(ch)}>{ch}</button>
            ))}
          </div>
        </div>

        <div className="admin-form-group">
          <label className="admin-label">Type</label>
          <div style={{ display: 'flex', gap: '10px' }}>
            {NOTIFICATION_TYPES.map((t) => (
              <button key={t} className={`admin-filter-chip ${type === t ? 'active' : ''}`} onClick={() => setType(t)}>{t}</button>
            ))}
          </div>
        </div>

        <div className="admin-form-group">
          <label className="admin-label">Title (optional)</label>
          <input className="admin-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Notification title..." />
        </div>

        <div className="admin-form-group">
          <label className="admin-label">Message</label>
          <textarea className="admin-textarea" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Notification body..." />
        </div>

        <button className="admin-btn admin-btn-primary" disabled={!message.trim() || sending} onClick={send}>{sending ? 'Sending...' : 'Send Notification'}</button>
      </Card>

      <Card flush>
        <AdminDataTable columns={columns} data={history} loading={loading} emptyMessage="No notifications sent yet" emptyIcon="bell" />
      </Card>
    </>
  )
}

// ── Compliance Log ──────────────────────────────────────────────────────────
// Wired to the real, already-populated admin_immutable_audit table
// (hash-chained — every admin action across the whole platform already
// writes here via appendImmutableAudit, not just support/appeals actions).

function toCsv(rows) {
  const header = ['Timestamp', 'Entity', 'Action Type', 'Actor']
  const lines = rows.map((r) => [
    new Date(r.created_at).toISOString(),
    `${r.entity_type || ''}:${r.entity_id || ''}`,
    r.event_type,
    r.actor,
  ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  return [header.join(','), ...lines].join('\n')
}

function ComplianceLogSection() {
  const { adminAxios } = useAdminSession()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [actionType, setActionType] = useState('All')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [knownTypes, setKnownTypes] = useState([])

  const fetchLog = async () => {
    setLoading(true)
    try {
      const params = { limit: 500 }
      if (search.trim()) params.entity_id = search.trim()
      if (actionType !== 'All') params.event_type = actionType
      if (dateFrom) params.created_from = dateFrom
      if (dateTo) params.created_to = dateTo
      const res = await adminAxios.get('/api/admin/audit-log', { params })
      const rows = res.data?.entries || []
      setEntries(rows)
      setKnownTypes((current) => Array.from(new Set([...current, ...rows.map((r) => r.event_type)])).sort())
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load compliance log')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchLog() }, [actionType, dateFrom, dateTo])
  useEffect(() => {
    const timer = setTimeout(fetchLog, 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  const exportCsv = () => {
    const blob = new Blob([toCsv(entries)], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `compliance-log-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const columns = [
    { header: 'Timestamp', render: (row) => new Date(row.created_at).toLocaleString(), isMono: true },
    { header: 'Entity', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{row.entity_type}:{row.entity_id}</span> },
    { header: 'Action Type', key: 'event_type' },
    { header: 'Actor', key: 'actor' },
  ]

  return (
    <>
      <AdminFilterBar searchPlaceholder="Search by trader/account/entity ID..." searchValue={search} onSearchChange={setSearch}>
        <button className={`admin-filter-chip ${actionType === 'All' ? 'active' : ''}`} onClick={() => setActionType('All')}>All Types</button>
        {knownTypes.map((type) => (
          <button key={type} className={`admin-filter-chip ${actionType === type ? 'active' : ''}`} onClick={() => setActionType(type)}>{type}</button>
        ))}
        <input type="date" className="admin-input" style={{ width: '150px' }} value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--admin-text-faint)' }}>to</span>
        <input type="date" className="admin-input" style={{ width: '150px' }} value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        <button className="admin-btn admin-btn-ghost" onClick={exportCsv}>
          {renderIcon('download', { size: 14 })} Export CSV
        </button>
      </AdminFilterBar>

      <Card flush>
        <AdminDataTable columns={columns} data={entries} loading={loading} emptyMessage="No matching log entries" emptyIcon="file" />
      </Card>
    </>
  )
}

// ── ToS & Agreement Tracking ────────────────────────────────────────────────
// New table (user_agreement_acceptances) — registration now records
// acceptance going forward (routes/auth.js + the existing checkbox on
// Register.jsx, which previously blocked submission but recorded nothing).
// Existing users have no row and correctly show as outdated until they
// next accept.

function TosTrackingSection() {
  const { adminAxios } = useAdminSession()
  const [rows, setRows] = useState([])
  const [currentVersion, setCurrentVersion] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    (async () => {
      setLoading(true)
      try {
        const res = await adminAxios.get('/api/admin/tos-acceptance')
        setRows(res.data?.rows || [])
        setCurrentVersion(res.data?.current_version || '')
      } catch (err) {
        toast.error(err?.response?.data?.error || 'Failed to load ToS acceptance records')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const columns = [
    { header: 'Trader', render: (row) => row.full_name || row.email },
    { header: 'Accepted Version', render: (row) => row.tos_version || <span style={{ color: 'var(--admin-text-faint)' }}>Never accepted</span>, isMono: true },
    { header: 'Accepted Date', render: (row) => row.accepted_at ? new Date(row.accepted_at).toLocaleDateString() : '—', isMono: true },
    {
      header: 'Status', render: (row) => row.outdated
        ? <AdminBadge bracket status="warning" label="Outdated" />
        : <AdminBadge bracket status="approved" label="Current" />
    },
  ]

  return (
    <>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', marginBottom: '16px' }}>
        Current agreement version: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-text)' }}>{currentVersion}</span>
      </p>
      <Card flush>
        <AdminDataTable columns={columns} data={rows} loading={loading} emptyMessage="No users found" emptyIcon="journal" />
      </Card>
    </>
  )
}

// ── Page shell ───────────────────────────────────────────────────────────────

const SECTION_META = {
  tickets: { title: 'Support Tickets', subtitle: 'Ticket queue, message threads, and resolution workflow for trader support requests.' },
  appeals: { title: 'Breach Appeals Queue', subtitle: 'Accounts flagged for rule breach requesting manual review.' },
  notifications: { title: 'Notification Center', subtitle: 'Broadcast messages to all traders, a segment, or a single trader.' },
  compliance: { title: 'Compliance Log', subtitle: 'Full audit trail of account actions, violations, appeals, and admin activity.' },
  tos: { title: 'ToS & Agreement Tracking', subtitle: 'Per-trader record of accepted agreement versions.' },
}

export default function SupportAppealsCenter() {
  const { checking, isAuthenticated, refreshSession, session } = useAdminSession()
  const [activeSection, setActiveSection] = useState('tickets')
  const navigate = useNavigate()

  if (checking) {
    return <div className="mode-operator admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>Connecting secure tunnel...</div>
  }

  if (!isAuthenticated) {
    return <AdminLoginScreen onLoginSuccess={refreshSession} />
  }

  const meta = SECTION_META[activeSection]

  return (
    <div className="mode-operator admin-layout">
      <aside className="admin-sidebar">
        <div className="admin-sidebar-header">
          <div className="admin-sidebar-logo">
            {renderIcon('dispute', { size: 18, color: 'var(--admin-accent)' })}
            <span>Support & Appeals</span>
          </div>
        </div>

        <div className="admin-sidebar-scroll">
          <div className="admin-nav-group">
            <div className="admin-nav-label">Sections</div>
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                className={`admin-nav-item ${activeSection === section.id ? 'active' : ''}`}
                style={{ border: 'none', background: 'transparent', width: '100%', textAlign: 'left', font: 'inherit' }}
                onClick={() => setActiveSection(section.id)}
              >
                <span className="admin-nav-icon">
                  {renderIcon(section.icon, { size: 16, color: activeSection === section.id ? 'var(--admin-accent)' : 'var(--admin-text-faint)' })}
                </span>
                <span className="admin-nav-text">{section.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="admin-sidebar-footer">
          <button className="admin-btn admin-btn-ghost" style={{ width: '100%' }} onClick={() => navigate('/admin')}>
            ← Back to Admin Panel
          </button>
        </div>
      </aside>

      <div className="admin-main-wrapper">
        <header className="admin-topbar">
          <div className="admin-topbar-left">
            <div className="admin-breadcrumb">
              Support &amp; Appeals Center <span style={{ color: 'var(--admin-border-strong)' }}>/</span>
              <span className="admin-breadcrumb-active">{meta.title}</span>
            </div>
          </div>
          <div className="admin-topbar-right">
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>{session?.full_name || session?.email}</span>
          </div>
        </header>

        <main className="admin-content">
          <SectionHeader eyebrow="SUPPORT & APPEALS CENTER" title={meta.title} subtitle={meta.subtitle} />
          {activeSection === 'tickets' && <SupportTicketsSection />}
          {activeSection === 'appeals' && <BreachAppealsSection />}
          {activeSection === 'notifications' && <NotificationCenterSection />}
          {activeSection === 'compliance' && <ComplianceLogSection />}
          {activeSection === 'tos' && <TosTrackingSection />}
        </main>
      </div>
    </div>
  )
}
