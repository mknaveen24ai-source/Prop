import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import Card from '../../components/ui/Card';
import { exportAdminResource } from '../../utils/adminList';

const STATUS_OPTIONS = ['all', 'open', 'under_review', 'resolved', 'rejected'];
const PRIORITY_OPTIONS = ['all', 'urgent', 'high', 'normal', 'low'];
const ALL_COLUMN_KEYS = ['id', 'trader', 'type', 'subject', 'status', 'priority', 'owner', 'sla', 'opened'];

function buildViewConfig({ search, filters, density, visibleColumnKeys }) {
  return {
    search,
    filters,
    density,
    columns: visibleColumnKeys
  };
}

function normalizeDispute(dispute) {
  return {
    ...dispute,
    id: dispute?.id || dispute?.dispute_id,
    user_email: dispute?.user_email || dispute?.email || '',
    user_name: dispute?.user_name || dispute?.full_name || '',
    account_id: dispute?.account_id || dispute?.account_uid || null,
    type: dispute?.type || dispute?.reason || 'General',
    subject: dispute?.subject || dispute?.title || dispute?.reason || 'General',
    message: dispute?.message || dispute?.description || '',
    resolution: dispute?.resolution || dispute?.admin_response || ''
  };
}

function formatStatusTone(status) {
  if (status === 'resolved') return 'success';
  if (status === 'under_review') return 'warning';
  if (status === 'rejected') return 'danger';
  return 'danger';
}

function formatPriorityTone(priority) {
  if (priority === 'urgent') return 'danger';
  if (priority === 'high') return 'warning';
  if (priority === 'low') return 'neutral';
  return 'info';
}

function formatSlaTone(status) {
  if (status === 'breach') return 'danger';
  if (status === 'overdue') return 'warning';
  return 'success';
}

