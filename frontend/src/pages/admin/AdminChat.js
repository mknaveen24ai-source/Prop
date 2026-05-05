import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource } from '../../utils/adminList';

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

function statusColor(status) {
  if (status === 'open') return 'var(--admin-accent)';
  if (status === 'pending') return 'var(--admin-warning)';
  if (status === 'resolved') return 'var(--admin-success)';
  return 'var(--admin-text-faint)';
}

export default function AdminChat() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [conversations, setConversations] = useState([]);
  const [stats, setStats] = useState({});
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
  }, [fetchConversations, fetchStats, fetchViews]);

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
      <div style={{ marginBottom: '24px' }}>
        <h1 className="admin-h1">Support Inbox</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
          Manage trader conversations with saved views, attention filters, and quick bulk status actions.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="OPEN" label="Open" value={Number(stats.open_count || 0).toLocaleString()} />
        <AdminStatCard icon="WAIT" label="Pending" value={Number(stats.pending_count || 0).toLocaleString()} />
        <AdminStatCard icon="READ" label="Needs Attention" value={Number(stats.unread_count || 0).toLocaleString()} />
        <AdminStatCard icon="MSG" label="Messages (24h)" value={Number(stats.messages_24h || 0).toLocaleString()} />
      </div>

      <div className="admin-card" style={{ marginBottom: '20px' }}>
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
      </div>

      <div style={{ display: 'flex', height: 'calc(100vh - var(--admin-topbar-h) - 260px)', gap: '0' }}>
        <div style={{
          width: '360px',
          flexShrink: 0,
          background: 'var(--admin-surface)',
          borderRight: '1px solid var(--admin-border)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px 0 0 12px'
        }}>
          <div style={{ padding: '16px', borderBottom: '1px solid var(--admin-border)' }}>
            <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>
              {filteredConversations.length} conversation{filteredConversations.length === 1 ? '' : 's'} in this view
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {loadingConversations ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--admin-text-faint)' }}>
                Loading conversations...
              </div>
            ) : filteredConversations.length === 0 ? (
              <div style={{ padding: '40px 16px', textAlign: 'center', color: 'var(--admin-text-muted)' }}>
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
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(String(conversation.id))}
                      onChange={(event) => {
                        event.stopPropagation();
                        toggleConversationSelection(conversation.id);
                      }}
                      onClick={(event) => event.stopPropagation()}
                      style={{ marginTop: '4px' }}
                    />

                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                        {visibleColumnKeys.includes('user') && (
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: 'var(--admin-text)', fontWeight: 600, fontSize: '13px' }}>
                              {conversation.user_email || conversation.user_name || `User #${conversation.user_id}`}
                            </div>
                            {visibleColumnKeys.includes('subject') && (
                              <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginTop: '4px' }}>
                                {conversation.subject || 'No subject'}
                              </div>
                            )}
                          </div>
                        )}

                        {conversation.unread_admin_count > 0 && visibleColumnKeys.includes('unread') && (
                          <span style={{
                            background: 'var(--admin-danger)',
                            color: '#fff',
                            fontSize: '10px',
                            fontWeight: 700,
                            borderRadius: '10px',
                            padding: '1px 6px',
                            flexShrink: 0
                          }}>
                            {conversation.unread_admin_count}
                          </span>
                        )}
                      </div>

                      {conversation.last_message && visibleColumnKeys.includes('lastMessage') && (
                        <div style={{
                          color: 'var(--admin-text-faint)',
                          fontSize: '11px',
                          marginTop: '6px',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {conversation.last_message}
                        </div>
                      )}

                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', gap: '10px' }}>
                        {visibleColumnKeys.includes('status') && (
                          <span style={{
                            color: statusColor(conversation.status),
                            fontSize: '11px',
                            textTransform: 'uppercase',
                            fontWeight: 700
                          }}>
                            {conversation.status}
                          </span>
                        )}
                        {visibleColumnKeys.includes('updated') && (
                          <span style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>
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
          borderRadius: '0 12px 12px 0',
          border: '1px solid var(--admin-border)',
          borderLeft: 'none'
        }}>
          {selectedConversation ? (
            <>
              <div style={{
                padding: '16px 24px',
                borderBottom: '1px solid var(--admin-border)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '16px'
              }}>
                <div>
                  <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>
                    {selectedConversation.user_email || selectedConversation.user_name || 'Unknown user'}
                  </div>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginTop: '4px' }}>
                    {selectedConversation.subject || 'No subject'}
                  </div>
                  <div style={{ color: statusColor(selectedConversation.status), fontSize: '11px', marginTop: '6px', textTransform: 'uppercase', fontWeight: 700 }}>
                    {selectedConversation.status}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
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
                padding: '24px',
                display: 'flex',
                flexDirection: 'column',
                gap: '16px'
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
                      style={{ display: 'flex', flexDirection: isAdmin ? 'row-reverse' : 'row', gap: '12px' }}
                    >
                      <div
                        className="admin-avatar"
                        style={{
                          width: '32px',
                          height: '32px',
                          fontSize: '12px',
                          flexShrink: 0,
                          background: isAdmin ? 'var(--admin-accent)' : undefined
                        }}
                      >
                        {isAdmin ? 'AD' : String(message.sender_name || 'T').slice(0, 1).toUpperCase()}
                      </div>
                      <div style={{ maxWidth: '70%' }}>
                        <div style={{
                          padding: '12px 16px',
                          borderRadius: isAdmin ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
                          background: isAdmin ? 'var(--admin-accent)' : 'var(--admin-surface)',
                          color: isAdmin ? '#fff' : 'var(--admin-text)',
                          fontSize: '13px',
                          lineHeight: '1.5',
                          border: isAdmin ? 'none' : '1px solid var(--admin-border)',
                          whiteSpace: 'pre-wrap'
                        }}>
                          {message.message}
                        </div>
                        <div style={{
                          fontSize: '11px',
                          color: 'var(--admin-text-faint)',
                          marginTop: '4px',
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

              {selectedConversation.status !== 'closed' && (
                <div style={{
                  padding: '16px 24px',
                  borderTop: '1px solid var(--admin-border)',
                  display: 'flex',
                  gap: '12px',
                  alignItems: 'flex-end'
                }}>
                  <textarea
                    className="admin-textarea"
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
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
              <div style={{ fontSize: '16px' }}>Select a support conversation to view messages.</div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
