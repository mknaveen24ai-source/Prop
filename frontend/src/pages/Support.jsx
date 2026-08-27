import React, { useState, useEffect, useRef, useCallback } from 'react'
import { rowInteractionProps } from '../utils/interactive'
import axios from 'axios'
import { renderIcon } from '../utils/iconMap'
import Card from '../components/ui/Card'
import { API_BASE_URL as API_URL } from '../config/apiBase'



function formatDate(dstr) {
  const d = new Date(dstr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatTime(dstr) {
  const d = new Date(dstr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}


const CATEGORIES = [
  { value: 'account',   label: 'Account Issue' },
  { value: 'trading',   label: 'Trading Problem' },
  { value: 'kyc',       label: 'KYC / Verification' },
  { value: 'payout',    label: 'Payout Request' },
  { value: 'technical', label: 'Technical Bug' },
  { value: 'other',     label: 'Other' },
]

export default function Support({ user }) {
  const [activeTab, setActiveTab] = useState('new')
  const [tickets, setTickets] = useState([])
  const [loadingTickets, setLoadingTickets] = useState(false)
  
  const [selectedTicket, setSelectedTicket] = useState(null)
  
  const [form, setForm] = useState({ category: 'account', subject: '', message: '', email: user?.email || '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (user && activeTab === 'my-tickets') {
      loadTickets()
    }
  }, [user, activeTab])

  async function loadTickets() {
    setLoadingTickets(true)
    try {
      const res = await axios.get(`${API_URL}/api/support/tickets`, { withCredentials: true })
      setTickets(res.data || [])
    } catch { /* ignore */ }
    setLoadingTickets(false)
  }

  async function handleCreate(e) {
    e.preventDefault()
    setError('')
    if (!form.subject.trim() || form.message.trim().length < 20) return setError('Subject and a message (min 20 chars) are required.')
    setSubmitting(true)
    try {
      await axios.post(`${API_URL}/api/support/ticket`, {
        category: form.category, subject: form.subject.trim(), message: form.message.trim(),
        email: user?.email || form.email, name: user?.full_name
      }, { withCredentials: true })
      setForm({ category: 'account', subject: '', message: '', email: user?.email || '' })
      setActiveTab('my-tickets')
      if (user) loadTickets()
    } catch (err) { setError(err.response?.data?.error || 'Failed to submit ticket.') }
    setSubmitting(false)
  }

  if (!user && activeTab === 'my-tickets') setActiveTab('new')

  if (selectedTicket) {
    return (
      <div>
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 'var(--space-2)', fontSize: 'var(--fs-3xl)' }}>Support Chat</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)', marginBottom: 'var(--space-7)' }}>Chatting with our support team.</p>
        <TicketChat ticket={selectedTicket} user={user} onBack={() => { setSelectedTicket(null); loadTickets() }} />
      </div>
    )
  }

  return (
    <div className="trader-service-page trader-support-page">
      <h2 className="trader-service-title">Support</h2>
      
      <div className="service-tabs">
        <button onClick={() => setActiveTab('new')} className={`service-tab ${activeTab === 'new' ? 'is-active' : ''}`}>Submit Ticket</button>
        {user && <button onClick={() => setActiveTab('my-tickets')} className={`service-tab ${activeTab === 'my-tickets' ? 'is-active' : ''}`}>My Tickets</button>}
      </div>

      <div className="trader-service-layout">
        
        {activeTab === 'new' ? (
          <Card className="trader-service-card">
            {error && <div style={{ background: 'color-mix(in srgb, var(--red) 10%, transparent)', border: '1px solid var(--red)', padding: 'var(--space-3) var(--space-4)', marginBottom: 'var(--space-5)', color: 'var(--red)', fontSize: 'var(--fs-base)' }}>{error}</div>}
            
            <div className="input-group">
              <label className="input-label">CATEGORY</label>
              <div className="service-choice-grid">
                {CATEGORIES.map(cat => (
                  <button key={cat.value} onClick={() => setForm(f => ({...f, category: cat.value}))} className={`service-choice-button ${form.category === cat.value ? 'is-active' : ''}`}>{cat.label}</button>
                ))}
              </div>
            </div>

            {!user && (
              <div className="input-group">
                <label className="input-label">YOUR EMAIL *</label>
                <input className="input-field" type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder="your@email.com" required />
              </div>
            )}

            <div className="input-group">
              <label className="input-label">SUBJECT</label>
              <input className="input-field" type="text" value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} placeholder="Brief description" maxLength={120} />
            </div>

            <div className="input-group">
              <label className="input-label">MESSAGE</label>
              <textarea className="textarea-field service-textarea" value={form.message} onChange={e => setForm({...form, message: e.target.value})} placeholder="Describe your issue..." rows={6} maxLength={2000} />
            </div>

            <button onClick={handleCreate} disabled={submitting} className="btn btn-primary service-submit-button">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                {submitting
                  ? renderIcon('timer', { size: 14, color: 'currentColor' })
                  : renderIcon('message', { size: 14, color: 'currentColor' })}
                <span>{submitting ? 'Submitting...' : 'Submit Ticket'}</span>
              </span>
            </button>
          </Card>
        ) : (
          <Card flush className="trader-service-card service-table-card">
            {loadingTickets ? <div style={{ padding: 'var(--space-6)', color:'var(--text-muted)' }}>Loading tickets...</div> : 
             tickets.length === 0 ? <div style={{ padding: 'var(--space-8) var(--space-6)', textAlign:'center', color:'var(--text-muted)' }}>You have no support tickets.</div> :
             <div className="lx-table-wrap">
             <table style={{ width:'100%', borderCollapse:'collapse' }}>
               <thead>
                 <tr style={{ borderBottom:'1px solid var(--navy-border)', background:'var(--navy)' }}>
                   <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign:'left', color:'var(--text-muted)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>TICKET</th>
                   <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign:'left', color:'var(--text-muted)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>STATUS</th>
                   <th style={{ padding: 'var(--space-3) var(--space-4)', textAlign:'left', color:'var(--text-muted)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>DATE</th>
                 </tr>
               </thead>
               <tbody>
                 {tickets.map(t => (
                   <tr key={t.id} {...rowInteractionProps(() => setSelectedTicket(t))} style={{ borderBottom:'1px solid var(--navy-border)', cursor:'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background='var(--navy-hover)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                     <td style={{ padding: 'var(--space-4)' }}>
                       <div style={{ color:'var(--text)', fontWeight:600, fontSize: 'var(--fs-md)' }}>{t.subject}</div>
                       <div style={{ color:'var(--text-dim)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1)' }}>#{t.id} • {t.category.toUpperCase()}</div>
                     </td>
                     <td style={{ padding: 'var(--space-4)' }}>
                       <span style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--fs-xs)', fontWeight:600, background: t.status === 'resolved' || t.status === 'closed' ? 'color-mix(in srgb, var(--green) 10%, transparent)' : t.status === 'open' ? 'color-mix(in srgb, var(--red) 10%, transparent)' : 'color-mix(in srgb, var(--muted) 10%, transparent)', color: t.status === 'resolved' || t.status === 'closed' ? 'var(--green)' : t.status === 'open' ? 'var(--red)' : 'var(--accent)' }}>
                         {t.status.toUpperCase()}
                       </span>
                     </td>
                     <td style={{ padding: 'var(--space-4)', color:'var(--text-muted)', fontSize: 'var(--fs-base)' }}>{formatDate(t.created_at)}</td>
                   </tr>
                 ))}
               </tbody>
             </table>
             </div>
            }
          </Card>
        )}

        {/* ── Help Panel (Sidebar) ── */}
        <div className="service-side-panel">
          {user && (
            <Card style={{ padding: 'var(--space-4) var(--space-5)' }}>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 'var(--space-2-5)', letterSpacing: '0.08em' }}>SUBMITTING AS</div>
              <div style={{ fontSize: 'var(--fs-md)', color: 'var(--text)', fontWeight: '600', marginBottom: 'var(--space-1)' }}>{user.full_name}</div>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{user.email}</div>
            </Card>
          )}
          <Card style={{ padding: 'var(--space-4) var(--space-5)' }}>
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 'var(--space-3)', letterSpacing: '0.08em' }}>RESPONSE TIMES</div>
            {[ { label: 'KYC / Payout', time: '24 hours' }, { label: 'Account Issues', time: '24–48 hours' }, { label: 'Technical Bugs', time: '48–72 hours' } ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--navy-border)' }}>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>{row.label}</span>
                <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{row.time}</span>
              </div>
            ))}
          </Card>
        </div>

      </div>
    </div>
  )
}

