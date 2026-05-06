import React, { useState, useEffect, useRef, useCallback } from 'react'
import axios from 'axios'
import { renderIcon } from '../utils/iconMap'



function formatDate(dstr) {
  const d = new Date(dstr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function formatTime(dstr) {
  const d = new Date(dstr)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

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
        <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>Support Chat</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '28px' }}>Chatting with our support team.</p>
        <TicketChat ticket={selectedTicket} user={user} onBack={() => { setSelectedTicket(null); loadTickets() }} />
      </div>
    )
  }

  return (
    <div>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '8px', fontSize: '22px' }}>Support</h2>
      
      <div style={{ display: 'flex', gap: '10px', marginBottom: '24px' }}>
        <button onClick={() => setActiveTab('new')} style={{ padding:'8px 16px', background: activeTab === 'new' ? 'var(--accent)' : 'var(--navy-card)', color: activeTab === 'new' ? '#fff' : 'var(--text-muted)', border:'none', borderRadius:'6px', cursor:'pointer', fontSize: '13px', fontWeight: 600 }}>Submit Ticket</button>
        {user && <button onClick={() => setActiveTab('my-tickets')} style={{ padding:'8px 16px', background: activeTab === 'my-tickets' ? 'var(--accent)' : 'var(--navy-card)', color: activeTab === 'my-tickets' ? '#fff' : 'var(--text-muted)', border:'none', borderRadius:'6px', cursor:'pointer', fontSize: '13px', fontWeight: 600 }}>My Tickets</button>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '24px', alignItems: 'start' }}>
        
        {activeTab === 'new' ? (
          <div className="card" style={{ maxWidth: '600px' }}>
            {error && <div style={{ background: 'rgba(231, 76, 60, 0.1)', border: '1px solid var(--red)', borderRadius: '8px', padding: '12px 16px', marginBottom: '20px', color: 'var(--red)', fontSize: '13px' }}>{error}</div>}
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>CATEGORY</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {CATEGORIES.map(cat => (
                  <button key={cat.value} onClick={() => setForm(f => ({...f, category: cat.value}))} style={{ padding:'10px 12px', borderRadius: '8px', border: form.category === cat.value ? '1px solid var(--accent)' : '1px solid var(--navy-border)', background: form.category === cat.value ? 'rgba(148, 148, 148, 0.1)' : 'var(--navy-card)', color: form.category === cat.value ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer', fontSize: '13px', textAlign: 'left', fontFamily: 'var(--font-ui)' }}>{cat.label}</button>
                ))}
              </div>
            </div>

            {!user && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>YOUR EMAIL *</label>
                <input type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} placeholder="your@email.com" required style={{ width: '100%', fontSize: '14px' }} />
              </div>
            )}

            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>SUBJECT</label>
              <input type="text" value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} placeholder="Brief description" maxLength={120} style={{ width: '100%', fontSize: '14px' }} />
            </div>

            <div style={{ marginBottom: '20px' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '6px', letterSpacing: '0.08em' }}>MESSAGE</label>
              <textarea value={form.message} onChange={e => setForm({...form, message: e.target.value})} placeholder="Describe your issue..." rows={6} maxLength={2000} style={{ width: '100%', fontSize: '14px', resize: 'vertical', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '8px', padding: '10px 14px', color: 'var(--text)', fontFamily: 'var(--font-ui)', lineHeight: '1.6' }} />
            </div>

            <button onClick={handleCreate} disabled={submitting} className="btn" style={{ padding: '12px 32px', fontSize: '14px', fontWeight: '700', cursor: submitting ? 'not-allowed' : 'pointer', background: submitting ? 'var(--navy-border)' : 'var(--accent)' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                {submitting
                  ? renderIcon('timer', { size: 14, color: 'currentColor' })
                  : renderIcon('message', { size: 14, color: 'currentColor' })}
                <span>{submitting ? 'Submitting...' : 'Submit Ticket'}</span>
              </span>
            </button>
          </div>
        ) : (
          <div className="card" style={{ padding: '0', overflow:'hidden' }}>
            {loadingTickets ? <div style={{ padding: '24px', color:'var(--text-muted)' }}>Loading tickets...</div> : 
             tickets.length === 0 ? <div style={{ padding: '40px 24px', textAlign:'center', color:'var(--text-muted)' }}>You have no support tickets.</div> :
             <table style={{ width:'100%', borderCollapse:'collapse' }}>
               <thead>
                 <tr style={{ borderBottom:'1px solid var(--navy-border)', background:'var(--navy)' }}>
                   <th style={{ padding:'12px 16px', textAlign:'left', color:'var(--text-muted)', fontSize:'12px', fontWeight: 600 }}>TICKET</th>
                   <th style={{ padding:'12px 16px', textAlign:'left', color:'var(--text-muted)', fontSize:'12px', fontWeight: 600 }}>STATUS</th>
                   <th style={{ padding:'12px 16px', textAlign:'left', color:'var(--text-muted)', fontSize:'12px', fontWeight: 600 }}>DATE</th>
                 </tr>
               </thead>
               <tbody>
                 {tickets.map(t => (
                   <tr key={t.id} onClick={() => setSelectedTicket(t)} style={{ borderBottom:'1px solid var(--navy-border)', cursor:'pointer', transition: 'background 0.2s' }} onMouseEnter={e => e.currentTarget.style.background='var(--navy-hover)'} onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                     <td style={{ padding:'16px' }}>
                       <div style={{ color:'var(--text)', fontWeight:600, fontSize:'14px' }}>{t.subject}</div>
                       <div style={{ color:'var(--text-dim)', fontSize:'12px', marginTop:'4px' }}>#{t.id} • {t.category.toUpperCase()}</div>
                     </td>
                     <td style={{ padding:'16px' }}>
                       <span style={{ padding:'4px 8px', borderRadius:'4px', fontSize:'11px', fontWeight:600, background: t.status === 'resolved' || t.status === 'closed' ? 'rgba(46, 204, 113, 0.1)' : t.status === 'open' ? 'rgba(231, 76, 60, 0.1)' : 'rgba(148, 148, 148, 0.1)', color: t.status === 'resolved' || t.status === 'closed' ? 'var(--green)' : t.status === 'open' ? 'var(--red)' : 'var(--accent)' }}>
                         {t.status.toUpperCase()}
                       </span>
                     </td>
                     <td style={{ padding:'16px', color:'var(--text-muted)', fontSize:'13px' }}>{formatDate(t.created_at)}</td>
                   </tr>
                 ))}
               </tbody>
             </table>
            }
          </div>
        )}

        {/* ── Help Panel (Sidebar) ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {user && (
            <div className="card" style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '10px', letterSpacing: '0.08em' }}>SUBMITTING AS</div>
              <div style={{ fontSize: '14px', color: 'var(--text)', fontWeight: '600', marginBottom: '4px' }}>{user.full_name}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{user.email}</div>
            </div>
          )}
          <div className="card" style={{ padding: '16px 20px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginBottom: '12px', letterSpacing: '0.08em' }}>RESPONSE TIMES</div>
            {[ { label: 'KYC / Payout', time: '24 hours' }, { label: 'Account Issues', time: '24–48 hours' }, { label: 'Technical Bugs', time: '48–72 hours' } ].map(row => (
              <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px solid var(--navy-border)' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{row.label}</span>
                <span style={{ fontSize: '12px', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>{row.time}</span>
              </div>
            ))}
          </div>
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '65vh', border:'1px solid var(--navy-border)', borderRadius:'12px', background:'var(--navy-card)', overflow:'hidden' }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--navy-border)', display: 'flex', alignItems: 'center', background:'rgba(16, 24, 40, 0.4)' }}>
        <button onClick={onBack} style={{ background:'transparent', border:'none', color:'var(--text-muted)', cursor:'pointer', marginRight:'16px', fontSize:'24px', lineHeight:'1', display: 'inline-flex', alignItems: 'center' }}>
          {renderIcon('arrow', { size: 18, color: 'currentColor', style: { transform: 'rotate(180deg)' } })}
        </button>
        <div>
          <h3 style={{ margin: 0, color: 'var(--text)', fontSize:'16px' }}>{ticket.subject}</h3>
          <div style={{ fontSize: '12px', color: 'var(--text-dim)', marginTop:'4px' }}>Ticket #{ticket.id} • {ticket.status.toUpperCase()}</div>
        </div>
      </div>
      
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display:'flex', flexDirection:'column', gap:'16px' }}>
        {loading ? <div style={{ color:'var(--text-muted)' }}>Loading chat...</div> : (
          <>
            {/* Original message */}
            <div style={{ alignSelf: 'flex-end', maxWidth: '75%' }}>
              <div style={{ fontSize:'11px', color:'var(--text-muted)', marginBottom:'4px', textAlign:'right', marginRight:'4px' }}>You • {formatTime(ticket.created_at)}</div>
              <div style={{ background: 'var(--accent)', color: '#fff', padding: '12px 16px', borderRadius: '16px', borderBottomRightRadius: '4px', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
                {ticket.message}
              </div>
            </div>

            {messages.map(m => (
              <div key={m.id} style={{ alignSelf: m.sender_type === 'user' ? 'flex-end' : 'flex-start', maxWidth: '75%' }}>
                <div style={{ fontSize:'11px', color:'var(--text-muted)', marginBottom:'4px', marginLeft: m.sender_type === 'user' ? 0 : '4px', marginRight: m.sender_type === 'user' ? '4px' : 0, textAlign: m.sender_type === 'user' ? 'right' : 'left' }}>
                  {m.sender_name || (m.sender_type==='admin'?'Support Team':'You')} • {formatTime(m.created_at)}
                </div>
                <div style={{ background: m.sender_type === 'user' ? 'var(--accent)' : 'var(--navy)', color: m.sender_type === 'user' ? '#fff' : 'var(--text)', padding: '12px 16px', borderRadius: '16px', borderBottomRightRadius: m.sender_type === 'user' ? '4px' : '16px', borderBottomLeftRadius: m.sender_type === 'admin' ? '4px' : '16px', lineHeight:'1.5', whiteSpace:'pre-wrap' }}>
                  {m.message}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </>
        )}
      </div>

      <div style={{ padding: '16px', borderTop: '1px solid var(--navy-border)', background:'rgba(16, 24, 40, 0.4)' }}>
        <div style={{ display: 'flex', gap: '12px' }}>
          <input 
             value={reply} 
             onChange={e => setReply(e.target.value)} 
             onKeyDown={e => e.key === 'Enter' && handleSend()}
             placeholder="Type a reply..." 
             style={{ flex: 1, padding: '12px 16px', borderRadius: '24px', border: '1px solid var(--navy-border)', background: 'var(--navy)', color: 'var(--text)', outline: 'none' }} 
             disabled={ticket.status === 'closed'}
          />
          <button 
             onClick={handleSend} 
             disabled={sending || ticket.status === 'closed'} 
             style={{ padding: '0 24px', borderRadius: '24px', background: ticket.status === 'closed' ? 'var(--navy-border)' : 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600, cursor: ticket.status === 'closed' ? 'not-allowed' : 'pointer' }}>
             Send
          </button>
        </div>
        {ticket.status === 'closed' && <div style={{ fontSize:'11px', color:'var(--red)', marginTop:'8px', textAlign:'center' }}>This ticket is closed.</div>}
      </div>
    </div>
  )
}
