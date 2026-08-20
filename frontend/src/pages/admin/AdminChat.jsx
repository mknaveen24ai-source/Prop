import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useNavigate } from 'react-router-dom';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource } from '../../utils/adminList';
import { getAdminStatusColor as statusColor } from '../../components/admin/adminStatusTone';
import Card from '../../components/ui/Card';

const DEFAULT_FILTERS = {
  status: 'all',
  unread: 'all'
};

const ALL_COLUMN_KEYS = ['status', 'subject', 'user', 'unread', 'lastMessage', 'updated'];

function buildViewConfig({ search, filters, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    columns: visibleColumnKeys,
    density
  };
}

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleString();
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return date.toLocaleDateString();
}

export default function AdminChat() {
  const { adminAxios, socket, session } = useOutletContext();
  const toast = useToast();
  const navigate = useNavigate();

  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState({});
  const [appealsOpen, setAppealsOpen] = useState(0);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkSaving, setBulkSaving] = useState(false);
  const bottomRef = useRef(null);
  const [traderTyping, setTraderTyping] = useState(false);
  const traderTypingTimeoutRef = useRef(null);
  const [isReplyTyping, setIsReplyTyping] = useState(false);
  const replyTypingTimeoutRef = useRef(null);
  const [traderSnapshot, setTraderSnapshot] = useState(null);
  const [assigning, setAssigning] = useState(false);

  const fetchViews = useCallback(async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'chat_conversations' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  }, [adminAxios]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await adminAxios.get('/api/chat/admin/chat-stats');
      setStats(res.data || {});
    } catch {
      setStats({});
    }
  }, [adminAxios]);

  // Real awareness of the other real support queue (trader appeals) —
  // Support Inbox is one screen with two real queues (Modern Gazette
  // handoff spec's isAdminChat `t.queue` tag). Full unified thread list is
  // a larger follow-up (see plan); this surfaces the count + a jump-off
  // point without touching the working real-time chat architecture.
  const fetchAppealsCount = useCallback(async () => {
    try {
      const res = await adminAxios.get('/api/admin/support-inbox');
      setAppealsOpen(res.data?.summary?.appeals_open || 0);
    } catch {
      setAppealsOpen(0);
    }
  }, [adminAxios]);

  const fetchConversations = useCallback(async (options = {}) => {
    const { silent = false } = options;
    if (!silent) setLoadingConversations(true);
    try {
      const res = await adminAxios.get('/api/chat/admin/conversations', {
        params: {
          status: filters.status !== 'all' ? filters.status : undefined,
          page: 1,
          limit: 100
        }
      });
      const nextConversations = res.data?.conversations || [];
      setConversations(nextConversations);
      setSelectedIds((current) => current.filter((id) => nextConversations.some((conversation) => String(conversation.id) === id)));

      if (selectedConversationId) {
        const match = nextConversations.find((conversation) => conversation.id === selectedConversationId);
        if (!match && !silent) {
          setSelectedConversationId(null);
          setSelectedConversation(null);
          setMessages([]);
        }
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to load support conversations');
    } finally {
      if (!silent) setLoadingConversations(false);
    }
  }, [adminAxios, filters.status, selectedConversationId, toast]);

  const fetchConversation = useCallback(async (conversationId, options = {}) => {
    const { silent = false } = options;
    if (!conversationId) return;
    if (!silent) setLoadingMessages(true);
    try {
      const res = await adminAxios.get(`/api/chat/admin/conversations/${conversationId}`);
      setSelectedConversation(res.data?.conversation || null);
      setMessages(res.data?.messages || []);
      await fetchConversations({ silent: true });
      await fetchStats();
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to load conversation');
    } finally {
      if (!silent) setLoadingMessages(false);
    }
  }, [adminAxios, fetchConversations, fetchStats, toast]);

  useEffect(() => {
    fetchConversations();
    fetchStats();
    fetchViews();
    fetchAppealsCount();
  }, [fetchConversations, fetchStats, fetchViews, fetchAppealsCount]);

  useEffect(() => {
    if (selectedConversationId) {
      fetchConversation(selectedConversationId);
      return;
    }
    setSelectedConversation(null);
    setMessages([]);
  }, [fetchConversation, selectedConversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Trader Snapshot rail — reuses the same /api/admin/traders list endpoint
  // AdminUsers.jsx drives, filtered to this conversation's trader; real data,
  // no separate per-conversation "context" endpoint needed.
  useEffect(() => {
    const email = selectedConversation?.user_email;
    if (!email) { setTraderSnapshot(null); return undefined; }
    let cancelled = false;
    adminAxios.get('/api/admin/traders', { params: { format: 'list', page: 1, page_size: 1, search: email } })
      .then((res) => {
        if (cancelled) return;
        const rows = res.data?.rows || res.data?.allRows || [];
        setTraderSnapshot(rows[0] || null);
      })
      .catch(() => { if (!cancelled) setTraderSnapshot(null); });
    return () => { cancelled = true; };
  }, [adminAxios, selectedConversation?.user_email]);

  const assignToMe = async () => {
    if (!selectedConversation || !session?.email || assigning) return;
    setAssigning(true);
    try {
      await adminAxios.patch(`/api/chat/admin/conversations/${selectedConversation.id}`, { assigned_to: session.email });
      toast.success(`Assigned to ${session.email}`);
      await fetchConversation(selectedConversation.id, { silent: true });
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to assign conversation');
    } finally {
      setAssigning(false);
    }
  };

  // Live updates — the admin socket auto-joins the 'admin' room on connect
  // (see AdminSessionProvider), so this fires whenever any trader sends a
  // message, without polling.
  useEffect(() => {
    if (!socket) return undefined;
    const onNewMessage = (payload) => {
      fetchConversations({ silent: true });
      fetchStats();
      if (selectedConversationId && payload?.conversation_id === selectedConversationId) {
        fetchConversation(selectedConversationId, { silent: true });
      }
    };
    socket.on('chat_new_message', onNewMessage);
    return () => socket.off('chat_new_message', onNewMessage);
  }, [socket, selectedConversationId, fetchConversations, fetchStats, fetchConversation]);

  // Join the conversation's room so the trader's typing_start relay (scoped to
  // `chat:<id>`, see services/socketService.js) actually reaches this admin.
  useEffect(() => {
    if (!socket || !selectedConversationId) return undefined;
    socket.emit('join_chat', selectedConversationId);
    setTraderTyping(false);
    return () => socket.emit('leave_chat', selectedConversationId);
  }, [socket, selectedConversationId]);

  useEffect(() => {
    if (!socket) return undefined;
    const onUserTyping = (data) => {
      if (data?.isAdmin) return; // ignore other admins replying elsewhere
      if (selectedConversationId && data?.conversationId === selectedConversationId) {
        if (traderTypingTimeoutRef.current) clearTimeout(traderTypingTimeoutRef.current);
        if (data.isTyping) {
          setTraderTyping(true);
          traderTypingTimeoutRef.current = setTimeout(() => setTraderTyping(false), 3000);
        } else {
          setTraderTyping(false);
        }
      }
    };
    socket.on('user_typing', onUserTyping);
    return () => socket.off('user_typing', onUserTyping);
  }, [socket, selectedConversationId]);

  const handleReplyChange = (e) => {
    setReply(e.target.value);
    if (!socket || !selectedConversationId) return;
    if (!isReplyTyping) {
      setIsReplyTyping(true);
      socket.emit('typing_start', { conversationId: selectedConversationId, isTyping: true });
    }
    if (replyTypingTimeoutRef.current) clearTimeout(replyTypingTimeoutRef.current);
    replyTypingTimeoutRef.current = setTimeout(() => {
      setIsReplyTyping(false);
      socket.emit('typing_start', { conversationId: selectedConversationId, isTyping: false });
    }, 1000);
  };

  const filteredConversations = useMemo(() => conversations.filter((conversation) => {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        conversation.subject,
        conversation.user_email,
        conversation.user_name,
        conversation.last_message,
        conversation.id
      ].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (filters.unread === 'needs_attention' && !(conversation.unread_admin_count > 0)) return false;
    if (filters.unread === 'resolved_only' && String(conversation.status || '').toLowerCase() !== 'resolved') return false;
    return true;
  }), [conversations, filters.unread, search]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));

  const saveView = async () => {
    const name = window.prompt('Name this support inbox view', 'Needs Attention');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'chat_conversations',
        name,
        config: buildViewConfig({ search, filters, visibleColumnKeys, density })
      });
      toast.success('Saved view created');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save view');
    }
  };

  const updateView = async (view) => {
    try {
      await adminAxios.patch(`/api/admin/saved-views/${view.id}`, {
        config: buildViewConfig({ search, filters, visibleColumnKeys, density })
      });
      toast.success('Saved view updated');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not update view');
    }
  };

  const deleteView = async (view) => {
    if (!window.confirm(`Delete saved view "${view.name}"?`)) return;
    try {
      await adminAxios.delete(`/api/admin/saved-views/${view.id}`);
      setActiveViewId('');
      toast.success('Saved view deleted');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete view');
    }
  };

  const selectView = (viewId) => {
    setActiveViewId(viewId);
    if (!viewId) {
      setSearch('');
      setFilters(DEFAULT_FILTERS);
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      return;
    }
    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setFilters({ ...DEFAULT_FILTERS, ...(config.filters || {}) });
    setVisibleColumnKeys(Array.isArray(config.columns) && config.columns.length > 0 ? config.columns : ALL_COLUMN_KEYS);
    setDensity(config.density || 'comfortable');
  };

  const toggleColumn = (columnKey) => {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  };

  const toggleConversationSelection = (conversationId) => {
    const nextId = String(conversationId);
    setSelectedIds((current) => (
      current.includes(nextId)
        ? current.filter((id) => id !== nextId)
        : [...current, nextId]
    ));
  };

  const updateConversationStatus = async (conversationIds, status) => {
    const ids = Array.isArray(conversationIds) ? conversationIds : [conversationIds];
    if (ids.length === 0) return;
    setBulkSaving(true);
    try {
      await Promise.all(ids.map((id) => adminAxios.patch(`/api/chat/admin/conversations/${id}`, { status })));
      toast.success(`Updated ${ids.length} conversation${ids.length === 1 ? '' : 's'} to ${status}`);

      if (selectedConversationId && ids.includes(selectedConversationId) && selectedConversationId) {
        await fetchConversation(selectedConversationId, { silent: true });
      } else {
        await fetchConversations({ silent: true });
        await fetchStats();
      }
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to update conversation');
    } finally {
      setBulkSaving(false);
    }
  };

  const sendReply = async () => {
    if (!reply.trim() || !selectedConversation) return;
    setSending(true);
    try {
      await adminAxios.post(`/api/chat/admin/conversations/${selectedConversation.id}/messages`, {
        message: reply.trim()
      });
      setReply('');
      await fetchConversation(selectedConversation.id, { silent: true });
      toast.success('Reply sent');
    } catch (error) {
      toast.error(error.response?.data?.error || 'Failed to send reply');
    } finally {
      setSending(false);
    }
  };

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'chat_conversations', {
        search,
        filters: {
          status: filters.status !== 'all' ? filters.status : null,
          unread_only: filters.unread === 'needs_attention' ? true : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export support conversations');
    }
  };

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 className="admin-h1">Support Inbox</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
          Manage trader conversations with saved views, attention filters, and quick bulk status actions.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
        <AdminStatCard icon="OPEN" label="Open" value={Number(stats.open_count || 0).toLocaleString()} />
        <AdminStatCard icon="WAIT" label="Pending" value={Number(stats.pending_count || 0).toLocaleString()} />
        <AdminStatCard icon="READ" label="Needs Attention" value={Number(stats.unread_count || 0).toLocaleString()} />
        <AdminStatCard icon="MSG" label="Messages (24h)" value={Number(stats.messages_24h || 0).toLocaleString()} />
        <AdminStatCard icon="dispute" label="Open Appeals" value={appealsOpen} onClick={() => navigate('/admin/disputes')} />
      </div>

      <Card style={{ marginBottom: 'var(--space-5)' }}>
        <AdminFilterBar
          searchPlaceholder="Search by trader, subject, or latest message"
          searchValue={search}
          onSearchChange={setSearch}
        >
          <select className="admin-select" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="pending">Pending</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select className="admin-select" value={filters.unread} onChange={(event) => setFilters((current) => ({ ...current, unread: event.target.value }))}>
            <option value="all">All attention states</option>
            <option value="needs_attention">Needs admin attention</option>
            <option value="resolved_only">Resolved only</option>
          </select>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="conversations"
          views={views}
          activeViewId={activeViewId}
          onSelectView={selectView}
          onSaveView={saveView}
          onUpdateView={currentView ? () => updateView(currentView) : undefined}
          onDeleteView={currentView ? () => deleteView(currentView) : undefined}
          density={density}
          onDensityChange={setDensity}
          columns={ALL_COLUMN_KEYS.map((key) => ({ key, header: key }))}
          visibleColumnKeys={visibleColumnKeys}
          onToggleColumn={toggleColumn}
          onExport={exportCurrentView}
          selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
          extraActions={(
            <>
              <button className="admin-btn admin-btn-ghost" onClick={() => fetchConversations()} disabled={bulkSaving}>
                Refresh
              </button>
              <button className="admin-btn admin-btn-ghost" disabled={selectedIds.length === 0 || bulkSaving} onClick={() => updateConversationStatus(selectedIds.map(Number), 'pending')}>
                Mark Pending
              </button>
              <button className="admin-btn admin-btn-ghost" disabled={selectedIds.length === 0 || bulkSaving} onClick={() => updateConversationStatus(selectedIds.map(Number), 'resolved')}>
                Resolve
              </button>
              <button className="admin-btn admin-btn-ghost" disabled={selectedIds.length === 0 || bulkSaving} onClick={() => updateConversationStatus(selectedIds.map(Number), 'closed')}>
                Close
              </button>
            </>
          )}
        />
      </Card>

      <div style={{ display: 'flex', height: 'calc(100vh - var(--admin-topbar-h) - 260px)', gap: '0' }}>
        <div style={{
          width: '360px',
          flexShrink: 0,
          background: 'var(--admin-surface)',
          borderRight: '1px solid var(--admin-border)',
          display: 'flex',
          flexDirection: 'column'
        }}>
          <div style={{ padding: 'var(--space-4)', borderBottom: '1px solid var(--admin-border)' }}>
            <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>
              {filteredConversations.length} conversation{filteredConversations.length === 1 ? '' : 's'} in this view
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingConversations ? (
              <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--admin-text-faint)' }}>
                Loading conversations...
              </div>
            ) : filteredConversations.length === 0 ? (
              <div style={{ padding: 'var(--space-8) var(--space-4)', textAlign: 'center', color: 'var(--admin-text-muted)' }}>
                No support conversations match this view.
              </div>
            ) : filteredConversations.map((conversation) => {
              const compact = density === 'compact';
              return (
                <div
                  key={conversation.id}
                  onClick={() => setSelectedConversationId(conversation.id)}
                  style={{
                    padding: compact ? '10px 12px' : '14px 16px',
                    borderBottom: '1px solid var(--admin-border)',
                    cursor: 'pointer',
                    background: selectedConversationId === conversation.id ? 'var(--admin-elevated)' : 'transparent',
                    borderLeft: `3px solid ${selectedConversationId === conversation.id ? 'var(--admin-accent)' : 'transparent'}`
                  }}
                >
                  <div style={{ display: 'flex', gap: 'var(--space-2-5)', alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(String(conversation.id))}
                      onChange={(event) => {
                        event.stopPropagation();
                        toggleConversationSelection(conversation.id);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      style={{ marginTop: 'var(--space-1)' }}
                    />

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-2)' }}>
                        {visibleColumnKeys.includes('user') && (
                          <div style={{ minWidth: 0 }}>
                            <div style={{
                              color: 'var(--admin-text)',
                              fontWeight: 600,
                              fontSize: 'var(--fs-base)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis'
                            }}>
                              {conversation.user_email || conversation.user_name || `User #${conversation.user_id}`}
                            </div>
                            {visibleColumnKeys.includes('subject') && (
                              <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1)' }}>
                                {conversation.subject || 'No subject'}
                              </div>
                            )}
                          </div>
                        )}

                        {conversation.unread_admin_count > 0 && visibleColumnKeys.includes('unread') && (
                          <span style={{
                            background: 'var(--admin-danger)',
                            color: 'var(--paper)',
                            fontSize: 'var(--fs-2xs)',
                            fontWeight: 700,
                            borderRadius: 'var(--radius-pill)',
                            padding: '1px var(--space-1-5)',
                            flexShrink: 0
                          }}>
                            {conversation.unread_admin_count}
                          </span>
                        )}
                      </div>

                      {conversation.last_message && visibleColumnKeys.includes('lastMessage') && (
                        <div style={{
                          color: 'var(--admin-text-faint)',
                          fontSize: 'var(--fs-xs)',
                          marginTop: 'var(--space-1-5)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {conversation.last_message}
                        </div>
                      )}

                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)', gap: 'var(--space-2-5)' }}>
                        {visibleColumnKeys.includes('status') && (
                          <span style={{
                            color: statusColor(conversation.status),
                            fontSize: 'var(--fs-xs)',
                            textTransform: 'uppercase',
                            fontWeight: 700
                          }}>
                            {conversation.status}
                          </span>
                        )}
                        {visibleColumnKeys.includes('updated') && (
                          <span style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>
                            {formatDate(conversation.last_message_at || conversation.created_at)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--admin-bg)',
          border: '1px solid var(--admin-border)',
          borderLeft: 'none'
        }}>
          {selectedConversation ? (
            <>
              <div style={{
                padding: 'var(--space-4) var(--space-6)',
                borderBottom: '1px solid var(--admin-border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 'var(--space-4)'
              }}>
                <div>
                  <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>
                    {selectedConversation.user_email || selectedConversation.user_name || 'Unknown user'}
                  </div>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1)' }}>
                    {selectedConversation.subject || 'No subject'}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', marginTop: 'var(--space-1-5)' }}>
                    <span style={{ color: statusColor(selectedConversation.status), fontSize: 'var(--fs-xs)', textTransform: 'uppercase', fontWeight: 700 }}>
                      {selectedConversation.status}
                    </span>
                    <span style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>
                      {selectedConversation.assigned_to ? `Assigned to ${selectedConversation.assigned_to}` : 'Unassigned'}
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap' }}>
                  <button className="admin-btn admin-btn-ghost" onClick={assignToMe} disabled={assigning || selectedConversation.assigned_to === session?.email}>
                    {selectedConversation.assigned_to === session?.email ? 'Assigned to you' : 'Assign to me'}
                  </button>
                  {selectedConversation.status !== 'pending' && (
                    <button className="admin-btn admin-btn-ghost" onClick={() => updateConversationStatus(selectedConversation.id, 'pending')}>
                      Mark Pending
                    </button>
                  )}
                  {selectedConversation.status !== 'resolved' && (
                    <button className="admin-btn admin-btn-ghost" onClick={() => updateConversationStatus(selectedConversation.id, 'resolved')}>
                      Resolve
                    </button>
                  )}
                  {selectedConversation.status !== 'closed' && (
                    <button className="admin-btn admin-btn-ghost" onClick={() => updateConversationStatus(selectedConversation.id, 'closed')}>
                      Close
                    </button>
                  )}
                </div>
              </div>

              <div style={{
                flex: 1,
                overflowY: 'auto',
                padding: 'var(--space-6)',
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-4)'
              }}>
                {loadingMessages ? (
                  <div style={{ color: 'var(--admin-text-faint)', textAlign: 'center' }}>
                    Loading messages...
                  </div>
                ) : messages.length === 0 ? (
                  <div style={{ color: 'var(--admin-text-muted)', textAlign: 'center' }}>
                    No messages yet.
                  </div>
                ) : messages.map((message, index) => {
                  const isAdmin = Boolean(message.is_admin);
                  return (
                    <div
                      key={message.id || index}
                      style={{ display: 'flex', flexDirection: isAdmin ? 'row-reverse' : 'row', gap: 'var(--space-3)' }}
                    >
                      <div
                        className="admin-avatar"
                        style={{
                          width: '32px',
                          height: '32px',
                          fontSize: 'var(--fs-sm)',
                          flexShrink: 0,
                          background: isAdmin ? 'var(--admin-accent)' : undefined
                        }}
                      >
                        {isAdmin ? 'AD' : String(message.sender_name || 'T').slice(0, 1).toUpperCase()}
                      </div>
                      <div style={{ maxWidth: '70%' }}>
                        <div style={{
                          padding: 'var(--space-3) var(--space-4)',
                          borderRadius: isAdmin ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                          background: isAdmin ? 'var(--admin-accent)' : 'var(--admin-surface)',
                          color: isAdmin ? 'var(--paper)' : 'var(--admin-text)',
                          fontSize: 'var(--fs-base)',
                          lineHeight: '1.5',
                          border: isAdmin ? 'none' : '1px solid var(--admin-border)',
                          whiteSpace: 'pre-wrap'
                        }}>
                          {message.message}
                        </div>
                        <div style={{
                          fontSize: 'var(--fs-xs)',
                          color: 'var(--admin-text-faint)',
                          marginTop: 'var(--space-1)',
                          textAlign: isAdmin ? 'right' : 'left'
                        }}>
                          {message.sender_name || (isAdmin ? 'Support' : 'Trader')} · {formatDateTime(message.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              {traderTyping && (
                <div style={{ padding: 'var(--space-1) var(--space-6)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-faint)', fontStyle: 'italic' }}>
                  Trader is typing…
                </div>
              )}

              {selectedConversation.status !== 'closed' && (
                <div style={{
                  padding: 'var(--space-4) var(--space-6)',
                  borderTop: '1px solid var(--admin-border)',
                  display: 'flex',
                  gap: 'var(--space-3)',
                  alignItems: 'flex-end'
                }}>
                  <textarea
                    className="admin-textarea"
                    value={reply}
                    onChange={handleReplyChange}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendReply();
                      }
                    }}
                    placeholder="Type a reply... (Enter to send)"
                    rows={2}
                    style={{ flex: 1, marginBottom: 0, resize: 'none' }}
                  />
                  <button
                    className="admin-btn admin-btn-primary"
                    onClick={sendReply}
                    disabled={sending || !reply.trim()}
                  >
                    {sending ? 'Sending...' : 'Send'}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--admin-text-faint)'
            }}>
              <div style={{ fontSize: 'var(--fs-lg)' }}>Select a support conversation to view messages.</div>
            </div>
          )}
        </div>

        {selectedConversation && (
          <div style={{ width: '260px', flexShrink: 0, marginLeft: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', overflowY: 'auto' }}>
            <Card title="Trader Snapshot">
              {traderSnapshot ? (
                <>
                  {[
                    { label: 'KYC', value: traderSnapshot.kyc_status || 'pending', tone: statusColor(traderSnapshot.kyc_status || 'pending') },
                    { label: 'Accounts', value: `${traderSnapshot.account_count || 0} total` },
                    { label: 'Active', value: `${traderSnapshot.active_account_count || 0}` },
                    { label: 'Risk Tier', value: traderSnapshot.risk_tier || 'low', tone: statusColor(traderSnapshot.risk_tier === 'critical' ? 'danger' : traderSnapshot.risk_tier === 'high' ? 'warning' : 'info') },
                    { label: 'Country', value: traderSnapshot.country || '—' },
                    { label: 'Joined', value: traderSnapshot.created_at ? formatDate(traderSnapshot.created_at) : '—' },
                  ].map((r) => (
                    <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-2-5)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--admin-border)', fontSize: '12.5px' }}>
                      <span style={{ color: 'var(--admin-text-muted)' }}>{r.label}</span>
                      <span style={{ fontFamily: 'var(--admin-font-mono)', color: r.tone || 'var(--admin-text)', textAlign: 'right', textTransform: 'capitalize' }}>{r.value}</span>
                    </div>
                  ))}
                  <button
                    className="admin-btn admin-btn-ghost admin-btn-full"
                    style={{ width: '100%', marginTop: 'var(--space-3)' }}
                    onClick={() => navigate(`/admin/users?q=${encodeURIComponent(selectedConversation.user_email || '')}`)}
                  >
                    Open full record
                  </button>
                </>
              ) : (
                <div style={{ color: 'var(--admin-text-faint)', fontSize: '12.5px' }}>No trader record found for this conversation.</div>
              )}
            </Card>

            {traderSnapshot && (traderSnapshot.is_banned || (traderSnapshot.kyc_status && traderSnapshot.kyc_status !== 'approved') || ['high', 'critical'].includes(traderSnapshot.risk_tier)) && (
              <Card title="Flags">
                {traderSnapshot.is_banned && (
                  <div style={{ padding: '9px 0', borderBottom: '1px solid var(--admin-border)', fontSize: '12.5px', color: 'var(--admin-danger)' }}>Trader is banned</div>
                )}
                {traderSnapshot.kyc_status && traderSnapshot.kyc_status !== 'approved' && (
                  <div style={{ padding: '9px 0', borderBottom: '1px solid var(--admin-border)', fontSize: '12.5px', color: 'var(--admin-warning)' }}>KYC {traderSnapshot.kyc_status}</div>
                )}
                {['high', 'critical'].includes(traderSnapshot.risk_tier) && (
                  <div style={{ padding: '9px 0', fontSize: '12.5px', color: 'var(--admin-danger)' }}>Risk tier: {traderSnapshot.risk_tier}</div>
                )}
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