export default function AdminDisputes() {
  const { adminAxios, socket } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState({});
  const [disputes, setDisputes] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('open');
  const [priorityFilter, setPriorityFilter] = useState('all');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selected, setSelected] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [resolution, setResolution] = useState('');
  const [saving, setSaving] = useState(false);
  const [metaOwner, setMetaOwner] = useState('');
  const [metaPriority, setMetaPriority] = useState('normal');
  const [metaSlaHours, setMetaSlaHours] = useState('48');
  const [metaNotes, setMetaNotes] = useState('');

  const filters = useMemo(() => ({
    status: statusFilter,
    priority: priorityFilter,
    owner: ownerFilter
  }), [ownerFilter, priorityFilter, statusFilter]);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'disputes' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchDisputes = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/dispute-workflow');
      const rows = (res.data?.rows || []).map(normalizeDispute);
      setDisputes(rows);
      setSummary(res.data?.summary || {});
      setSelected((current) => {
        if (!current) return current;
        return rows.find((row) => String(row.id) === String(current.id)) || current;
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load disputes');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchDisputes();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchDisputes({ silent: true });
    socket.on('admin_command_center_updated', refresh);
    return () => socket.off('admin_command_center_updated', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  const saveView = async () => {
    const name = window.prompt('Name this disputes view', 'Open Escalated Disputes');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'disputes',
        name,
        config: buildViewConfig({ search, filters, density, visibleColumnKeys })
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
        config: buildViewConfig({ search, filters, density, visibleColumnKeys })
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
      setStatusFilter('open');
      setPriorityFilter('all');
      setOwnerFilter('all');
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      return;
    }
    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setStatusFilter(config.filters?.status || 'open');
    setPriorityFilter(config.filters?.priority || 'all');
    setOwnerFilter(config.filters?.owner || 'all');
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

  const openDispute = (dispute) => {
    setSelected(dispute);
    setResolution(dispute.resolution || '');
    setMetaOwner(dispute.owner && dispute.owner !== 'unassigned' ? dispute.owner : '');
    setMetaPriority(dispute.priority || 'normal');
    setMetaSlaHours(String(dispute.sla_hours || 48));
    setMetaNotes(dispute.notes || '');
    setShowModal(true);
  };

  const resolveDispute = async (status) => {
    if (!selected) return;
    setSaving(true);
    try {
      await adminAxios.post(`/api/admin/dispute-workflow/${selected.id}/status`, {
        status,
        admin_response: resolution
      });
      toast.success(`Dispute #${selected.id} marked as ${status}`);
      setShowModal(false);
      setResolution('');
      fetchDisputes({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update dispute');
    } finally {
      setSaving(false);
    }
  };

  const saveMeta = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await adminAxios.post(`/api/admin/dispute-workflow/${selected.id}/meta`, {
        owner: metaOwner || null,
        priority: metaPriority,
        sla_hours: parseInt(metaSlaHours, 10) || 48,
        notes: metaNotes
      });
      toast.success('Dispute workflow metadata updated');
      fetchDisputes({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update dispute workflow');
    } finally {
      setSaving(false);
    }
  };

  const filteredDisputes = useMemo(() => {
    return disputes.filter((dispute) => {
      if (statusFilter !== 'all' && dispute.status !== statusFilter) return false;
      if (priorityFilter !== 'all' && (dispute.priority || 'normal') !== priorityFilter) return false;
      if (ownerFilter !== 'all' && (dispute.owner || 'unassigned') !== ownerFilter) return false;

      const query = search.trim().toLowerCase();
      if (!query) return true;
      const haystack = [
        dispute.id,
        dispute.user_email,
        dispute.user_name,
        dispute.subject,
        dispute.type,
        dispute.account_id,
        dispute.owner
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [disputes, ownerFilter, priorityFilter, search, statusFilter]);

  const ownerOptions = useMemo(() => {
    const owners = new Set();
    disputes.forEach((dispute) => owners.add(dispute.owner || 'unassigned'));
    return Array.from(owners).sort();
  }, [disputes]);

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'disputes', {
        search,
        filters: {
          status: statusFilter !== 'all' ? statusFilter : null,
          priority: priorityFilter !== 'all' ? priorityFilter : null,
          owner: ownerFilter !== 'all' ? ownerFilter : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export disputes');
    }
  };

  const columns = useMemo(() => {
    const allColumns = [
      { header: 'Dispute ID', key: 'id', isMono: true, render: (dispute) => `#${String(dispute.id).padStart(5, '0')}` },
      {
        header: 'Trader',
        key: 'trader',
        render: (dispute) => (
          <div>
            <div style={{ color: 'var(--admin-text)' }}>{dispute.user_email || dispute.user_name || `User #${dispute.user_id}`}</div>
            {dispute.account_id && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-faint)' }}>Acc #{dispute.account_id}</div>}
          </div>
        )
      },
      { header: 'Type', key: 'type', render: (dispute) => <span style={{ fontWeight: 500 }}>{dispute.type || 'General'}</span> },
      { header: 'Subject', key: 'subject', render: (dispute) => dispute.subject || dispute.title || '-' },
      {
        header: 'Status',
        key: 'status',
        render: (dispute) => <AdminBadge status={formatStatusTone(dispute.status)} label={dispute.status} />
      },
      {
        header: 'Priority',
        key: 'priority',
        render: (dispute) => <AdminBadge status={formatPriorityTone(dispute.priority)} label={dispute.priority || 'normal'} />
      },
      {
        header: 'Owner',
        key: 'owner',
        render: (dispute) => dispute.owner || 'unassigned'
      },
      {
        header: 'SLA',
        key: 'sla',
        render: (dispute) => (
          <div>
            <AdminBadge status={formatSlaTone(dispute.sla_status)} label={dispute.sla_status || 'within_sla'} />
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)', marginTop: 'var(--space-1-5)' }}>
              {dispute.age_hours ? `${dispute.age_hours.toFixed(1)}h` : 'No age data'}
            </div>
          </div>
        )
      },
      {
        header: 'Opened',
        key: 'opened',
        render: (dispute) => new Date(dispute.created_at).toLocaleDateString()
      }
    ];
    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));

  const rowActions = (dispute) => [
    { label: 'Review Dispute', icon: 'info', onClick: () => openDispute(dispute) },
    {
      label: 'Mark Under Review',
      icon: 'warning',
      onClick: async () => {
        try {
          await adminAxios.post(`/api/admin/dispute-workflow/${dispute.id}/status`, { status: 'under_review' });
          toast.success('Dispute marked under review');
          fetchDisputes({ silent: true });
        } catch (err) {
          toast.error(err?.response?.data?.error || 'Failed to update dispute');
        }
      }
    }
  ];

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 className="admin-h1">Dispute Management</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
          Handle trader complaints, rule-violation contests, and case-review queues from a single workflow board.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <AdminStatCard icon="warning" label="Open" value={summary.open || 0} />
        <AdminStatCard icon="activity" label="Under Review" value={summary.under_review || 0} />
        <AdminStatCard icon="approve" label="Resolved" value={summary.resolved || 0} />
        <AdminStatCard icon="history" label="Overdue" value={summary.overdue || 0} />
      </div>

      <AdminFilterBar searchPlaceholder="Search by trader, subject, account, or owner..." searchValue={search} onSearchChange={setSearch}>
        {STATUS_OPTIONS.map((status) => (
          <button
            key={status}
            className={`admin-filter-chip ${statusFilter === status ? 'active' : ''}`}
            onClick={() => setStatusFilter(status)}
          >
            {status === 'all' ? 'All Statuses' : status.replace('_', ' ')}
          </button>
        ))}
        {PRIORITY_OPTIONS.map((priority) => (
          <button
            key={priority}
            className={`admin-filter-chip ${priorityFilter === priority ? 'active' : ''}`}
            onClick={() => setPriorityFilter(priority)}
          >
            {priority === 'all' ? 'All Priorities' : priority}
          </button>
        ))}
        {ownerOptions.slice(0, 6).map((owner) => (
          <button
            key={owner}
            className={`admin-filter-chip ${ownerFilter === owner ? 'active' : ''}`}
            onClick={() => setOwnerFilter((current) => current === owner ? 'all' : owner)}
          >
            {owner}
          </button>
        ))}
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel="disputes"
        views={views}
        activeViewId={activeViewId}
        onSelectView={selectView}
        onSaveView={saveView}
        onUpdateView={currentView ? () => updateView(currentView) : null}
        onDeleteView={currentView ? () => deleteView(currentView) : null}
        columns={ALL_COLUMN_KEYS.map((key) => ({ key, header: key.replace(/\b\w/g, (char) => char.toUpperCase()) }))}
        visibleColumnKeys={visibleColumnKeys}
        onToggleColumn={toggleColumn}
        density={density}
        onDensityChange={setDensity}
        onExport={exportCurrentView}
      />

      <Card flush>
        <AdminDataTable
          columns={columns}
          data={filteredDisputes}
          loading={loading}
          rowActions={rowActions}
          emptyMessage="No disputes found"
          emptyIcon="warning"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
          density={density}
          onRowClick={(dispute) => openDispute(dispute)}
        />
      </Card>

      <AdminModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={`Dispute #${String(selected?.id || '').padStart(5, '0')}`}
        size="lg"
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowModal(false)}>Close</button>
            <button className="admin-btn admin-btn-ghost" disabled={saving} onClick={saveMeta}>Save Workflow</button>
            <button className="admin-btn admin-btn-warning" disabled={saving} onClick={() => resolveDispute('under_review')}>Mark Under Review</button>
            <button className="admin-btn admin-btn-success" disabled={saving || !resolution.trim()} onClick={() => resolveDispute('resolved')}>Mark Resolved</button>
          </>
        )}
      >
        {selected && (
          <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Trader</div>
                <div style={{ color: 'var(--admin-text)', fontWeight: 500, marginTop: 'var(--space-1)' }}>{selected.user_email || selected.user_name || 'Unknown trader'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Account</div>
                <div className="admin-td-mono" style={{ marginTop: 'var(--space-1)' }}>#{selected.account_id || 'N/A'}</div>
              </div>
              <div style={{ gridColumn: 'span 2' }}>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Subject</div>
                <div style={{ color: 'var(--admin-text)', fontWeight: 600, fontSize: 'var(--fs-lg)', marginTop: 'var(--space-1)' }}>
                  {selected.subject || selected.title || '-'}
                </div>
              </div>
            </div>

            {(selected.description || selected.message) && (
              <div className="admin-form-group">
                <label className="admin-label">Trader Statement</label>
                <div style={{
                  background: 'var(--admin-bg)',
                  border: '1px solid var(--admin-border)',
                  padding: 'var(--space-4)',
                  color: 'var(--admin-text)',
                  fontSize: 'var(--fs-base)',
                  lineHeight: '1.6',
                  whiteSpace: 'pre-wrap'
                }}>
                  {selected.description || selected.message}
                </div>
              </div>
            )}

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Workflow Controls</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 'var(--space-3)' }}>
                <input
                  className="admin-input"
                  placeholder="Owner"
                  value={metaOwner}
                  onChange={(event) => setMetaOwner(event.target.value)}
                />
                <select className="admin-select" value={metaPriority} onChange={(event) => setMetaPriority(event.target.value)}>
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <input
                  className="admin-input admin-font-mono"
                  type="number"
                  min="1"
                  max="336"
                  value={metaSlaHours}
                  onChange={(event) => setMetaSlaHours(event.target.value)}
                  placeholder="SLA hours"
                />
              </div>
              <textarea
                className="admin-textarea"
                rows={3}
                style={{ marginTop: 'var(--space-3)' }}
                value={metaNotes}
                onChange={(event) => setMetaNotes(event.target.value)}
                placeholder="Workflow notes, escalations, or external dependencies..."
              />
            </Card>

            <div className="admin-form-group">
              <label className="admin-label">Admin Resolution Notes</label>
              <textarea
                className="admin-textarea"
                placeholder="Enter your resolution decision, reason, and any actions taken..."
                value={resolution}
                onChange={(event) => setResolution(event.target.value)}
                rows={4}
              />
            </div>
          </div>
        )}
      </AdminModal>
    </>
  );
}
