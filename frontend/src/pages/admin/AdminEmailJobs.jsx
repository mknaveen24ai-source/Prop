import React, { useEffect, useMemo, useState } from 'react';
import { PageWrapper } from '../../App';
import { useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import Card from '../../components/ui/Card';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';

const DEFAULT_FILTERS = {
  status: 'all',
  templateKey: 'all',
  deliveryType: 'all'
};

const ALL_COLUMN_KEYS = ['job', 'recipient', 'template', 'status', 'schedule', 'delivery', 'error'];

function formatTemplateLabel(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateTime(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString();
}

function normalizeStatusTone(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'sent') return 'success';
  if (normalized === 'sending') return 'info';
  if (normalized === 'pending' || normalized === 'retry') return 'warning';
  if (normalized === 'dead' || normalized === 'failed') return 'danger';
  return 'neutral';
}

function buildViewConfig({ search, filters, sort, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    sort,
    columns: visibleColumnKeys,
    density
  };
}

export default function AdminEmailJobs() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [listData, setListData] = useState({
    summary: {},
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 },
    facets: {}
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [drawerRow, setDrawerRow] = useState(null);
  const [retryingId, setRetryingId] = useState('');

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'email_jobs' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  // FIX (AUDIT): stale-closure race — see AdminUsers.jsx for full explanation.
  const fetchJobs = async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/email-jobs', {
        params: {
          format: 'list',
          page: effectivePage,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          status: filters.status !== 'all' ? filters.status : undefined,
          template_key: filters.templateKey !== 'all' ? filters.templateKey : undefined,
          delivery_type: filters.deliveryType !== 'all' ? filters.deliveryType : undefined
        }
      });
      setListData(normalizeAdminListResponse(res.data));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not fetch email jobs');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchJobs({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchJobs({ silent: true });
    }, 15000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, search, filters]);

  const selectView = (viewId) => {
    setActiveViewId(viewId);
    if (!viewId) {
      setSearch('');
      setFilters(DEFAULT_FILTERS);
      setSort({ key: 'created_at', direction: 'desc' });
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      setPage(1);
      return;
    }
    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setFilters({ ...DEFAULT_FILTERS, ...(config.filters || {}) });
    setSort(config.sort || { key: 'created_at', direction: 'desc' });
    setVisibleColumnKeys(Array.isArray(config.columns) && config.columns.length > 0 ? config.columns : ALL_COLUMN_KEYS);
    setDensity(config.density || 'comfortable');
    setPage(1);
  };

  const saveView = async () => {
    const name = window.prompt('Name this email job view', 'Failed Email Jobs');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'email_jobs',
        name,
        config: buildViewConfig({ search, filters, sort, visibleColumnKeys, density })
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
        config: buildViewConfig({ search, filters, sort, visibleColumnKeys, density })
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

  const retryJob = async (job) => {
    setRetryingId(String(job.id));
    try {
      const response = await adminAxios.post(`/api/admin/email-jobs/${job.id}/retry`);
      toast.success(response.data?.message || 'Email job re-queued');
      fetchJobs({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not re-queue email job');
    } finally {
      setRetryingId('');
    }
  };

  const copyPreviewPath = async (job) => {
    if (!job?.preview_url) return;
    try {
      await navigator.clipboard.writeText(job.preview_url);
      toast.success('Preview path copied');
    } catch {
      toast.error('Could not copy preview path');
    }
  };

  const handleSortChange = (sortKey) => {
    setSort((current) => ({
      key: sortKey,
      direction: current.key === sortKey && current.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const toggleColumn = (columnKey) => {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  };

  const columns = useMemo(() => ([
    {
      header: 'Job',
      key: 'job',
      isMono: true,
      sortKey: 'id',
      render: (job) => (
        <div>
          <div>MAIL-{String(job.id).padStart(6, '0')}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{job.delivery_type === 'automation' ? 'Automation' : 'Transactional'}</div>
        </div>
      )
    },
    {
      header: 'Recipient',
      key: 'recipient',
      sortKey: 'to_email',
      render: (job) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{job.full_name_hint || job.to_email}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{job.to_email}</div>
        </div>
      )
    },
    {
      header: 'Template',
      key: 'template',
      sortKey: 'template_key',
      render: (job) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{formatTemplateLabel(job.template_key)}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{job.template_key}</div>
        </div>
      )
    },
    {
      header: 'Status',
      key: 'status',
      sortKey: 'status',
      render: (job) => (
        <div>
          <AdminBadge status={normalizeStatusTone(job.status)} label={job.status} />
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)', marginTop: '6px' }}>
            {job.attempt_count} attempt{job.attempt_count === 1 ? '' : 's'}
          </div>
        </div>
      )
    },
    {
      header: 'Scheduled',
      key: 'schedule',
      sortKey: 'scheduled_for',
      render: (job) => (
        <div>
          <div>{formatDateTime(job.scheduled_for)}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>Created {formatDateTime(job.created_at)}</div>
        </div>
      )
    },
    {
      header: 'Delivery',
      key: 'delivery',
      sortKey: 'sent_at',
      render: (job) => (
        <div>
          <div>Last try: {formatDateTime(job.last_attempt_at)}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>Sent: {formatDateTime(job.sent_at)}</div>
        </div>
      )
    },
    {
      header: 'Error / Preview',
      key: 'error',
      render: (job) => (
        <div>
          <div style={{ color: 'var(--admin-text)', fontSize: 'var(--fs-sm)' }}>
            {job.last_error ? String(job.last_error).slice(0, 90) : 'No error recorded'}
          </div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)', marginTop: 'var(--space-1)' }}>
            {job.preview_url ? 'Preview captured' : job.provider_message_id ? 'Provider receipt stored' : 'No preview path'}
          </div>
        </div>
      )
    }
  ]), []);

  const visibleColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
  const rows = listData.rows || [];
  const summary = listData.summary || {};
  const pagination = listData.pagination || { current: 1, total: 1 };
  const templateFacetKeys = Object.keys(listData.facets?.template_key || {});

  const getRowActions = (job) => {
    const allowedActions = new Set(Array.isArray(job.allowed_actions) ? job.allowed_actions : []);
    const actions = [
      { label: 'Preview', icon: 'info', onClick: () => setDrawerRow(job) }
    ];
    if (allowedActions.has('retry_email_job')) {
      actions.push({
        label: retryingId === String(job.id) ? 'Re-queuing...' : 'Retry Now',
        icon: 'repeat',
        onClick: () => retryJob(job)
      });
    }
    if (allowedActions.has('copy_preview_path')) {
      actions.push({
        label: 'Copy Preview Path',
        icon: 'copy',
        onClick: () => copyPreviewPath(job)
      });
    }
    return actions;
  };

  return (
    <PageWrapper>
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)' }}>
          <div>
            <h1 className="admin-h1">Email Job Monitor</h1>
            <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
              Watch transactional and automation emails, inspect failures, and re-queue dead jobs without leaving the admin console.
            </p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
          <AdminStatCard icon="mail" label="Total Jobs" value={summary.total || 0} />
          <AdminStatCard icon="timer" label="Queued / Retry" value={(summary.pending || 0) + (summary.sending || 0) + (summary.retry || 0)} />
          <AdminStatCard icon="approve" label="Delivered" value={summary.sent || 0} />
          <AdminStatCard icon="warning" label="Dead Jobs" value={summary.dead || 0} />
        </div>

        <AdminFilterBar searchPlaceholder="Search via recipient, template, job ID, or provider receipt..." searchValue={search} onSearchChange={setSearch}>
          <select className="admin-select" style={{ width: '160px' }} value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
            <option value="all">All statuses</option>
            {['pending', 'sending', 'retry', 'sent', 'dead'].map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </select>
          <select className="admin-select" style={{ width: '220px' }} value={filters.templateKey} onChange={(event) => setFilters((current) => ({ ...current, templateKey: event.target.value }))}>
            <option value="all">All templates</option>
            {templateFacetKeys.map((templateKey) => (
              <option key={templateKey} value={templateKey}>{formatTemplateLabel(templateKey)}</option>
            ))}
          </select>
          <select className="admin-select" style={{ width: '180px' }} value={filters.deliveryType} onChange={(event) => setFilters((current) => ({ ...current, deliveryType: event.target.value }))}>
            <option value="all">All job types</option>
            <option value="transactional">Transactional</option>
            <option value="automation">Automation</option>
          </select>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="email jobs"
          views={views}
          activeViewId={activeViewId}
          onSelectView={selectView}
          onSaveView={saveView}
          onUpdateView={updateView}
          onDeleteView={deleteView}
          density={density}
          onDensityChange={setDensity}
          columns={columns}
          visibleColumnKeys={visibleColumnKeys}
          onToggleColumn={toggleColumn}
          onExport={() => exportAdminResource(adminAxios, 'email_jobs', {
            search,
            sort: sort.key,
            order: sort.direction,
            filters: {
              status: filters.status !== 'all' ? filters.status : null,
              template_key: filters.templateKey !== 'all' ? filters.templateKey : null,
              delivery_type: filters.deliveryType !== 'all' ? filters.deliveryType : null
            }
          })}
        />

        <Card flush>
          <AdminDataTable
            columns={visibleColumns}
            data={rows}
            loading={loading}
            rowActions={getRowActions}
            pagination={pagination}
            onPageChange={setPage}
            sort={sort}
            onSortChange={handleSortChange}
            density={density}
            emptyMessage="No email jobs found"
            emptyIcon="mail"
            onRowClick={(row) => setDrawerRow(row)}
          />
        </Card>

        {drawerRow && (
          <div className="admin-modal-overlay" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }} onMouseDown={() => setDrawerRow(null)}>
            <Card
              style={{ width: 'min(960px, calc(100vw - 32px))', maxHeight: '88vh', overflowY: 'auto', margin: 0 }}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--space-4)', alignItems: 'flex-start', marginBottom: '18px' }}>
                <div>
                  <h2 className="admin-h2" style={{ marginBottom: '6px' }}>Email Job MAIL-{String(drawerRow.id).padStart(6, '0')}</h2>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>{drawerRow.to_email}</div>
                </div>
                <button className="admin-modal-close" onClick={() => setDrawerRow(null)}>×</button>
              </div>

              <div className="admin-entity-badge-row" style={{ marginBottom: '18px' }}>
                <AdminBadge status={normalizeStatusTone(drawerRow.status)} label={drawerRow.status} />
                <AdminBadge status={drawerRow.delivery_type === 'automation' ? 'info' : 'neutral'} label={drawerRow.delivery_type} />
              </div>

              <div className="admin-entity-info-grid" style={{ marginBottom: '18px' }}>
                <div><span>Template</span><strong>{formatTemplateLabel(drawerRow.template_key)}</strong></div>
                <div><span>Attempts</span><strong>{drawerRow.attempt_count}</strong></div>
                <div><span>Scheduled</span><strong>{formatDateTime(drawerRow.scheduled_for)}</strong></div>
                <div><span>Last Attempt</span><strong>{formatDateTime(drawerRow.last_attempt_at)}</strong></div>
                <div><span>Sent</span><strong>{formatDateTime(drawerRow.sent_at)}</strong></div>
              </div>

              <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: '18px' }}>
                {Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('retry_email_job') && (
                  <button className="admin-btn admin-btn-primary" onClick={() => retryJob(drawerRow)} disabled={retryingId === String(drawerRow.id)}>
                    {retryingId === String(drawerRow.id) ? 'Re-queuing...' : 'Retry Now'}
                  </button>
                )}
                {drawerRow.preview_url && (
                  <button className="admin-btn admin-btn-ghost" onClick={() => copyPreviewPath(drawerRow)}>
                    Copy Preview Path
                  </button>
                )}
              </div>

              <Card style={{ margin: 0, background: 'var(--admin-bg)' }}>
                <h3 className="admin-h3">Provider / Preview</h3>
                <div style={{ display: 'grid', gap: 'var(--space-2)', marginBottom: '14px' }}>
                  <div><strong style={{ display: 'block', marginBottom: 'var(--space-1)' }}>Provider Message ID</strong><span className="admin-font-mono">{drawerRow.provider_message_id || '—'}</span></div>
                  <div><strong style={{ display: 'block', marginBottom: 'var(--space-1)' }}>Preview Path</strong><span className="admin-font-mono">{drawerRow.preview_url || '—'}</span></div>
                  <div><strong style={{ display: 'block', marginBottom: 'var(--space-1)' }}>Unique Key</strong><span className="admin-font-mono">{drawerRow.unique_key || '—'}</span></div>
                </div>
                <div>
                  <strong style={{ display: 'block', marginBottom: '6px' }}>Last Error</strong>
                  <div style={{ color: 'var(--admin-text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{drawerRow.last_error || 'No error recorded.'}</div>
                </div>
              </Card>

              <Card style={{ margin: '16px 0 0', background: 'var(--admin-bg)' }}>
                <h3 className="admin-h3">Payload</h3>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>
                  {JSON.stringify(drawerRow.payload_json || {}, null, 2)}
                </pre>
              </Card>
            </Card>
          </div>
        )}
      </>
    </PageWrapper>
  );
}
