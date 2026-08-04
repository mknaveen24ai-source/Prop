import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminStatGrid from '../../components/admin/AdminStatGrid';
import { useToast } from '../../components/admin/AdminToast';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';

const DEFAULT_FILTERS = {
  phase: 'all',
  status: 'all',
  reviewFlagged: 'all',
  month: new Date().toISOString().slice(0, 7),
  promotionReview: 'all'
};

const ALL_COLUMN_KEYS = ['account', 'trader', 'phase', 'status', 'review', 'size', 'balance', 'risk', 'tags', 'created'];

function formatAccountType(accountType) {
  if (accountType === 'phase1') return 'Phase 1';
  if (accountType === 'phase2') return 'Phase 2';
  return accountType || 'Unknown';
}

function formatMoney(value) {
  return `$${parseFloat(value || 0).toFixed(2)}`;
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

export default function AdminChallenges() {
  const { adminAxios, socket } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [listData, setListData] = useState({
    summary: {},
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 }
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedAcc, setSelectedAcc] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'accounts' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  // FIX (AUDIT): stale-closure race — see AdminUsers.jsx for full explanation.
  const fetchAccounts = async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/accounts', {
        params: {
          format: 'list',
          page: effectivePage,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          account_type: filters.phase !== 'all' ? filters.phase : 'phase1,phase2',
          status: filters.status !== 'all' ? filters.status : undefined,
          review_flagged: filters.reviewFlagged === 'all' ? undefined : filters.reviewFlagged === 'flagged',
          month: filters.month ? `${filters.month}-01` : undefined,
          promotion_review_status: filters.promotionReview !== 'all' ? filters.promotionReview : undefined
        }
      });
      const next = normalizeAdminListResponse(res.data);
      next.rows = (next.rows || []).filter((row) => ['phase1', 'phase2'].includes(row.account_type));
      setListData(next);
    } catch {
      toast.error('Failed to load challenge accounts');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAccounts();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchAccounts({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchAccounts({ silent: true });
    socket.on('admin_command_center_updated', refresh);
    return () => socket.off('admin_command_center_updated', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, page, sort, search, filters]);

  function openAccountModal(account) {
    setSelectedAcc(account);
    setOverrideReason('');
    setAdjustAmount('');
    setAdjustReason('');
    setShowOverrideModal(true);
  }

  async function executeOverride(action, extra = {}) {
    if (!selectedAcc || submitting) return;
    setSubmitting(true);
    try {
      const res = await adminAxios.post(`/api/admin/accounts/${selectedAcc.id}/override`, {
        action,
        reason: overrideReason,
        ...extra
      });
      toast.success(res.data?.message || 'Override applied successfully');
      await fetchAccounts({ silent: true });
      setShowOverrideModal(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to apply override');
    } finally {
      setSubmitting(false);
    }
  }

  async function applyBalanceAdjustment() {
    if (!selectedAcc || submitting) return;
    setSubmitting(true);
    try {
      const res = await adminAxios.post(`/api/admin/accounts/${selectedAcc.id}/adjust-balance`, {
        amount: parseFloat(adjustAmount),
        reason: adjustReason
      });
      toast.success(res.data?.message || 'Balance adjusted successfully');
      await fetchAccounts({ silent: true });
      setShowOverrideModal(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to adjust balance');
    } finally {
      setSubmitting(false);
    }
  }

  const rows = listData.rows || [];
  const summary = listData.summary || {};
  const pagination = listData.pagination || { current: 1, total: 1 };

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

  const saveView = async () => {
    const name = window.prompt('Name this account view', 'Breach Risk Queue');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'accounts',
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

  const columns = useMemo(() => ([
    {
      header: 'Account',
      key: 'account',
      sortKey: 'created_at',
      render: (account) => (
        <div>
          <div className="admin-td-mono">{account.account_uid || `#${String(account.id).padStart(5, '0')}`}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>#{account.id}</div>
        </div>
      )
    },
    {
      header: 'Trader',
      key: 'trader',
      render: (account) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{account.full_name || 'Unnamed Trader'}</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{account.user_email || account.email}</div>
        </div>
      )
    },
    { header: 'Phase', key: 'phase', sortKey: 'account_type', render: (account) => formatAccountType(account.account_type) },
    { header: 'Status', key: 'status', sortKey: 'status', render: (account) => <AdminBadge status={account.status} label={account.status?.toUpperCase()} /> },
    {
      header: 'Promotion Review',
      key: 'review',
      render: (account) => account.promotion_review_status
        ? <AdminBadge status={account.promotion_review_status === 'pending' ? 'warning' : account.promotion_review_status === 'approved' ? 'success' : 'danger'} label={`${account.promotion_review_status.toUpperCase()} ${account.promotion_target_account_type || ''}`} />
        : <span style={{ color: 'var(--admin-text-faint)' }}>None</span>
    },
    { header: 'Size', key: 'size', isMono: true, sortKey: 'account_size', render: (account) => `$${parseFloat(account.account_size || 0).toLocaleString()}` },
    { header: 'Balance', key: 'balance', isMono: true, sortKey: 'current_balance', render: (account) => formatMoney(account.current_balance) },
    { header: 'Risk', key: 'risk', sortKey: 'risk_tier', render: (account) => <AdminBadge status={account.risk_tier === 'critical' ? 'danger' : account.risk_tier === 'high' ? 'warning' : 'info'} label={account.risk_tier || 'low'} /> },
    {
      header: 'Tags',
      key: 'tags',
      render: (account) => (
        <div className="admin-tag-row">
          {(account.tags || []).slice(0, 2).map((tag) => <span key={tag} className="admin-tag-pill static">{tag}</span>)}
          {(account.tags || []).length > 2 && <span style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>+{account.tags.length - 2}</span>}
        </div>
      )
    },
    { header: 'Created', key: 'created', sortKey: 'created_at', render: (account) => new Date(account.created_at).toLocaleDateString() }
  ]), []);

  const visibleColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
  const getRowActions = (account) => [
    { label: 'Manage Account', icon: 'settings', onClick: () => openAccountModal(account) }
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">Active Challenges</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Saved views, classifications, and fast account controls for Phase 1 and Phase 2 operations.
          </p>
        </div>
      </div>

      <AdminStatGrid>
        <AdminStatCard icon="wallet" label="Total Challenges" value={(summary.total || 0)} />
        <AdminStatCard icon="activity" label="Active" value={summary.active || 0} />
        <AdminStatCard icon="warning" label="Breached / Locked" value={summary.breached || 0} />
        <AdminStatCard icon="warning" label="Review Flagged" value={summary.review_flagged || 0} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search via account ID, UID, or trader email..." searchValue={search} onSearchChange={setSearch}>
        {[
          { label: 'All', value: 'all' },
          { label: 'Phase 1', value: 'phase1' },
          { label: 'Phase 2', value: 'phase2' }
        ].map((item) => (
          <button
            key={item.value}
            className={`admin-filter-chip ${filters.phase === item.value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, phase: item.value }))}
          >
            {item.label}
          </button>
        ))}
        <select className="admin-select" style={{ width: '160px' }} value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="passed">Passed</option>
          <option value="failed">Failed</option>
          <option value="locked">Locked</option>
          <option value="expired">Expired</option>
        </select>
        <select className="admin-select" style={{ width: '180px' }} value={filters.reviewFlagged} onChange={(event) => setFilters((current) => ({ ...current, reviewFlagged: event.target.value }))}>
          <option value="all">All review states</option>
          <option value="flagged">Flagged only</option>
          <option value="clear">Clear only</option>
        </select>
        <input className="admin-input" style={{ width: '160px' }} type="month" value={filters.month} onChange={(event) => setFilters((current) => ({ ...current, month: event.target.value }))} />
        <select className="admin-select" style={{ width: '190px' }} value={filters.promotionReview} onChange={(event) => setFilters((current) => ({ ...current, promotionReview: event.target.value }))}>
          <option value="all">All promotions</option>
          <option value="pending">Pending promotion</option>
          <option value="approved">Approved promotion</option>
          <option value="rejected">Rejected promotion</option>
        </select>
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel="accounts"
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
        onExport={() => exportAdminResource(adminAxios, 'accounts', {
          search,
          sort: sort.key,
          order: sort.direction,
          filters: {
            account_type: filters.phase !== 'all' ? filters.phase : 'phase1,phase2',
            status: filters.status !== 'all' ? filters.status : null,
            review_flagged: filters.reviewFlagged === 'all' ? null : filters.reviewFlagged === 'flagged',
            month: filters.month ? `${filters.month}-01` : null,
            promotion_review_status: filters.promotionReview !== 'all' ? filters.promotionReview : null
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
          onRowClick={(row) => openAccountModal(row)}
        />
      </Card>

      <AdminModal
        isOpen={showOverrideModal}
        onClose={() => setShowOverrideModal(false)}
        title={`Challenge Account ${selectedAcc?.account_uid || `#${String(selectedAcc?.id || '').padStart(5, '0')}`}`}
        size="lg"
        footer={(
          <button className="admin-btn admin-btn-ghost" onClick={() => setShowOverrideModal(false)} disabled={submitting}>
            Close
          </button>
        )}
      >
        {selectedAcc && (
          <div style={{ display: 'grid', gap: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '16px' }}>
              {[
                { label: 'Phase', value: formatAccountType(selectedAcc.account_type) },
                { label: 'Status', value: selectedAcc.status?.toUpperCase() },
                { label: 'Balance', value: formatMoney(selectedAcc.current_balance) },
                { label: 'Peak', value: formatMoney(selectedAcc.peak_balance) }
              ].map((card) => (
                <div key={card.label} style={{ background: 'var(--admin-bg)', padding: '16px', border: '1px solid var(--admin-border)' }}>
                  <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>{card.label}</div>
                  <div style={{ marginTop: '6px', fontSize: '22px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700 }}>
                    {card.value}
                  </div>
                </div>
              ))}
            </div>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Override Reason</h3>
              <textarea
                className="admin-input"
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                placeholder="Why are you overriding this account?"
                rows={3}
                style={{ resize: 'vertical', minHeight: '96px' }}
              />
            </Card>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Account Controls</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px' }}>
                <button className="admin-btn admin-btn-success" onClick={() => executeOverride('pass')} disabled={submitting}>
                  Force Pass & Queue Review
                </button>
                <button className="admin-btn admin-btn-danger" onClick={() => executeOverride('fail')} disabled={submitting}>
                  Breach Account
                </button>
                <button className="admin-btn admin-btn-primary" onClick={() => executeOverride('force_close_open_trades')} disabled={submitting}>
                  Force Close Open Trades
                </button>
                <button className="admin-btn admin-btn-ghost" onClick={() => executeOverride('extend_days', { days: 14 })} disabled={submitting}>
                  Extend 14 Days
                </button>
              </div>
            </Card>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Balance Adjustment</h3>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginBottom: '16px' }}>
                Use a positive number to credit the account or a negative number to debit it.
              </p>
              <div style={{ display: 'grid', gap: '12px' }}>
                <input
                  className="admin-input admin-font-mono"
                  type="number"
                  step="0.01"
                  value={adjustAmount}
                  onChange={(event) => setAdjustAmount(event.target.value)}
                  placeholder="e.g. 150.00 or -75.50"
                />
                <textarea
                  className="admin-input"
                  value={adjustReason}
                  onChange={(event) => setAdjustReason(event.target.value)}
                  placeholder="Reason for this adjustment"
                  rows={3}
                  style={{ resize: 'vertical', minHeight: '88px' }}
                />
                <button className="admin-btn admin-btn-primary" onClick={applyBalanceAdjustment} disabled={submitting}>
                  Apply Balance Adjustment
                </button>
              </div>
            </Card>
          </div>
        )}
      </AdminModal>
    </>
  );
}
