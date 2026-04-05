import React, { useState, useEffect, useRef } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useToast } from '../../components/admin/AdminToast';

export default function AdminChat() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [threads, setThreads] = useState([]);
  const [selectedThread, setSelectedThread] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [search, setSearch] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    fetchThreads();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedThread) fetchMessages(selectedThread.id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchThreads = async () => {
    setLoadingThreads(true);
    try {
      const res = await adminAxios.get('/api/admin/support/threads').catch(() => ({ data: [] }));
      setThreads(res.data || []);
    } catch {
      toast.error('Failed to load support threads');
    }
    setLoadingThreads(false);
  };

  const fetchMessages = async (threadId) => {
    setLoadingMsgs(true);
    try {
      const res = await adminAxios.get(`/api/admin/support/threads/${threadId}/messages`).catch(() => ({ data: [] }));
      setMessages(res.data || []);
    } catch {
      toast.error('Failed to load messages');
    }
    setLoadingMsgs(false);
  };

  const sendReply = async () => {
    if (!reply.trim() || !selectedThread) return;
    setSending(true);
    try {
      await adminAxios.post(`/api/admin/support/threads/${selectedThread.id}/reply`, {
        message: reply.trim()
      });
      setReply('');
      fetchMessages(selectedThread.id);
      toast.success('Reply sent');
    } catch {
      toast.error('Failed to send reply');
    }
    setSending(false);
  };

  const closeThread = async (threadId) => {
    try {
      await adminAxios.post(`/api/admin/support/threads/${threadId}/close`);
      toast.success('Thread closed');
      fetchThreads();
      if (selectedThread?.id === threadId) setSelectedThread(null);
    } catch {
      toast.error('Failed to close thread');
    }
  };

  const filteredThreads = threads.filter(t =>
    !search || (t.subject || '').toLowerCase().includes(search.toLowerCase()) ||
    (t.user_email || '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - var(--admin-topbar-h) - 48px)', gap: '0' }}>

      {/* LEFT: Thread List */}
      <div style={{
        width: '320px', flexShrink: 0,
        background: 'var(--admin-surface)', borderRight: '1px solid var(--admin-border)',
        display: 'flex', flexDirection: 'column', borderRadius: '12px 0 0 12px'
      }}>
        <div style={{ padding: '20px 16px', borderBottom: '1px solid var(--admin-border)' }}>
          <h2 className="admin-h2" style={{ marginBottom: '12px' }}>Support Chat</h2>
          <div style={{ position: 'relative' }}>
            <span className="admin-search-icon" style={{ top: '50%', transform: 'translateY(-50%)', left: '12px', position: 'absolute', fontSize: '14px' }}>🔍</span>
            <input
              type="text"
              className="admin-search-input"
              placeholder="Search threads..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ paddingLeft: '36px', width: '100%' }}
            />
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loadingThreads ? (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--admin-text-faint)' }}>Loading threads...</div>
          ) : filteredThreads.length === 0 ? (
            <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--admin-text-muted)' }}>
              No support threads found.
            </div>
          ) : filteredThreads.map(t => (
            <div
              key={t.id}
              onClick={() => setSelectedThread(t)}
              style={{
                padding: '14px 16px',
                borderBottom: '1px solid var(--admin-border)',
                cursor: 'pointer',
                background: selectedThread?.id === t.id ? 'var(--admin-elevated)' : 'transparent',
                borderLeft: `3px solid ${t.status === 'open' ? 'var(--admin-accent)' : 'transparent'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ color: 'var(--admin-text)', fontWeight: 600, fontSize: '13px' }}>
                  {t.user_email || `User #${t.user_id}`}
                </div>
                {t.unread_count > 0 && (
                  <span style={{ background: 'var(--admin-danger)', color: '#fff', fontSize: '10px', fontWeight: 700, borderRadius: '10px', padding: '1px 6px' }}>
                    {t.unread_count}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginTop: '4px' }}>
                {t.subject || 'No subject'}
              </div>
              <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px', marginTop: '4px' }}>
                {t.created_at ? new Date(t.created_at).toLocaleDateString() : ''}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* RIGHT: Chat Window */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        background: 'var(--admin-bg)', borderRadius: '0 12px 12px 0',
        border: '1px solid var(--admin-border)', borderLeft: 'none'
      }}>
        {selectedThread ? (
          <>
            {/* Thread Header */}
            <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--admin-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{selectedThread.user_email}</div>
                <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>{selectedThread.subject || 'No subject'}</div>
              </div>
              {selectedThread.status === 'open' && (
                <button className="admin-btn admin-btn-ghost" onClick={() => closeThread(selectedThread.id)}>
                  ✓ Close Thread
                </button>
              )}
            </div>

            {/* Messages */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {loadingMsgs ? (
                <div style={{ color: 'var(--admin-text-faint)', textAlign: 'center' }}>Loading messages...</div>
              ) : messages.length === 0 ? (
                <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>No messages yet.</div>
              ) : messages.map((m, i) => {
                const isAdmin = m.sender === 'admin' || m.is_admin;
                return (
                  <div key={m.id || i} style={{ display: 'flex', flexDirection: isAdmin ? 'row-reverse' : 'row', gap: '12px' }}>
                    <div className="admin-avatar" style={{ width: '32px', height: '32px', fontSize: '12px', flexShrink: 0, background: isAdmin ? 'var(--admin-accent)' : undefined }}>
                      {isAdmin ? 'AD' : (m.sender_name || 'T')[0].toUpperCase()}
                    </div>
                    <div style={{ maxWidth: '70%' }}>
                      <div style={{
                        padding: '12px 16px', borderRadius: isAdmin ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                        background: isAdmin ? 'var(--admin-accent)' : 'var(--admin-surface)',
                        color: isAdmin ? '#fff' : 'var(--admin-text)',
                        fontSize: '13px', lineHeight: '1.5',
                        border: isAdmin ? 'none' : '1px solid var(--admin-border)'
                      }}>
                        {m.message || m.content}
                      </div>
                      <div style={{ fontSize: '11px', color: 'var(--admin-text-faint)', marginTop: '4px', textAlign: isAdmin ? 'right' : 'left' }}>
                        {m.created_at ? new Date(m.created_at).toLocaleTimeString() : ''}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* Reply Box */}
            {selectedThread.status !== 'closed' && (
              <div style={{ padding: '16px 24px', borderTop: '1px solid var(--admin-border)', display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
                <textarea
                  className="admin-textarea"
                  value={reply}
                  onChange={e => setReply(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); } }}
                  placeholder="Type a reply... (Enter to send)"
                  rows={2}
                  style={{ flex: 1, marginBottom: 0, resize: 'none' }}
                />
                <button className="admin-btn admin-btn-primary" onClick={sendReply} disabled={sending || !reply.trim()}>
                  {sending ? '...' : '➤ Send'}
                </button>
              </div>
            )}
          </>
        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-faint)' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
            <div style={{ fontSize: '16px' }}>Select a thread to view conversation.</div>
          </div>
        )}
      </div>
    </div>
  );
}