function TicketChat({ ticket, user, onBack }) {
  const [messages, setMessages] = useState([])
  const [reply, setReply] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const bottomRef = useRef()

  const loadThread = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/support/ticket/${ticket.id}`, { withCredentials: true })
      setMessages(res.data.messages || [])
    } catch (err) {}
    setLoading(false)
  }, [ticket.id])

  useEffect(() => { loadThread() }, [loadThread])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  async function handleSend() {
    if (!reply.trim()) return
    setSending(true)
    try {
      await axios.post(`${API_URL}/api/support/ticket/${ticket.id}/reply`, { message: reply }, { withCredentials: true })
      setReply('')
      loadThread()
    } catch {}
    setSending(false)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '65vh', border:'1px solid var(--navy-border)', background:'var(--navy-card)', overflow:'hidden' }}>
      <div style={{ padding: 'var(--space-4) var(--space-5)', borderBottom: '1px solid var(--navy-border)', display: 'flex', alignItems: 'center', background:'color-mix(in srgb, var(--navy) 40%, transparent)' }}>
        <button onClick={onBack} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', marginRight: 'var(--space-4)', fontSize: 'var(--fs-4xl)', lineHeight:'1', display: 'inline-flex', alignItems: 'center' }}>
          {renderIcon('arrow', { size: 18, color: 'currentColor', style: { transform: 'rotate(180deg)' } })}
        </button>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text)', fontSize: 'var(--fs-lg)' }}>{ticket.subject}</h3>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginTop: 'var(--space-1)' }}>Ticket #{ticket.id} • {ticket.status.toUpperCase()}</div>
        </div>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-6)', display:'flex', flexDirection:'column', gap: 'var(--space-4)' }}>
        {loading ? <div style={{ color:'var(--text-muted)' }}>Loading chat...</div> : (
          <>
            {/* Original message */}
            <div style={{ alignSelf: 'flex-end', maxWidth: '75%' }}>
              <div style={{ fontSize: 'var(--fs-xs)', color:'var(--text-muted)', marginBottom: 'var(--space-1)', textAlign:'right', marginRight: 'var(--space-1)' }}>You • {formatTime(ticket.created_at)}</div>
              <div style={{ background: 'var(--accent)', color: 'var(--paper)', padding: 'var(--space-3) var(--space-4)', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
                {ticket.message}
              </div>
            </div>

            {messages.map(m => (
              <div key={m.id} style={{ alignSelf: m.sender_type === 'user' ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                <div style={{ fontSize: 'var(--fs-xs)', color:'var(--text-muted)', marginBottom: 'var(--space-1)', marginLeft: m.sender_type === 'user' ? 0 : '4px', marginRight: m.sender_type === 'user' ? '4px' : 0, textAlign: m.sender_type === 'user' ? 'right' : 'left' }}>
                  {m.sender_name || (m.sender_type==='admin'?'Support Team':'You')} • {formatTime(m.created_at)}
                </div>
                <div style={{ background: m.sender_type === 'user' ? 'var(--accent)' : 'var(--navy)', color: m.sender_type === 'user' ? 'var(--paper)' : 'var(--text)', padding: 'var(--space-3) var(--space-4)', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
                  {m.message}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--navy-border)', background:'color-mix(in srgb, var(--navy) 40%, transparent)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
          <input
             value={reply}
             onChange={e => setReply(e.target.value)}
             onKeyDown={e => e.key === 'Enter' && handleSend()}
             placeholder="Type a reply..."
             style={{ flex: 1, padding: 'var(--space-3) var(--space-4)', borderRadius: 'var(--radius-pill)', border: '1px solid var(--navy-border)', background: 'var(--navy)', color: 'var(--text)', outline: 'none' }}
             disabled={ticket.status === 'closed'}
          />
          <button
             onClick={handleSend}
             disabled={sending || ticket.status === 'closed'}
             style={{ padding: '0 var(--space-6)', borderRadius: 'var(--radius-pill)', background: ticket.status === 'closed' ? 'var(--navy-border)' : 'var(--accent)', color: 'var(--paper)', border: 'none', fontWeight: 600, cursor: ticket.status === 'closed' ? 'not-allowed' : 'pointer' }}>
             Send
          </button>
        </div>
        {ticket.status === 'closed' && <div style={{ fontSize: 'var(--fs-xs)', color:'var(--red)', marginTop: 'var(--space-2)', textAlign:'center' }}>This ticket is closed.</div>}
      </div>
    </div>
  )
}
