import React, { useEffect, useMemo, useState } from 'react';
import AdminBadge from './AdminBadge';
import Card from '../ui/Card';
import Sparkline from '../ui/Sparkline';

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export default function AdminEntityDrawer({
  open,
  entityType,
  row,
  title,
  adminAxios,
  quickActions = [],
  onClose,
  onRefresh
}) {
  const [notes, setNotes] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [tagText, setTagText] = useState('');
  const [activeTab, setActiveTab] = useState('overview');
  const [activitySpark, setActivitySpark] = useState(null);
  const [metaForm, setMetaForm] = useState({
    classification: '',
    risk_tier: '',
    priority: '',
    status_reason: '',
    linked_case_id: ''
  });

  useEffect(() => {
    if (!row || !open) return;
    setMetaForm({
      classification: row.classification || '',
      risk_tier: row.risk_tier || '',
      priority: row.priority || 'normal',
      status_reason: row.status_reason || '',
      linked_case_id: row.linked_case_id || ''
    });
  }, [open, row]);

  // 30-day realized-P&L trend — the prototype's isAdminUsers drawer `row.spark`.
  // Only meaningful for the trader entity, and only fetched when the drawer
  // actually opens on one (not baked into the list payload — 20+ sparklines
  // per page load would be wasteful for something only shown one row at a time).
  useEffect(() => {
    if (!row || !open || entityType !== 'user') { setActivitySpark(null); return }
    let cancelled = false
    adminAxios.get(`/api/admin/traders/${row.id}/activity-spark`)
      .then((res) => { if (!cancelled) setActivitySpark(Array.isArray(res.data?.spark) ? res.data.spark : []) })
      .catch(() => { if (!cancelled) setActivitySpark([]) })
    return () => { cancelled = true }
  }, [adminAxios, entityType, open, row]);

  useEffect(() => {
    if (!row || !open) return;
    let cancelled = false;
    setLoadingNotes(true);
    adminAxios.get('/api/admin/notes', {
      params: {
        entity_type: entityType,
        entity_id: row.id
      }
    }).then((res) => {
      if (!cancelled) setNotes(Array.isArray(res.data) ? res.data : []);
    }).catch(() => {
      if (!cancelled) setNotes([]);
    }).finally(() => {
      if (!cancelled) setLoadingNotes(false);
    });
    return () => {
      cancelled = true;
    };
  }, [adminAxios, entityType, open, row]);

  const timelineItems = useMemo(() => {
    if (!row) return [];
    return [
      { label: 'Created', value: row.created_at },
      { label: 'Updated', value: row.updated_at },
      { label: 'Last Action', value: row.last_action_at },
      { label: 'Requested', value: row.requested_at },
      { label: 'Paid', value: row.paid_at }
    ].filter((item) => item.value);
  }, [row]);

  if (!open || !row) return null;

  const submitNote = async () => {
    if (!noteText.trim()) return;
    await adminAxios.post('/api/admin/notes', {
      entity_type: entityType,
      entity_id: row.id,
      note: noteText.trim()
    });
    setNoteText('');
    onRefresh && onRefresh();
    const res = await adminAxios.get('/api/admin/notes', {
      params: { entity_type: entityType, entity_id: row.id }
    });
    setNotes(Array.isArray(res.data) ? res.data : []);
  };

  const addTag = async () => {
    const normalized = tagText.trim().toLowerCase();
    if (!normalized) return;
    await adminAxios.post('/api/admin/tags/assign', {
      entity_type: entityType,
      ids: [row.id],
      tags: [normalized],
      mode: 'add'
    });
    setTagText('');
    onRefresh && onRefresh();
  };

  const removeTag = async (tag) => {
    await adminAxios.post('/api/admin/tags/assign', {
      entity_type: entityType,
      ids: [row.id],
      tags: [tag],
      mode: 'remove'
    });
    onRefresh && onRefresh();
  };

  const saveMeta = async () => {
    await adminAxios.post('/api/admin/entity-meta', {
      entity_type: entityType,
      entity_id: row.id,
      classification: metaForm.classification || null,
      risk_tier: metaForm.risk_tier || null,
      priority: metaForm.priority || null,
      status_reason: metaForm.status_reason || null,
      linked_case_id: metaForm.linked_case_id || null
    });
    onRefresh && onRefresh();
  };

  return (
    <div className="admin-modal-overlay" style={{ display: 'flex', justifyContent: 'flex-end', padding: 0 }} onMouseDown={onClose}>
      <div className="admin-entity-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="admin-entity-drawer-header">
          <div>
            <h2 className="admin-h2" style={{ margin: 0 }}>{title}</h2>
            <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1)' }}>
              {entityType} #{row.id}
            </div>
          </div>
          <button className="admin-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="admin-entity-tabs">
          {['overview', 'timeline'].map((tab) => (
            <button
              key={tab}
              className={`admin-filter-chip ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'overview' ? 'Overview' : 'Timeline'}
            </button>
          ))}
        </div>

        <div className="admin-entity-drawer-body">
          {activeTab === 'overview' ? (
            <>
              <Card>
                {entityType === 'user' && Array.isArray(activitySpark) && activitySpark.length > 1 && (
                  <div style={{ height: '64px', marginBottom: 'var(--space-3-5)' }}>
                    <Sparkline
                      data={activitySpark}
                      width="100%"
                      height={64}
                      tone={activitySpark[activitySpark.length - 1]?.value >= 0 ? 'var(--gain)' : 'var(--loss)'}
                    />
                  </div>
                )}
                <div className="admin-entity-badge-row">
                  {row.risk_tier && <AdminBadge status={row.risk_tier === 'critical' ? 'danger' : row.risk_tier === 'high' ? 'warning' : 'info'} label={`Risk ${row.risk_tier}`} />}
                  {row.kyc_status && <AdminBadge status={row.kyc_status} label={`KYC ${row.kyc_status}`} />}
                  {row.status && <AdminBadge status={row.status} label={row.status} />}
                </div>

                <div className="admin-entity-info-grid">
                  <div><span>Email</span><strong>{row.email || row.user_email || '—'}</strong></div>
                  <div><span>Name</span><strong>{row.full_name || '—'}</strong></div>
                  <div><span>Classification</span><strong>{row.classification || '—'}</strong></div>
                  <div><span>Priority</span><strong>{row.priority || 'normal'}</strong></div>
                  <div><span>Linked Case</span><strong>{row.linked_case_id || '—'}</strong></div>
                  <div><span>Notes</span><strong>{row.internal_notes_count || 0}</strong></div>
                </div>

                {quickActions.length > 0 && (
                  <div className="admin-entity-actions">
                    {quickActions.map((action) => (
                      <button key={action.label} className="admin-btn admin-btn-ghost" onClick={action.onClick}>
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Tags">
                <div className="admin-tag-row">
                  {(row.tags || []).map((tag) => (
                    <button key={tag} className="admin-tag-pill" onClick={() => removeTag(tag)}>
                      {tag} ×
                    </button>
                  ))}
                </div>
                <div className="admin-inline-form">
                  <input
                    className="admin-input"
                    value={tagText}
                    onChange={(event) => setTagText(event.target.value)}
                    placeholder="Add tag"
                  />
                  <button className="admin-btn admin-btn-primary" onClick={addTag}>Add Tag</button>
                </div>
              </Card>

              <Card title="Classification">
                <div className="admin-entity-form-grid">
                  <input className="admin-input" value={metaForm.classification} onChange={(event) => setMetaForm((current) => ({ ...current, classification: event.target.value }))} placeholder="classification" />
                  <select className="admin-select" value={metaForm.risk_tier} onChange={(event) => setMetaForm((current) => ({ ...current, risk_tier: event.target.value }))}>
                    <option value="">Risk tier</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                  <select className="admin-select" value={metaForm.priority} onChange={(event) => setMetaForm((current) => ({ ...current, priority: event.target.value }))}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                  <input className="admin-input" value={metaForm.linked_case_id} onChange={(event) => setMetaForm((current) => ({ ...current, linked_case_id: event.target.value }))} placeholder="Linked case id" />
                </div>
                <textarea
                  className="admin-input"
                  rows={3}
                  value={metaForm.status_reason}
                  onChange={(event) => setMetaForm((current) => ({ ...current, status_reason: event.target.value }))}
                  placeholder="Status reason / internal context"
                  style={{ resize: 'vertical', minHeight: '88px', marginTop: 'var(--space-3)' }}
                />
                <button className="admin-btn admin-btn-primary" style={{ marginTop: 'var(--space-3)' }} onClick={saveMeta}>
                  Save Metadata
                </button>
              </Card>

              <Card title="Notes">
                <div className="admin-inline-form">
                  <textarea
                    className="admin-input"
                    rows={3}
                    value={noteText}
                    onChange={(event) => setNoteText(event.target.value)}
                    placeholder="Add an internal note"
                    style={{ resize: 'vertical', minHeight: '88px' }}
                  />
                  <button className="admin-btn admin-btn-primary" onClick={submitNote}>Add Note</button>
                </div>
                <div className="admin-entity-note-list">
                  {loadingNotes ? (
                    <div style={{ color: 'var(--admin-text-muted)' }}>Loading notes…</div>
                  ) : notes.length === 0 ? (
                    <div style={{ color: 'var(--admin-text-muted)' }}>No internal notes yet.</div>
                  ) : notes.map((note) => (
                    <div key={note.id} className="admin-entity-note">
                      <div className="admin-entity-note-meta">
                        <strong>{note.created_by}</strong>
                        <span>{formatDateTime(note.created_at)}</span>
                      </div>
                      <div>{note.note_text}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          ) : (
            <Card title="Timeline">
              <div className="admin-entity-timeline">
                {timelineItems.length === 0 ? (
                  <div style={{ color: 'var(--admin-text-muted)' }}>No timeline data yet.</div>
                ) : timelineItems.map((item) => (
                  <div key={item.label} className="admin-entity-timeline-item">
                    <span>{item.label}</span>
                    <strong>{formatDateTime(item.value)}</strong>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
