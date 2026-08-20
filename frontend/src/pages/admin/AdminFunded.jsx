import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminStatGrid from '../../components/admin/AdminStatGrid';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';

const DEFAULT_FILTERS = {
  status: 'all',
  reviewFlagged: 'all'
};

const ALL_COLUMN_KEYS = ['account', 'trader', 'status', 'size', 'balance', 'payouts', 'split', 'risk', 'tags', 'created'];

function formatMoney(value) {
  return `$${(parseFloat(value || 0) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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

export default function AdminFunded() {
  const { adminAxios, socket } = useOutletContext();
  const navigate = useNavigate();
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
  const [selectedIds, setSelectedIds] = useState([]);
  const [drawerRow, setDrawerRow] = useState(null);
  const [selectedAcc, setSelectedAcc] = useState(null);
  const [showManageModal, setShowManageModal] = useState(false);
  const [overrideReason, setOverrideReason] = useState('');
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'funded' } });
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
          account_type: 'funded',
          status: filters.status !== 'all' ? filters.status : undefined,
          review_flagged: filters.reviewFlagged === 'all' ? undefined : filters.reviewFlagged === 'flagged'
        }
      });
      const next = normalizeAdminListResponse(res.data);
      next.rows = (next.rows || []).filter((row) => String(row.account_type || '').toLowerCase() === 'funded');
      setListData(next);
      setSelectedIds((current) => current.filter((id) => next.rows.some((row) => String(row.id) === id)));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load funded accounts');
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
    socket.on('admin_enforcement_event', refresh);
    return () => {
      socket.off('admin_command_center_updated', refresh);
      socket.off('admin_enforcement_event', refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, page, sort, search, filters]);

  function openManageModal(account) {
    setSelectedAcc(account);
    setOverrideReason('');
    setAdjustAmount('');
    setAdjustReason('');
    setShowManageModal(true);
  }

  async function executeOverride(action) {
    if (!selectedAcc || submitting) return;
    setSubmitting(true);
    try {
      const res = await adminAxios.post(`/api/admin/accounts/${selectedAcc.id}/override`, {
        action,
        reason: overrideReason
      });
      toast.success(res.data?.message || 'Admin action applied');
      await fetchAccounts({ silent: true });
      setShowManageModal(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to apply admin action');
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
      setShowManageModal(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to adjust balance');
    } finally {
      setSubmitting(false);
    }
  }

  const rows = listData.rows || [];
  const summary = listData.summary || {};
  const pagination = listData.pagination || { current: 1, total: 1 };

  const toggleRowSelection = (rowId) => {
    setSelectedIds((current) => (
      current.includes(String(rowId))
        ? current.filter((id) => id !== String(rowId))
        : [...current, String(rowId)]
    ));
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

  const saveView = async () => {
    const name = window.prompt('Name this funded view', 'Funded Risk Review');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'funded',
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

  const applyTagToSelection = async () => {
    if (selectedIds.length === 0) return;
    const tag = window.prompt(`Tag ${selectedIds.length} selected funded accounts`, 'fast-payout');
    if (!tag) return;
    try {
      await adminAxios.post('/api/admin/tags/assign', {
        entity_type: 'account',
        ids: selectedIds,
        tags: [tag],
        mode: 'add'
      });
      toast.success('Tags updated');
      fetchAccounts({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to tag funded accounts');
    }
  };

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'accounts', {
        search,
        sort: sort.key,
        order: sort.direction,
        filters: {
          account_type: 'funded',
          status: filters.status !== 'all' ? filters.status : null,
          review_flagged: filters.reviewFlagged === 'all' ? null : filters.reviewFlagged === 'flagged'
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export funded accounts');
    }
  };

  const columns = useMemo(() => {
    const allColumns = [
      {
        header: 'Account',
        key: 'account',
        sortKey: 'created_at',
        render: (account) => (
          <div>
            <div className="admin-td-mono">{account.account_uid || `#${String(account.id).padStart(5, '0')}`}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>#{account.id}</div>
          </div>
        )
      },
      {
        header: 'Trader',
        key: 'trader',
        sortKey: 'user_email',
        render: (account) => (
          <div>
            <div style={{ color: 'var(--admin-text)' }}>{account.full_name || 'Unnamed Trader'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{account.user_email || account.email}</div>
          </div>
        )
      },
      {
        header: 'Status',
        key: 'status',
        sortKey: 'status',
        render: (account) => <AdminBadge status={account.status} label={`${account.status?.toUpperCase()} / FUNDED`} />
      },
      {
        header: 'Size',
        key: 'size',
        sortKey: 'account_size',
        isMono: true,
        render: (account) => `$${parseFloat(account.account_size || 0).toLocaleString()}`
      },
      {
        header: 'Balance',
        key: 'balance',
        sortKey: 'current_balance',
        isMono: true,
        render: (account) => formatMoney(account.current_balance)
      },
      {
        header: 'Payouts',
        key: 'payouts',
        isMono: true,
        render: (account) => formatMoney(account.total_payouts)
      },
      {
        header: 'Split',
        key: 'split',
        render: (account) => {
          const split = parseFloat(account.profit_split || 80);
          return `${split.toFixed(0)} / ${(100 - split).toFixed(0)}`;
        }
      },
      {
        header: 'Risk',
        key: 'risk',
        render: (account) => (
          <div>
            {account.risk_tier ? <AdminBadge status={account.risk_tier === 'critical' ? 'danger' : account.risk_tier === 'high' ? 'warning' : 'info'} label={account.risk_tier} /> : <span style={{ color: 'var(--admin-text-faint)' }}>-</span>}
            <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)', marginTop: 'var(--space-1-5)' }}>
              {account.review_flagged ? 'Review flagged' : account.classification || 'No classification'}
            </div>
          </div>
        )
      },
      {
        header: 'Tags',
        key: 'tags',
        render: (account) => (
          <div style={{ display: 'flex', gap: 'var(--space-1-5)', flexWrap: 'wrap' }}>
            {(account.tags || []).slice(0, 3).map((tag) => (
              <span key={tag} className="admin-tag-pill static">{tag}</span>
            ))}
            {(!account.tags || account.tags.length === 0) && <span style={{ color: 'var(--admin-text-faint)' }}>-</span>}
          </div>
        )
      },
      {
        header: 'Created',
        key: 'created',
        sortKey: 'created_at',
        render: (account) => new Date(account.created_at).toLocaleDateString()
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < rows.length;

  const rowActions = (account) => [
    { label: 'Preview', icon: 'info', onClick: () => setDrawerRow(account) },
    { label: 'Manage Funded Account', icon: 'settings', onClick: () => openManageModal(account) },
    { label: 'Open Account Detail', icon: 'info', onClick: () => navigate(`/admin/accounts/${account.id}`) }
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Funded Accounts</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
            Manage funded balances, review flags, and post-evaluation risk actions from one operator queue.
          </p>
        </div>
      </div>

      <AdminStatGrid>
        <AdminStatCard icon="funded" label="Funded Accounts" value={summary.funded || rows.length} />
        <AdminStatCard icon="activity" label="Active Funded" value={summary.active || 0} />
        <AdminStatCard icon="warning" label="Review Flagged" value={summary.review_flagged || 0} />
        <AdminStatCard icon="wallet" label="Open Trades" value={summary.open_trades || 0} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search by account ID, UID, or trader email..." searchValue={search} onSearchChange={setSearch}>
        {['all', 'active', 'locked', 'failed'].map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${filters.status === value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, status: value }))}
          >
            {value === 'all' ? 'All Statuses' : value.toUpperCase()}
          </button>
        ))}
        {['all', 'flagged', 'clear'].map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${filters.reviewFlagged === value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, reviewFlagged: value }))}
          >
            {value === 'all' ? 'All Review States' : value === 'flagged' ? 'Flagged' : 'Clear'}
          </button>
        ))}
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel="funded accounts"
        views={views}
        activeViewId={activeViewId}
        onSelectView={selectView}
        onSaveView={saveView}
        onUpdateView={currentView ? () => updateView(currentView) : null}
        onDeleteView={currentView ? () => deleteView(currentView) : null}
        columns={ALL_COLUMN_KEYS.map((key) => ({ key, header: key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()) }))}
        visibleColumnKeys={visibleColumnKeys}
        onToggleColumn={toggleColumn}
        density={density}
        onDensityChange={setDensity}
        onExport={exportCurrentView}
        selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
        extraActions={selectedIds.length > 0 ? (
          <button className="admin-btn admin-btn-ghost" onClick={applyTagToSelection}>
            Tag Selection
          </button>
        ) : null}
      />

      <Card flush>
        <AdminDataTable
          columns={columns}
          data={rows}
          loading={loading}
          rowActions={rowActions}
          pagination={pagination}
          onPageChange={setPage}
          sort={sort}
          onSortChange={handleSortChange}
          density={density}
          onRowClick={(row) => setDrawerRow(row)}
          selection={{
            selectedIds,
            allSelected,
            someSelected,
            onToggleAll: () => {
              if (allSelected) {
                setSelectedIds([]);
                return;
              }
              setSelectedIds(rows.map((row) => String(row.id)));
            },
            onToggleRow: (row) => toggleRowSelection(row.id)
          }}
        />
      </Card>

      <AdminEntityDrawer
        open={!!drawerRow}
        entityType="account"
        row={drawerRow}
        title={drawerRow ? `Funded Account ${drawerRow.account_uid || `#${String(drawerRow.id).padStart(5, '0')}`}` : ''}
        adminAxios={adminAxios}
        quickActions={drawerRow ? [
          { label: 'Manage Account', onClick: () => openManageModal(drawerRow) },
          { label: 'Open Detail', onClick: () => navigate(`/admin/accounts/${drawerRow.id}`) }
        ] : []}
        onClose={() => setDrawerRow(null)}
        onRefresh={() => fetchAccounts({ silent: true })}
      />

      <AdminModal
        isOpen={showManageModal}
        onClose={() => setShowManageModal(false)}
        title={`Funded Account ${selectedAcc?.account_uid || `#${String(selectedAcc?.id || '').padStart(5, '0')}`}`}
        size="lg"
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowManageModal(false)} disabled={submitting}>
              Close
            </button>
          </>
        )}
      >
        {selectedAcc && (
          <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
              {[
                { label: 'Status', value: selectedAcc.status?.toUpperCase() },
                { label: 'Balance', value: formatMoney(selectedAcc.current_balance) },
                { label: 'Peak', value: formatMoney(selectedAcc.peak_balance) },
                { label: 'Paid Out', value: formatMoney(selectedAcc.total_payouts) }
              ].map((card) => (
                <div key={card.label} style={{ background: 'var(--admin-bg)', padding: 'var(--space-4)', border: '1px solid var(--admin-border)' }}>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>{card.label}</div>
                  <div style={{ marginTop: 'var(--space-1-5)', fontSize: 'var(--fs-3xl)', fontFamily: 'var(--admin-font-mono)', fontWeight: 700 }}>
                    {card.value}
                  </div>
                </div>
              ))}
            </div>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Action Reason</h3>
              <textarea
                className="admin-input"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                placeholder="Why are you closing or revoking this funded account?"
                rows={3}
                style={{ resize: 'vertical', minHeight: '96px' }}
              />
            </Card>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Funded Controls</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-3)' }}>
                <button className="admin-btn admin-btn-primary" onClick={() => executeOverride('force_close_open_trades')} disabled={submitting}>
                  Force Close Open Trades
                </button>
                <button className="admin-btn admin-btn-danger" onClick={() => executeOverride('revoke_funded')} disabled={submitting}>
                  Revoke And Lock Funded Account
                </button>
              </div>
            </Card>

            <Card style={{ margin: 0 }}>
              <h3 className="admin-h3">Balance Adjustment</h3>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-4)' }}>
                Use a positive amount to credit or a negative amount to debit the funded balance.
              </p>
              <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
                <input
                  className="admin-input admin-font-mono"
                  type="number"
                  step="0.01"
                  value={adjustAmount}
                  onChange={(e) => setAdjustAmount(e.target.value)}
                  placeholder="e.g. 250.00 or -100.00"
                />
                <textarea
                  className="admin-input"
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="Reason for this funded balance adjustment"
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
