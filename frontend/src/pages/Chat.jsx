import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import io from 'socket.io-client'
import { renderIcon } from '../utils/iconMap'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

// FIX (HIGH #8): Use module-level ref tracking to prevent socket connection leaks
// when component mounts/unmounts rapidly during navigation.
let socketInstance = null
let socketRefCount = 0

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
  const [chatStats, setChatStats] = useState(null)
  const messagesEndRef = useRef(null)

  // Initialize socket connection
  useEffect(() => {
    // FIX (HIGH #8): Use reference counting to prevent connection leaks
    socketRefCount++
    if (!socketInstance) {
      socketInstance = io(API_URL, {
        withCredentials: true,
        transports: ['websocket', 'polling']
      })
      socketInstance.on('connect', () => {
        console.log('Chat socket connected:', socketInstance.id)
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
    loadChatStats()
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

  // User chat stats (not admin stats)
  const loadChatStats = async () => {
    try {
      // Count open conversations and unread messages from user's own data
      const res = await axios.get(`${API_URL}/api/chat/conversations`)
      const conversations = res.data || []
      const openCount = conversations.filter(c => c.status === 'open').length
      const unreadCount = conversations.reduce((sum, c) => sum + (c.unread_user_count || 0), 0)
      setChatStats({
        open_count: openCount,
        unread_count: unreadCount,
        total_conversations: conversations.length
      })
    } catch (error) {
      // Stats are optional, don't show error
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
      await loadChatStats()
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
      await loadChatStats()
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

  return (
    <div className="chat-container">
      <div className="chat-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {renderIcon('message', { size: 20, color: 'var(--accent)' })}
          <span>Live Chat Support</span>
        </h2>
        {chatStats && (
          <div className="chat-stats-badge">
            {chatStats.open_count} active
            {chatStats.unread_count > 0 && (
              <span className="unread-badge">{chatStats.unread_count}</span>
            )}
          </div>
        )}
      </div>

      <div className="chat-main">
        {/* Sidebar - Conversations List */}
        <div className="chat-sidebar">
          <div className="chat-sidebar-header">
            <h3>Conversations</h3>
            <button 
              className="btn-new-chat"
              onClick={() => setShowNewChat(!showNewChat)}
            >
              + New Chat
            </button>
          </div>

          {showNewChat && (
            <form className="new-chat-form" onSubmit={createConversation}>
              <input
                type="text"
                placeholder="What do you need help with?"
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                disabled={sending}
                autoFocus
              />
              <button type="submit" disabled={sending || !newSubject.trim()}>
                {sending ? 'Creating...' : 'Start Chat'}
              </button>
            </form>
          )}

          {loading ? (
            <div className="loading">Loading conversations...</div>
          ) : conversations.length === 0 ? (
            <div className="no-conversations">
              <p>No conversations yet</p>
              <p className="hint">Start a new chat to contact support</p>
            </div>
          ) : (
            <div className="conversations-list">
              {conversations.map(conv => (
                <div
                  key={conv.id}
                  className={`conversation-item ${
                    selectedConversation?.id === conv.id ? 'active' : ''
                  } ${conv.status === 'closed' ? 'closed' : ''}`}
                  onClick={() => loadConversation(conv.id)}
                >
                  <div className="conv-header">
                    <span className="conv-subject">{conv.subject}</span>
                    <span className={`conv-status status-${conv.status}`}>
                      {conv.status}
                    </span>
                  </div>
                  <div className="conv-preview">
                    {conv.last_message && (
                      <span className="last-message">{conv.last_message}</span>
                    )}
                    <span className="conv-time">
                      {conv.last_message_at ? formatTime(conv.last_message_at) : ''}
                    </span>
                  </div>
                  {conv.unread_user_count > 0 && (
                    <span className="unread-count">{conv.unread_user_count}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Main Chat Area */}
        <div className="chat-area">
          {selectedConversation ? (
            <>
              <div className="chat-area-header">
                <div>
                  <h3>{selectedConversation.subject}</h3>
                  <span className={`status-indicator status-${selectedConversation.status}`}>
                    {selectedConversation.status}
                  </span>
                </div>
                {selectedConversation.status !== 'closed' && (
                  <button className="btn-close-chat" onClick={closeConversation}>
                    Close Conversation
                  </button>
                )}
              </div>

              <div className="messages-container">
                {messages.map((msg, index) => {
                  const showDate = index === 0 || 
                    formatDate(messages[index - 1]?.created_at) !== formatDate(msg.created_at)
                  
                  return (
                    <React.Fragment key={msg.id}>
                      {showDate && (
                        <div className="message-date-separator">
                          {formatDate(msg.created_at)}
                        </div>
                      )}
                      <div className={`message ${msg.is_admin ? 'admin' : 'user'}`}>
                        <div className="message-header">
                          <span className="sender-name">
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                              {renderIcon(msg.is_admin ? 'support' : 'profile', {
                                size: 12,
                                color: msg.is_admin ? 'var(--accent)' : 'var(--text-secondary)'
                              })}
                              <span>{msg.is_admin ? 'Support' : 'You'}</span>
                            </span>
                          </span>
                          <span className="message-time">{formatTime(msg.created_at)}</span>
                        </div>
                        <div className="message-body">
                          {msg.message}
                        </div>
                      </div>
                    </React.Fragment>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>

              {supportTyping && (
                <div className="typing-indicator" style={{ padding: '4px 16px', fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                  Support is typing…
                </div>
              )}

              <form className="message-input-form" onSubmit={sendMessage}>
                <input
                  type="text"
                  placeholder="Type your message..."
                  value={newMessage}
                  onChange={handleTyping}
                  disabled={sending || selectedConversation.status === 'closed'}
                  autoFocus
                />
                <button 
                  type="submit" 
                  disabled={sending || !newMessage.trim() || selectedConversation.status === 'closed'}
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </form>

              {selectedConversation.status === 'closed' && (
                <div className="closed-notice">
                  This conversation is closed. Start a new chat if you need further assistance.
                </div>
              )}
            </>
          ) : (
            <div className="no-chat-selected">
              <div className="welcome-chat">
                <h3>Welcome to Live Chat Support</h3>
                <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  {renderIcon('message', { size: 14, color: 'var(--accent)' })}
                  <span>Real-time support from our team</span>
                </p>
                <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  {renderIcon('activity', { size: 14, color: 'var(--accent-green)' })}
                  <span>Average response time: &lt; 5 minutes</span>
                </p>
                <p style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                  {renderIcon('timer', { size: 14, color: 'var(--text-secondary)' })}
                  <span>Available 24/7</span>
                </p>
                <button onClick={() => setShowNewChat(true)}>
                  Start a New Conversation
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <style jsx>{`
        .chat-container {
          display: flex;
          flex-direction: column;
          height: calc(100vh - 80px);
          max-width: 1400px;
          margin: 0 auto;
          padding: 20px;
        }

        .chat-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
          padding-bottom: 15px;
          border-bottom: 1px solid var(--border);
        }

        .chat-header h2 {
          margin: 0;
          font-size: 24px;
          color: var(--text-primary);
        }

        .chat-stats-badge {
          background: var(--success-bg);
          color: var(--success);
          border: 1px solid var(--success);
          padding: 6px 12px;
          border-radius: 20px;
          font-size: 14px;
          position: relative;
          font-weight: 600;
        }

        .unread-badge {
          background: var(--danger);
          color: var(--paper);
          border-radius: 50%;
          padding: 2px 6px;
          font-size: 11px;
          margin-left: 6px;
        }

        .chat-main {
          display: flex;
          flex: 1;
          gap: 20px;
          overflow: hidden;
          background: var(--bg-surface);
          border-radius: 12px;
          border: 1px solid var(--border);
          box-shadow: var(--shadow-md);
        }

        .chat-sidebar {
          width: 320px;
          border-right: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .chat-sidebar-header {
          padding: 15px;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .chat-sidebar-header h3 {
          margin: 0;
          font-size: 16px;
          color: var(--text-primary);
        }

        .btn-new-chat {
          background: var(--accent);
          color: var(--paper);
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
          transition: background 0.2s;
        }

        .btn-new-chat:hover {
          background: var(--accent-hover);
        }

        .new-chat-form {
          padding: 15px;
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .new-chat-form input {
          padding: 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          font-size: 14px;
          background: var(--input-bg);
          color: var(--text-primary);
        }

        .new-chat-form button {
          background: var(--accent);
          color: var(--paper);
          border: none;
          padding: 10px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        }

        .new-chat-form button:disabled {
          background: var(--text-disabled);
          cursor: not-allowed;
        }

        .loading, .no-conversations {
          padding: 30px;
          text-align: center;
          color: var(--text-secondary);
        }

        .no-conversations .hint {
          font-size: 13px;
          color: var(--text-muted);
          margin-top: 10px;
        }

        .conversations-list {
          flex: 1;
          overflow-y: auto;
        }

        .conversation-item {
          padding: 12px 15px;
          border-bottom: 1px solid var(--border);
          cursor: pointer;
          transition: background 0.2s;
        }

        .conversation-item:hover {
          background: var(--bg-hover);
        }

        .conversation-item.active {
          background: rgba(var(--brand-primary-rgb), 0.14);
          border-left: 3px solid var(--accent);
        }

        .conversation-item.closed {
          opacity: 0.6;
        }

        .conv-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 5px;
        }

        .conv-subject {
          font-weight: 500;
          font-size: 14px;
          color: var(--text-primary);
        }

        .conv-status {
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          text-transform: uppercase;
        }

        .status-open { background: rgba(var(--brand-primary-rgb), 0.14); color: var(--accent-hover); }
        .status-pending { background: var(--warning-bg); color: var(--warning); }
        .status-resolved { background: var(--success-bg); color: var(--success); }
        .status-closed { background: var(--bg-hover); color: var(--text-secondary); }

        .conv-preview {
          display: flex;
          justify-content: space-between;
          font-size: 12px;
          color: var(--text-secondary);
        }

        .last-message {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          max-width: 200px;
        }

        .conv-time {
          margin-left: 10px;
          flex-shrink: 0;
        }

        .unread-count {
          background: var(--danger);
          color: var(--paper);
          border-radius: 50%;
          padding: 2px 8px;
          font-size: 11px;
          float: right;
          margin-top: 5px;
        }

        .chat-area {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .chat-area-header {
          padding: 15px 20px;
          border-bottom: 1px solid var(--border);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .chat-area-header h3 {
          margin: 0;
          font-size: 18px;
          color: var(--text-primary);
        }

        .status-indicator {
          font-size: 12px;
          padding: 3px 8px;
          border-radius: 4px;
          margin-left: 10px;
        }

        .btn-close-chat {
          background: var(--danger-bg);
          color: var(--danger);
          border: 1px solid var(--danger);
          padding: 8px 16px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 13px;
        }

        .messages-container {
          flex: 1;
          overflow-y: auto;
          padding: 20px;
          background: var(--paper);
        }

        .message-date-separator {
          text-align: center;
          color: var(--text-muted);
          font-size: 12px;
          margin: 15px 0;
          position: relative;
        }

        .message-date-separator::before,
        .message-date-separator::after {
          content: '';
          position: absolute;
          top: 50%;
          width: 30%;
          height: 1px;
          background: var(--border);
        }

        .message-date-separator::before { left: 0; }
        .message-date-separator::after { right: 0; }

        .message {
          margin-bottom: 15px;
          max-width: 70%;
        }

        .message.user {
          margin-left: auto;
        }

        .message.admin {
          margin-right: auto;
        }

        .message-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 5px;
          font-size: 12px;
        }

        .sender-name {
          font-weight: 500;
        }

        .message-time {
          color: var(--text-muted);
          margin-left: 10px;
        }

        .message-body {
          background: var(--bg-elevated);
          padding: 12px;
          border-radius: 8px;
          border: 1px solid var(--border);
          color: var(--text-primary);
          word-wrap: break-word;
        }

        .message.admin .message-body {
          background: var(--paper-2);
          border-color: var(--rule);
        }

        .message.user .message-body {
          background: var(--accent);
          color: var(--paper);
          border-color: var(--accent);
        }

        .message-input-form {
          padding: 15px 20px;
          border-top: 1px solid var(--border);
          display: flex;
          gap: 10px;
        }

        .message-input-form input {
          flex: 1;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 14px;
          background: var(--input-bg);
          color: var(--text-primary);
        }

        .message-input-form button {
          background: var(--accent);
          color: var(--paper);
          border: none;
          padding: 12px 24px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
        }

        .message-input-form button:disabled {
          background: var(--text-disabled);
          cursor: not-allowed;
        }

        .closed-notice {
          background: var(--warning-bg);
          color: var(--warning);
          padding: 10px 20px;
          text-align: center;
          font-size: 13px;
          border-top: 1px solid var(--warning);
        }

        .no-chat-selected {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--paper);
        }

        .welcome-chat {
          text-align: center;
          padding: 40px;
        }

        .welcome-chat h3 {
          font-size: 22px;
          margin-bottom: 20px;
          color: var(--text-primary);
        }

        .welcome-chat p {
          color: var(--text-secondary);
          margin: 10px 0;
        }

        .welcome-chat button {
          margin-top: 20px;
          background: var(--accent);
          color: var(--paper);
          border: none;
          padding: 12px 30px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 15px;
        }

        @media (max-width: 768px) {
          .chat-sidebar {
            width: 280px;
          }
          
          .message {
            max-width: 85%;
          }
        }
      `}</style>
    </div>
  )
}

export default Chat
