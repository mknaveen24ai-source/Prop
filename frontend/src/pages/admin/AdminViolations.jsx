import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource } from '../../utils/adminList';
import Card from '../../components/ui/Card';

const STATUS_FILTERS = ['all', 'open', 'resolved'];
const SEVERITY_FILTERS = ['all', 'critical', 'high', 'medium', 'low'];
const AUTO_REFRESH_MS = 15000;
const ALL_COLUMN_KEYS = ['type', 'severity', 'account', 'instrument', 'message', 'hits', 'lastDetected', 'status'];

function buildViewConfig({ search, filters, density, visibleColumnKeys }) {
  return {
    search,
    filters,
    density,
    columns: visibleColumnKeys
  };
}

function formatLabel(value) {
  return String(value || 'unknown')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function getSeverityTone(severity) {
  const normalized = String(severity || '').toLowerCase();
  if (normalized === 'critical') return 'danger';
  if (normalized === 'high') return 'warning';
  if (normalized === 'medium') return 'info';
  return 'neutral';
}

function mapBulkViolationLabel(action) {
  if (action === 'resolve_violation') return 'Resolve Selected';
  if (action === 'waive_violation') return 'Waive Selected';
  return 'Mark False Positive';
}

export default function AdminViolations() {
  const { adminAxios, socket, session } = useOutletContext();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const refreshInFlight = useRef(false);
  const isSuperAdmin = session?.role === 'super_admin';

  const [loading, setLoading] = useState(true);
  const [violations, setViolations] = useState([]);
  const [summary, setSummary] = useState({
    totals: { total_open: 0, critical_open: 0, high_open: 0 },
    top_types_last_24h: []
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState(searchParams.get('account') || searchParams.get('q') || '');
  const [statusFilter, setStatusFilter] = useState('open');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedViolation, setSelectedViolation] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [resolutionNote, setResolutionNote] = useState('');
  const [resolutionType, setResolutionType] = useState('resolved');
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const filters = useMemo(() => ({
    status: statusFilter,
    severity: severityFilter,
    type: typeFilter
  }), [severityFilter, statusFilter, typeFilter]);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'violations' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchAll = async ({ silent = false } = {}) => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    if (!silent) setLoading(true);
    try {
      const [violationsRes, summaryRes] = await Promise.all([
        adminAxios.get('/api/admin/violations?limit=300'),
        adminAxios.get('/api/admin/violations/summary')
      ]);
      const nextViolations = Array.isArray(violationsRes.data) ? violationsRes.data : [];
      setViolations(nextViolations);
      setSummary(summaryRes.data || {
        totals: { total_open: 0, critical_open: 0, high_open: 0 },
        top_types_last_24h: []
      });
      setLastUpdatedAt(new Date());
      setSelectedIds((current) => current.filter((id) => nextViolations.some((violation) => String(violation.id) === id)));
      setSelectedViolation((current) => {
        if (!current) return current;
        return nextViolations.find((violation) => violation.id === current.id) || current;
      });
    } catch (err) {
      if (!silent) {
        toast.error(err?.response?.data?.error || 'Failed to load automated violations');
      }
    } finally {
      refreshInFlight.current = false;
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      fetchAll({ silent: true });
    }, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!socket) return undefined;

    const handleRealtimeUpdate = () => {
      fetchAll({ silent: true });
    };

    socket.on('admin_violation_updated', handleRealtimeUpdate);
    socket.on('admin_enforcement_event', handleRealtimeUpdate);
    socket.on('opposing_trade_detected', handleRealtimeUpdate);

    return () => {
      socket.off('admin_violation_updated', handleRealtimeUpdate);
      socket.off('admin_enforcement_event', handleRealtimeUpdate);
      socket.off('opposing_trade_detected', handleRealtimeUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket]);

  useEffect(() => {
    const nextSearch = searchParams.get('account') || searchParams.get('q') || '';
    setSearch(nextSearch);
  }, [searchParams]);

  const openViolation = (violation) => {
    setSelectedViolation(violation);
    setResolutionNote('');
    setResolutionType(violation?.resolution_type || 'resolved');
    setShowModal(true);
  };

  const resolveViolation = async () => {
    if (!selectedViolation) return;
    setSaving(true);
    try {
      await adminAxios.post(`/api/admin/violations/${selectedViolation.id}/resolve`, {
        note: resolutionNote.trim() || 'Resolved from admin portal',
        resolution_type: resolutionType
      });
      toast.success(`Violation #${selectedViolation.id} ${resolutionType.replace(/_/g, ' ')}`);
      setShowModal(false);
      setResolutionNote('');
      setResolutionType('resolved');
      await fetchAll({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to resolve violation');
    } finally {
      setSaving(false);
    }
  };

  const performAccountAction = async (action) => {
    if (!selectedViolation?.account_id || actionLoading) return;

    const accountId = selectedViolation.account_id;
    const reason = resolutionNote.trim() || `Action taken from violation #${selectedViolation.id}`;
    setActionLoading(action);

    try {
      if (action === 'flag_for_review' || action === 'lock_account') {
        await adminAxios.post('/api/admin/enforcement/apply', {
          account_id: accountId,
          action,
          reason,
          payload: {
            violation_id: selectedViolation.id,
            violation_type: selectedViolation.violation_type
          }
        });
      } else if (action === 'force_close_open_trades') {
        await adminAxios.post(`/api/admin/accounts/${accountId}/override`, {
          action,
          reason
        });
      }

      if (selectedViolation.status !== 'resolved') {
        await adminAxios.post(`/api/admin/violations/${selectedViolation.id}/resolve`, {
          note: `Auto-resolved after admin action (${action}): ${reason}`,
          resolution_type: 'resolved'
        });
      }

      toast.success(
        action === 'lock_account'
          ? `Account ${accountId} locked`
          : action === 'flag_for_review'
            ? `Account ${accountId} flagged for review`
            : `Open trades closed for account ${accountId}`
      );
      await fetchAll({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to apply account action');
    } finally {
      setActionLoading('');
    }
  };

  const openAccountDetail = () => {
    if (!selectedViolation?.account_id) return;
    setShowModal(false);
    navigate(`/admin/accounts/${selectedViolation.account_id}`);
  };

  const saveView = async () => {
    const name = window.prompt('Name this violation view', 'Critical Open Violations');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'violations',
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
      setSeverityFilter('all');
      setTypeFilter('all');
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      return;
    }

    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setStatusFilter(config.filters?.status || 'open');
    setSeverityFilter(config.filters?.severity || 'all');
    setTypeFilter(config.filters?.type || 'all');
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

  const filteredViolations = useMemo(() => {
    return violations.filter((violation) => {
      if (statusFilter !== 'all' && violation.status !== statusFilter) return false;
      if (severityFilter !== 'all' && violation.severity !== severityFilter) return false;
      if (typeFilter !== 'all' && violation.violation_type !== typeFilter) return false;

      if (!search.trim()) return true;
      const haystack = [
        violation.id,
        violation.violation_type,
        violation.account_id,
        violation.user_id,
        violation.instrument,
        violation.message
      ].join(' ').toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });
  }, [violations, statusFilter, severityFilter, typeFilter, search]);

  const typeOptions = useMemo(() => {
    const counts = violations.reduce((acc, violation) => {
      const key = violation.violation_type || 'unknown';
      acc.set(key, (acc.get(key) || 0) + 1);
      return acc;
    }, new Map());

    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8);
  }, [violations]);

  const selectedRows = useMemo(
    () => filteredViolations.filter((violation) => selectedIds.includes(String(violation.id))),
    [filteredViolations, selectedIds]
  );

  const availableBulkActions = useMemo(() => {
    if (selectedRows.length === 0) return [];
    if (selectedRows.every((row) => row.status !== 'resolved')) {
      return ['resolve_violation', 'waive_violation', 'false_positive'];
    }
    return [];
  }, [selectedRows]);

  const runBulkAction = async (action) => {
    if (selectedRows.length === 0) return;
    const reason = window.prompt(
      `Why are you applying "${mapBulkViolationLabel(action)}" to ${selectedRows.length} violation(s)?`,
      action === 'resolve_violation' ? 'Reviewed and resolved from violation queue' : 'Reviewed in operator workflow'
    );
    if (!reason) return;

    try {
      await adminAxios.post('/api/admin/command-center/bulk-action', {
        entity: 'violation',
        ids: selectedRows.map((row) => String(row.id)),
        action,
        reason
      });
      toast.success(`${mapBulkViolationLabel(action)} submitted`);
      setSelectedIds([]);
      fetchAll({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Bulk violation action failed');
    }
  };

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'violations', {
        search,
        filters: {
          status: statusFilter !== 'all' ? statusFilter : null,
          severity: severityFilter !== 'all' ? severityFilter : null,
          type: typeFilter !== 'all' ? typeFilter : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export violations');
    }
  };

  const columns = useMemo(() => {
    const allColumns = [
      {
        header: 'Type',
        key: 'type',
        render: (violation) => (
          <div>
            <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{formatLabel(violation.violation_type)}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>#{violation.id}</div>
          </div>
        )
      },
      {
        header: 'Severity',
        key: 'severity',
        render: (violation) => <AdminBadge status={getSeverityTone(violation.severity)} label={formatLabel(violation.severity)} />
      },
      {
        header: 'Account / User',
        key: 'account',
        render: (violation) => (
          <div>
            <div className="admin-td-mono" style={{ color: 'var(--admin-text)' }}>{violation.account_id || '-'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{violation.user_id || '-'}</div>
          </div>
        )
      },
      {
        header: 'Instrument',
        key: 'instrument',
        isMono: true,
        render: (violation) => violation.instrument || '-'
      },
      {
        header: 'Message',
        key: 'message',
        render: (violation) => (
          <div style={{ maxWidth: '420px', color: 'var(--admin-text-muted)' }}>
            {violation.message || 'No detail recorded'}
          </div>
        )
      },
      {
        header: 'Hits',
        key: 'hits',
        isMono: true,
        render: (violation) => String(violation.hit_count || 1)
      },
      {
        header: 'Last Detected',
        key: 'lastDetected',
        render: (violation) => formatTimestamp(violation.last_detected_at)
      },
      {
        header: 'Status',
        key: 'status',
        render: (violation) => (
          <AdminBadge
            status={violation.status === 'resolved' ? 'success' : 'danger'}
            label={formatLabel(violation.status)}
          />
        )
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const rowActions = (violation) => {
    const actions = [
      {
        label: 'View Details',
        icon: 'info',
        onClick: () => openViolation(violation)
      }
    ];

    if (violation.status !== 'resolved') {
      actions.push({
        label: 'Resolve',
        icon: 'approve',
        onClick: () => openViolation(violation)
      });
    }

    return actions;
  };

  const currentView = views.find((view) => String(view.id) === String(activeViewId));
  const allSelected = filteredViolations.length > 0 && selectedIds.length === filteredViolations.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < filteredViolations.length;

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-4)', marginBottom: 'var(--space-6)', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Automation Violations</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
            Live rule-breach feed for drawdown failures, opposing trades, and automated risk flags.
          </p>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-1-5)' }}>
            Auto-refresh every 15s{lastUpdatedAt ? ` - Last updated ${lastUpdatedAt.toLocaleTimeString()}` : ''}
          </div>
        </div>
        <button className="admin-btn admin-btn-ghost" onClick={() => fetchAll()} disabled={loading}>Refresh</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <AdminStatCard icon="warning" label="Open Violations" value={summary?.totals?.total_open || 0} />
        <AdminStatCard icon="warning" label="Critical Open" value={summary?.totals?.critical_open || 0} />
        <AdminStatCard icon="activity" label="High Severity" value={summary?.totals?.high_open || 0} />
        <AdminStatCard icon="trades" label="Visible Rows" value={filteredViolations.length} />
      </div>

      <AdminFilterBar searchPlaceholder="Search by violation type, account, user, or instrument..." searchValue={search} onSearchChange={setSearch}>
        {STATUS_FILTERS.map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${statusFilter === value ? 'active' : ''}`}
            onClick={() => setStatusFilter(value)}
          >
            {value === 'all' ? 'All Statuses' : formatLabel(value)}
          </button>
        ))}
        {SEVERITY_FILTERS.map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${severityFilter === value ? 'active' : ''}`}
            onClick={() => setSeverityFilter(value)}
          >
            {value === 'all' ? 'All Severity' : formatLabel(value)}
          </button>
        ))}
        {typeOptions.map(([type, count]) => (
          <button
            key={type}
            className={`admin-filter-chip ${typeFilter === type ? 'active' : ''}`}
            onClick={() => setTypeFilter((current) => current === type ? 'all' : type)}
          >
            {formatLabel(type)} ({count})
          </button>
        ))}
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel="violations"
        views={views}
        activeViewId={activeViewId}
        onSelectView={selectView}
        onSaveView={saveView}
        onUpdateView={currentView ? () => updateView(currentView) : null}
        onDeleteView={currentView ? () => deleteView(currentView) : null}
        columns={ALL_COLUMN_KEYS.map((key) => ({ key, header: key.replace(/([A-Z])/g, ' $1').replace(/\b\w/g, (char) => char.toUpperCase()) }))}
        visibleColumnKeys={visibleColumnKeys}
        onToggleColumn={toggleColumn}
        density={density}
        onDensityChange={setDensity}
        onExport={exportCurrentView}
        selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
        extraActions={selectedIds.length > 0 ? (
          <>
            {availableBulkActions.map((action) => (
              <button key={action} className="admin-btn admin-btn-ghost" onClick={() => runBulkAction(action)}>
                {mapBulkViolationLabel(action)}
              </button>
            ))}
          </>
        ) : null}
      />

      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={columns}
          data={filteredViolations}
          loading={loading}
          rowActions={rowActions}
          emptyMessage="No violations match the current filters"
          emptyIcon="warning"
          pagination={{ current: 1, total: 1 }}
          onPageChange={() => {}}
          density={density}
          onRowClick={(violation) => openViolation(violation)}
          selection={{
            selectedIds,
            allSelected,
            someSelected,
            onToggleAll: () => {
              if (allSelected) {
                setSelectedIds([]);
                return;
              }
              setSelectedIds(filteredViolations.map((violation) => String(violation.id)));
            },
            onToggleRow: (violation) => {
              setSelectedIds((current) => (
                current.includes(String(violation.id))
                  ? current.filter((id) => id !== String(violation.id))
                  : [...current, String(violation.id)]
              ));
            }
          }}
        />
      </Card>

      <Card>
        <h2 className="admin-h2" style={{ marginBottom: 'var(--space-4)' }}>Top Violation Types (Last 24h)</h2>
        {summary?.top_types_last_24h?.length > 0 ? (
          <div style={{ display: 'grid', gap: 'var(--space-2-5)' }}>
            {summary.top_types_last_24h.map((item) => (
              <div
                key={item.violation_type}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: 'var(--space-3) var(--space-3-5)',
                  border: '1px solid var(--admin-border)',
                  background: 'var(--admin-surface)'
                }}
              >
                <div style={{ color: 'var(--admin-text)', fontWeight: 500 }}>{formatLabel(item.violation_type)}</div>
                <div className="admin-td-mono" style={{ color: 'var(--admin-accent)', fontWeight: 700 }}>{item.total}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="admin-empty-state" style={{ minHeight: '160px' }}>
            <div className="admin-empty-title">No recent violation patterns</div>
          </div>
        )}
      </Card>

      <AdminModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={`Violation #${selectedViolation?.id || ''}`}
        size="lg"
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowModal(false)}>Close</button>
            {selectedViolation?.status !== 'resolved' && (
              <button className="admin-btn admin-btn-success" onClick={resolveViolation} disabled={saving || !!actionLoading}>
                {saving ? 'Saving...' : `Mark ${formatLabel(resolutionType)}`}
              </button>
            )}
            {selectedViolation?.account_id && (
              <button className="admin-btn admin-btn-primary" onClick={openAccountDetail} disabled={saving || !!actionLoading}>
                Open Account Detail
              </button>
            )}
          </>
        )}
      >
        {selectedViolation && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Type</div>
                <div style={{ marginTop: 'var(--space-1)', color: 'var(--admin-text)', fontWeight: 600 }}>{formatLabel(selectedViolation.violation_type)}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Severity</div>
                <div style={{ marginTop: 'var(--space-1)' }}>
                  <AdminBadge status={getSeverityTone(selectedViolation.severity)} label={formatLabel(selectedViolation.severity)} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Account ID</div>
                <div className="admin-td-mono" style={{ marginTop: 'var(--space-1)' }}>{selectedViolation.account_id || '-'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>User ID</div>
                <div className="admin-td-mono" style={{ marginTop: 'var(--space-1)' }}>{selectedViolation.user_id || '-'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Status</div>
                <div style={{ marginTop: 'var(--space-1)' }}>
                  <AdminBadge status={selectedViolation.status === 'resolved' ? 'success' : 'danger'} label={formatLabel(selectedViolation.status)} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Hit Count</div>
                <div className="admin-td-mono" style={{ marginTop: 'var(--space-1)' }}>{selectedViolation.hit_count || 1}</div>
              </div>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Message</label>
              <div style={{
                background: 'var(--admin-bg)',
                border: '1px solid var(--admin-border)',
                padding: 'var(--space-3-5)',
                color: 'var(--admin-text)',
                lineHeight: '1.6'
              }}>
                {selectedViolation.message || 'No message recorded'}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>First Detected</div>
                <div style={{ marginTop: 'var(--space-1)', color: 'var(--admin-text)' }}>{formatTimestamp(selectedViolation.first_detected_at)}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Last Detected</div>
                <div style={{ marginTop: 'var(--space-1)', color: 'var(--admin-text)' }}>{formatTimestamp(selectedViolation.last_detected_at)}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Instrument</div>
                <div className="admin-td-mono" style={{ marginTop: 'var(--space-1)' }}>{selectedViolation.instrument || '-'}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Source</div>
                <div style={{ marginTop: 'var(--space-1)', color: 'var(--admin-text)' }}>{formatLabel(selectedViolation.source)}</div>
              </div>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Payload</label>
              <div style={{
                background: 'var(--admin-bg)',
                border: '1px solid var(--admin-border)',
                padding: 'var(--space-3-5)',
                color: 'var(--admin-text)',
                fontSize: 'var(--fs-sm)',
                fontFamily: 'var(--admin-font-mono)',
                whiteSpace: 'pre-wrap',
                overflowX: 'auto'
              }}>
                {JSON.stringify(selectedViolation.payload_json || {}, null, 2)}
              </div>
            </div>

            {isSuperAdmin && selectedViolation.account_id && (
              <div className="admin-form-group">
                <label className="admin-label">Account Actions</label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-3)' }}>
                  <button className="admin-btn admin-btn-warning" onClick={() => performAccountAction('flag_for_review')} disabled={saving || !!actionLoading}>
                    {actionLoading === 'flag_for_review' ? 'Flagging...' : 'Flag For Review'}
                  </button>
                  <button className="admin-btn admin-btn-danger" onClick={() => performAccountAction('lock_account')} disabled={saving || !!actionLoading}>
                    {actionLoading === 'lock_account' ? 'Locking...' : 'Lock Account'}
                  </button>
                  <button className="admin-btn admin-btn-primary" onClick={() => performAccountAction('force_close_open_trades')} disabled={saving || !!actionLoading}>
                    {actionLoading === 'force_close_open_trades' ? 'Closing...' : 'Force Close Open Trades'}
                  </button>
                </div>
                <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2-5)' }}>
                  These actions use the current admin enforcement and account override APIs.
                </p>
              </div>
            )}

            {selectedViolation.status !== 'resolved' && (
              <>
                <div className="admin-form-group">
                  <label className="admin-label">Resolution Type</label>
                  <div style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap' }}>
                    {['resolved', 'waived', 'false_positive'].map((value) => (
                      <button
                        key={value}
                        className={`admin-filter-chip ${resolutionType === value ? 'active' : ''}`}
                        onClick={() => setResolutionType(value)}
                      >
                        {formatLabel(value)}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="admin-form-group">
                  <label className="admin-label">Resolution / Action Note</label>
                  <textarea
                    className="admin-textarea"
                    rows={4}
                    placeholder="Optional note for why this was reviewed, dismissed, or acted on..."
                    value={resolutionNote}
                    onChange={(event) => setResolutionNote(event.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </AdminModal>
    </>
  );
}
