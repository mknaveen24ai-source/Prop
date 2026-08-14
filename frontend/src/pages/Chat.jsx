import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import io from 'socket.io-client'
import { getStatusToneColor } from '../utils/statusTone'
import { API_BASE_URL as API_URL, SOCKET_URL } from '../config/apiBase'


// FIX (HIGH #8): Use module-level ref tracking to prevent socket connection leaks
// when component mounts/unmounts rapidly during navigation.
let socketInstance = null
let socketRefCount = 0

const FAQS = [
  'How long does a payout usually take to process?',
  'What documents do I need for identity verification?',
  'Why was my account flagged for a violation?',
  'Can I trade over the weekend on a funded account?',
]

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'SD'
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('')
}

function Chat() {
  const socketRef = useRef(null) // Track this component's socket reference
  const [conversations, setConversations] = useState([])
  const [selectedConversation, setSelectedConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [newMessage, setNewMessage] = useState('')
  const [newSubject, setNewSubject] = useState('')
  const [showNewChat, setShowNewChat] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  // FIX (MEDIUM #23): Use useRef for typing timeout instead of useState.
  // useState can lead to stale closures where clearTimeout uses an outdated timeout ID.
  const typingTimeoutRef = useRef(null)
  const [supportTyping, setSupportTyping] = useState(false)
  const supportTypingTimeoutRef = useRef(null)
  const messagesEndRef = useRef(null)

  // Initialize socket connection
  useEffect(() => {
    // FIX (HIGH #8): Use reference counting to prevent connection leaks
    socketRefCount++
    if (!socketInstance) {
      socketInstance = io(SOCKET_URL, {
        withCredentials: true,
        transports: ['websocket', 'polling']
      })
    }
    socketRef.current = socketInstance

    socketRef.current.on('chat_new_message', (data) => {
      if (selectedConversation && data.conversation_id === selectedConversation.id) {
        setMessages(prev => [...prev, data.message])
        scrollToBottom()
      }
      // Refresh conversation list to show new message preview
      loadConversations()
    })

    socketRef.current.on('chat_message_received', (data) => {
      if (selectedConversation && data.conversation_id === selectedConversation.id) {
        setMessages(prev => {
          // Avoid duplicate messages
          const exists = prev.find(m => m.id === data.message.id)
          if (exists) return prev
          return [...prev, data.message]
        })
        scrollToBottom()
      }
    })

    socketRef.current.on('user_typing', (data) => {
      // The backend relays this with camelCase `conversationId` and an
      // `isAdmin` flag (services/socketService.js) — only show the indicator
      // for the support side typing in the conversation currently open.
      if (selectedConversation && data.conversationId === selectedConversation.id && data.isAdmin) {
        if (supportTypingTimeoutRef.current) clearTimeout(supportTypingTimeoutRef.current)
        if (data.isTyping) {
          setSupportTyping(true)
          supportTypingTimeoutRef.current = setTimeout(() => setSupportTyping(false), 3000)
        } else {
          setSupportTyping(false)
        }
      }
    })

    return () => {
      // FIX (HIGH #8): Only disconnect when last Chat component unmounts
      socketRefCount--
      if (socketRef.current) {
        socketRef.current.off('chat_new_message')
        socketRef.current.off('chat_message_received')
        socketRef.current.off('user_typing')
      }
      if (socketRefCount === 0 && socketInstance) {
        socketInstance.disconnect()
        socketInstance = null
      }
      socketRef.current = null
    }
  }, [selectedConversation])

  // Join chat room when conversation is selected
  useEffect(() => {
    if (selectedConversation && socketRef.current) {
      socketRef.current.emit('join_chat', selectedConversation.id)
    }
    setSupportTyping(false)
    if (supportTypingTimeoutRef.current) clearTimeout(supportTypingTimeoutRef.current)
    return () => {
      if (selectedConversation && socketRef.current) {
        socketRef.current.emit('leave_chat', selectedConversation.id)
      }
    }
  }, [selectedConversation])

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Load conversations on mount
  useEffect(() => {
    loadConversations()
  }, [])

  const loadConversations = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/chat/conversations`)
      setConversations(res.data)
      setLoading(false)
    } catch (error) {
      console.error('Failed to load conversations:', error)
      setLoading(false)
    }
  }

  const createConversation = async (e) => {
    e.preventDefault()
    if (!newSubject.trim()) return

    try {
      setSending(true)
      const res = await axios.post(`${API_URL}/api/chat/conversations`, {
        subject: newSubject.trim()
      })

      setNewSubject('')
      setShowNewChat(false)
      setSelectedConversation(res.data.conversation)
      setMessages([])
      await loadConversations()
    } catch (error) {
      console.error('Failed to create conversation:', error)
      if (error.response?.data?.conversationId) {
        // Open existing conversation
        const existingId = error.response.data.conversationId
        const existing = conversations.find(c => c.id === existingId)
        if (existing) {
          setSelectedConversation(existing)
          await loadConversation(existingId)
        }
      } else {
        alert(error.response?.data?.error || 'Failed to create conversation')
      }
    } finally {
      setSending(false)
    }
  }

  const loadConversation = async (id) => {
    try {
      const res = await axios.get(`${API_URL}/api/chat/conversations/${id}`)
      setMessages(res.data.messages || [])
      setSelectedConversation(res.data.conversation)
    } catch (error) {
      console.error('Failed to load conversation:', error)
      alert('Failed to load conversation')
    }
  }

  const sendMessage = async (e) => {
    e.preventDefault()
    if (!newMessage.trim() || !selectedConversation) return

    let optimisticId = null

    try {
      setSending(true)
      optimisticId = Date.now()

      const optimisticMessage = {
        id: optimisticId,
        message: newMessage.trim(),
        is_admin: false,
        sender_name: 'You',
        created_at: new Date().toISOString()
      }

      setMessages(prev => [...prev, optimisticMessage])
      setNewMessage('')

      await axios.post(
        `${API_URL}/api/chat/conversations/${selectedConversation.id}/messages`,
        { message: newMessage.trim() }
      )

      await loadConversations()
    } catch (error) {
      console.error('Failed to send message:', error)
      if (optimisticId) {
        setMessages(prev => prev.filter(m => m.id !== optimisticId))
      }
      alert(error.response?.data?.error || 'Failed to send message')
    } finally {
      setSending(false)
    }
  }

  const closeConversation = async () => {
    if (!selectedConversation) return
    if (!window.confirm('Close this conversation? You won\'t be able to send more messages.')) return

    try {
      await axios.patch(`${API_URL}/api/chat/conversations/${selectedConversation.id}/close`)
      await loadConversations()
      setSelectedConversation(null)
      setMessages([])
    } catch (error) {
      console.error('Failed to close conversation:', error)
    }
  }

  const handleTyping = (e) => {
    setNewMessage(e.target.value)

    // Emit typing indicator
    if (socketRef.current && selectedConversation) {
      if (!isTyping) {
        setIsTyping(true)
        socketRef.current.emit('typing_start', {
          conversationId: selectedConversation.id,
          isTyping: true
        })
      }

      // FIX (MEDIUM #23): Use ref for timeout to prevent stale closure issues
      // Clear previous timeout
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current)

      // Set new timeout to stop typing indicator
      typingTimeoutRef.current = setTimeout(() => {
        setIsTyping(false)
        socketRef.current.emit('typing_start', {
          conversationId: selectedConversation.id,
          isTyping: false
        })
      }, 1000)
    }
  }

  const formatTime = (dateString) => {
    const date = new Date(dateString)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const formatDate = (dateString) => {
    const date = new Date(dateString)
    const now = new Date()
    const diff = now - date

    if (diff < 24 * 60 * 60 * 1000) {
      return 'Today'
    } else if (diff < 48 * 60 * 60 * 1000) {
      return 'Yesterday'
    } else {
      return date.toLocaleDateString()
    }
  }

  function sendFaq(question) {
    setNewMessage(question)
  }

  const ticketMeta = selectedConversation ? [
    { label: 'Status', value: selectedConversation.status, tone: getStatusToneColor(selectedConversation.status) },
    { label: 'Assigned to', value: selectedConversation.assigned_to || 'Unassigned', tone: 'var(--ink)' },
    { label: 'Messages', value: String(messages.length), tone: 'var(--ink)' },
    { label: 'Opened', value: formatDate(selectedConversation.created_at), tone: 'var(--muted)' },
    { label: 'Last activity', value: selectedConversation.last_message_at ? formatDate(selectedConversation.last_message_at) : '—', tone: 'var(--muted)' },
  ] : []

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px minmax(0,1fr) 300px', gap: '16px', alignItems: 'start', height: 'calc(100vh - 150px)' }}>
      {/* Conversations rail — real functionality (multiple threads over
          time) beyond the prototype's single-ticket isChat block; kept
          alongside it per the "keep real, add spec pieces" pattern used
          on Trade/Competitions. */}
      <div style={{ background: 'var(--glass)', backdropFilter: 'blur(16px)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontFamily: 'var(--font-display)', fontSize: '15px' }}>Conversations</span>
          <button
            onClick={() => setShowNewChat((v) => !v)}
            style={{ padding: '5px 10px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'transparent', color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '.08em', textTransform: 'uppercase', cursor: 'pointer' }}
          >
            + New
          </button>
        </div>

        {showNewChat && (
          <form onSubmit={createConversation} style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule-soft)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <input
              type="text"
              placeholder="What do you need help with?"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              disabled={sending}
              autoFocus
              style={{ padding: '9px 10px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper)', color: 'var(--ink)', fontSize: '13px' }}
            />
            <button type="submit" disabled={sending || !newSubject.trim()} className="lx-btn lx-btn--sm lx-btn--primary">
              {sending ? 'Creating…' : 'Start Chat'}
            </button>
          </form>
        )}

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>Loading…</div>
          ) : conversations.length === 0 ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>No conversations yet.</div>
          ) : (
            conversations.map((conv) => {
              const active = selectedConversation?.id === conv.id
              return (
                <div
                  key={conv.id}
                  onClick={() => loadConversation(conv.id)}
                  style={{
                    padding: '11px 16px', cursor: 'pointer', borderBottom: '1px solid var(--rule-soft)',
                    borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent',
                    background: active ? 'var(--glass-2)' : 'transparent',
                    opacity: conv.status === 'closed' ? 0.6 : 1,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.subject}</span>
                    {conv.unread_user_count > 0 && (
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', color: 'var(--paper)', background: 'var(--accent)', borderRadius: '99px', padding: '1px 6px', flex: '0 0 auto' }}>{conv.unread_user_count}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                    <span className="lx-badge" style={{ color: getStatusToneColor(conv.status) }}>{conv.status}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', color: 'var(--muted)' }}>{conv.last_message_at ? formatTime(conv.last_message_at) : ''}</span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* Chat panel — matches the prototype's isChat block */}
      <div style={{ background: 'var(--glass)', backdropFilter: 'blur(16px) saturate(140%)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', display: 'flex', flexDirection: 'column', height: '100%' }}>
        {selectedConversation ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '15px 18px', borderBottom: '3px double var(--rule)' }}>
              <div style={{ width: '36px', height: '36px', borderRadius: '50%', border: '1px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--accent)', flex: '0 0 auto' }}>
                {initialsOf(selectedConversation.assigned_to)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: '18px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selectedConversation.assigned_to || 'Support Desk'}</div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '.13em', textTransform: 'uppercase', color: getStatusToneColor(selectedConversation.status), marginTop: '2px' }}>
                  ● {selectedConversation.status}
                </div>
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--muted)', border: '1px solid var(--rule)', borderRadius: '99px', padding: '4px 10px', flex: '0 0 auto' }}>
                Ticket #{selectedConversation.id}
              </div>
              {selectedConversation.status !== 'closed' && (
                <button onClick={closeConversation} className="lx-btn lx-btn--sm" style={{ border: '1px solid var(--loss)', color: 'var(--loss)' }}>
                  Close
                </button>
              )}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {messages.map((msg, index) => {
                const showDate = index === 0 || formatDate(messages[index - 1]?.created_at) !== formatDate(msg.created_at)
                return (
                  <React.Fragment key={msg.id}>
                    {showDate && (
                      <div style={{ textAlign: 'center', fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--muted)' }}>
                        — {formatDate(msg.created_at)} —
                      </div>
                    )}
                    <div style={{ display: 'flex', justifyContent: msg.is_admin ? 'flex-start' : 'flex-end' }}>
                      <div style={{
                        maxWidth: '70%', padding: '11px 14px', borderRadius: '4px',
                        background: msg.is_admin ? 'var(--paper-2)' : 'var(--accent)',
                        border: `1px solid ${msg.is_admin ? 'var(--rule)' : 'var(--accent)'}`,
                        color: msg.is_admin ? 'var(--ink)' : 'var(--paper)',
                      }}>
                        <div style={{ fontSize: '13.5px', lineHeight: 1.55 }}>{msg.message}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', marginTop: '7px', textAlign: 'right', opacity: 0.75 }}>{formatTime(msg.created_at)}</div>
                      </div>
                    </div>
                  </React.Fragment>
                )
              })}
              {supportTyping && (
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--muted)' }}>Support is typing…</div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {selectedConversation.status === 'closed' ? (
              <div style={{ padding: '12px 16px', textAlign: 'center', fontSize: '13px', color: 'var(--muted)', borderTop: '1px solid var(--rule)' }}>
                This conversation is closed. Start a new chat if you need further assistance.
              </div>
            ) : (
              <form onSubmit={sendMessage} style={{ borderTop: '1px solid var(--rule)', padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: '10px' }}>
                <textarea
                  value={newMessage}
                  onChange={handleTyping}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e) } }}
                  placeholder="Write to the desk… (Enter to send)"
                  rows={2}
                  disabled={sending}
                  style={{ flex: 1, resize: 'none', padding: '11px 13px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'var(--paper)', color: 'var(--ink)', fontSize: '13.5px', lineHeight: 1.5 }}
                />
                <button
                  type="submit"
                  disabled={sending || !newMessage.trim()}
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 18px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent)', color: 'var(--paper)', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '.12em', textTransform: 'uppercase', cursor: 'pointer' }}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ textAlign: 'center', padding: '40px' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '20px', marginBottom: '10px' }}>Welcome to Live Chat Support</div>
              <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '6px 0' }}>Start a conversation and the desk will pick it up here.</p>
              <button
                onClick={() => setShowNewChat(true)}
                style={{ marginTop: '16px', padding: '11px 24px', border: '1px solid var(--accent)', borderRadius: '4px', background: 'var(--accent)', color: 'var(--paper)', fontFamily: 'var(--font-mono)', fontSize: '11px', letterSpacing: '.12em', textTransform: 'uppercase', cursor: 'pointer' }}
              >
                Start a New Conversation
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right rail — ticket meta + FAQs, matches the prototype */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {selectedConversation && (
          <div style={{ background: 'var(--glass)', backdropFilter: 'blur(16px) saturate(140%)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', padding: '16px 18px' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px', borderBottom: '1px solid var(--rule)', paddingBottom: '10px', marginBottom: '4px' }}>This Ticket</div>
            {ticketMeta.map((r) => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '9px 0', borderBottom: '1px solid var(--rule-soft)', fontSize: '12.5px' }}>
                <span style={{ color: 'var(--muted)' }}>{r.label}</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: r.tone, textAlign: 'right', textTransform: r.label === 'Status' ? 'capitalize' : 'none' }}>{r.value}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ background: 'var(--glass)', backdropFilter: 'blur(16px) saturate(140%)', border: '1px solid var(--rule)', borderRadius: '4px', boxShadow: 'var(--elev)', padding: '16px 18px' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: '17px', borderBottom: '1px solid var(--rule)', paddingBottom: '10px', marginBottom: '12px' }}>Common Answers</div>
          {FAQS.map((q) => (
            <button
              key={q}
              onClick={() => sendFaq(q)}
              disabled={!selectedConversation || selectedConversation.status === 'closed'}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', marginBottom: '6px', border: '1px solid var(--rule)', borderRadius: '4px', background: 'transparent', color: 'var(--ink)', fontSize: '12.5px', cursor: 'pointer' }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default Chat
