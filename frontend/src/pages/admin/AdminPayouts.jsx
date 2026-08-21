import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { PageWrapper } from '../../App';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';

const DEFAULT_FILTERS = {
  status: 'all',
  flagged: 'all',
  disputeLinked: 'all'
};

const ALL_COLUMN_KEYS = ['request', 'trader', 'amount', 'destination', 'risk', 'tags', 'requested', 'status'];

function formatMoney(value) {
  return `$${(parseFloat(value) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getPayoutMethod(payout) {
  const rawMethod = String(payout.payment_method || '').trim();
  if (!rawMethod) return 'Wire/Crypto';
  return rawMethod.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
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

export default function AdminPayouts() {
  const { adminAxios, session, socket } = useOutletContext();
  const toast = useToast();
  const isSuperAdmin = session?.role === 'super_admin';

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
  const [sort, setSort] = useState({ key: 'requested_at', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [drawerRow, setDrawerRow] = useState(null);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'payouts' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  // FIX (AUDIT): stale-closure race — see AdminUsers.jsx for full explanation.
  const fetchPayouts = async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/payouts', {
        params: {
          format: 'list',
          page: effectivePage,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          status: filters.status !== 'all' ? filters.status : undefined,
          is_flagged: filters.flagged === 'all' ? undefined : filters.flagged === 'flagged',
          dispute_linked: filters.disputeLinked === 'all' ? undefined : filters.disputeLinked === 'linked'
        }
      });
      const next = normalizeAdminListResponse(res.data);
      setListData(next);
      setSelectedIds((current) => current.filter((id) => next.rows.some((row) => String(row.id) === id)));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load payout requests');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayouts();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchPayouts({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchPayouts({ silent: true });
    socket.on('admin_command_center_updated', refresh);
    return () => socket.off('admin_command_center_updated', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, page, sort, search, filters]);

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
    const name = window.prompt('Name this payout view', 'Flagged Payout Review');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'payouts',
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
      setSort({ key: 'requested_at', direction: 'desc' });
      setVisibleColumnKeys(ALL_COLUMN_KEYS);
      setDensity('comfortable');
      setPage(1);
      return;
    }
    const selectedView = views.find((view) => String(view.id) === String(viewId));
    const config = selectedView?.config_json || {};
    setSearch(config.search || '');
    setFilters({ ...DEFAULT_FILTERS, ...(config.filters || {}) });
    setSort(config.sort || { key: 'requested_at', direction: 'desc' });
    setVisibleColumnKeys(Array.isArray(config.columns) && config.columns.length > 0 ? config.columns : ALL_COLUMN_KEYS);
    setDensity(config.density || 'comfortable');
    setPage(1);
  };

  const processPayout = async (row, status) => {
    try {
      const endpoint = status === 'paid' ? '/api/admin/payouts/approve' : '/api/admin/payouts/reject';
      const payload = status === 'paid'
        ? { payout_id: row.id, transaction_id: row.transaction_id || null, reason: 'Approved from admin list' }
        : { payout_id: row.id, reason: 'Rejected from admin list' };

      await adminAxios.post(endpoint, payload);
      toast.success(status === 'paid' ? 'Payout marked as paid' : 'Payout rejected');
      fetchPayouts({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update payout');
    }
  };

  const toggleFlag = async (row, mode) => {
    const reason = window.prompt(
      mode === 'flag'
        ? `Why are you flagging payout PAY-${String(row.id).padStart(5, '0')}?`
        : `Why are you removing the flag from payout PAY-${String(row.id).padStart(5, '0')}?`,
      mode === 'flag' ? 'Risk review requested' : 'Risk review cleared'
    );
    if (!reason) return;

    try {
      await adminAxios.post(`/api/admin/payouts/${row.id}/${mode}`, { reason });
      toast.success(mode === 'flag' ? 'Payout flagged' : 'Payout unflagged');
      fetchPayouts({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to update payout flag');
    }
  };

  const applyTagToSelection = async () => {
    if (selectedIds.length === 0) return;
    const tag = window.prompt(`Tag ${selectedIds.length} selected payouts`, 'payout-hold');
    if (!tag) return;
    try {
      await adminAxios.post('/api/admin/tags/assign', {
        entity_type: 'payout',
        ids: selectedIds,
        tags: [tag],
        mode: 'add'
      });
      toast.success('Tags updated');
      fetchPayouts({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to tag payouts');
    }
  };

  const columns = useMemo(() => ([
    { header: 'Request ID', key: 'request', isMono: true, sortKey: 'requested_at', render: (p) => `PAY-${String(p.id).padStart(5, '0')}` },
    {
      header: 'Trader',
      key: 'trader',
      sortKey: 'requested_at',
      render: (p) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{p.full_name || p.email || 'Unknown User'}</div>
          {p.full_name && <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>{p.email}</div>}
          <div style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-xs)' }}>Acc #{p.account_id}</div>
        </div>
      )
    },
    { header: 'Requested Amount', key: 'amount', isMono: true, sortKey: 'amount_requested', render: (p) => formatMoney(p.amount_requested) },
    { header: 'Destination', key: 'destination', render: (p) => getPayoutMethod(p) },
    { header: 'Risk', key: 'risk', sortKey: 'risk_tier', render: (p) => <AdminBadge status={p.risk_tier === 'high' ? 'warning' : 'info'} label={p.risk_tier || 'low'} /> },
    {
      header: 'Tags',
      key: 'tags',
      render: (p) => (
        <div className="admin-tag-row">
          {(p.tags || []).slice(0, 3).map((tag) => <span key={tag} className="admin-tag-pill static">{tag}</span>)}
          {(p.tags || []).length > 3 && <span style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-sm)' }}>+{p.tags.length - 3}</span>}
        </div>
      )
    },
    { header: 'Requested Date', key: 'requested', sortKey: 'requested_at', render: (p) => new Date(p.requested_at).toLocaleString() },
    {
      header: 'Status',
      key: 'status',
      sortKey: 'status',
      render: (p) => (
        <div>
          <AdminBadge status={p.status} />
          {p.is_flagged && <div style={{ marginTop: 'var(--space-1-5)' }}><AdminBadge status="warning" label="Flagged" /></div>}
        </div>
      )
    }
  ]), []);

  const visibleColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < rows.length;

  const getRowActions = (payout) => {
    const allowedActions = new Set(Array.isArray(payout.allowed_actions) ? payout.allowed_actions : []);
    const actions = [
      { label: 'Preview', icon: 'info', onClick: () => setDrawerRow(payout) }
    ];

    if (allowedActions.has('approve_payout')) {
      actions.push({ label: 'Mark as Paid', icon: 'approve', onClick: () => processPayout(payout, 'paid') });
    }
    if (allowedActions.has('reject_payout')) {
      actions.push({ label: 'Reject', icon: 'x', onClick: () => processPayout(payout, 'rejected'), danger: true });
    }
    if (isSuperAdmin && allowedActions.has('flag_payout')) {
      actions.push({ label: 'Flag Payout', icon: 'flag', onClick: () => toggleFlag(payout, 'flag') });
    }
    if (isSuperAdmin && allowedActions.has('unflag_payout')) {
      actions.push({ label: 'Unflag Payout', icon: 'approve', onClick: () => toggleFlag(payout, 'unflag') });
    }
    return actions;
  };

  return (
    <PageWrapper>
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-6)' }}>
          <div>
            <h1 className="admin-h1">Payout Operations</h1>
            <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>Review finance queues with saved views, classifications, tags, and risk context.</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
          <AdminStatCard icon="wallet" label="Total Requests" value={summary.total || 0} />
          <AdminStatCard icon="history" label="Pending" value={summary.pending || 0} />
          <AdminStatCard icon="approve" label="Paid" value={summary.paid || 0} />
          <AdminStatCard icon="warning" label="Flagged" value={summary.flagged || 0} />
        </div>

        <AdminFilterBar searchPlaceholder="Search via payout ID, email, or account..." searchValue={search} onSearchChange={setSearch}>
          {['all', 'pending', 'paid', 'rejected'].map((status) => (
            <button
              key={status}
              className={`admin-filter-chip ${filters.status === status ? 'active' : ''}`}
              onClick={() => setFilters((current) => ({ ...current, status }))}
            >
              {status === 'all' ? 'All Statuses' : status}
            </button>
          ))}
          <select className="admin-select" style={{ width: '160px' }} value={filters.flagged} onChange={(event) => setFilters((current) => ({ ...current, flagged: event.target.value }))}>
            <option value="all">All flags</option>
            <option value="flagged">Flagged only</option>
            <option value="clear">Unflagged only</option>
          </select>
          <select className="admin-select" style={{ width: '180px' }} value={filters.disputeLinked} onChange={(event) => setFilters((current) => ({ ...current, disputeLinked: event.target.value }))}>
            <option value="all">All disputes</option>
            <option value="linked">Dispute linked</option>
            <option value="clear">No dispute</option>
          </select>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="payouts"
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
          onExport={() => exportAdminResource(adminAxios, 'payouts', {
            search,
            sort: sort.key,
            order: sort.direction,
            filters: {
              status: filters.status !== 'all' ? filters.status : null,
              is_flagged: filters.flagged === 'all' ? null : filters.flagged === 'flagged',
              dispute_linked: filters.disputeLinked === 'all' ? null : filters.disputeLinked === 'linked'
            }
          })}
          selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
          extraActions={selectedIds.length > 0 ? (
            <button className="admin-btn admin-btn-ghost" onClick={applyTagToSelection}>
              Tag Selected
            </button>
          ) : null}
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
            onRowClick={(row) => setDrawerRow(row)}
            selection={{
              selectedIds,
              allSelected,
              someSelected,
              onToggleRow: (row) => setSelectedIds((current) => (
                current.includes(String(row.id))
                  ? current.filter((id) => id !== String(row.id))
                  : [...current, String(row.id)]
              )),
              onToggleAll: () => setSelectedIds(allSelected ? [] : rows.map((row) => String(row.id)))
            }}
          />
        </Card>

        <AdminEntityDrawer
          open={!!drawerRow}
          entityType="payout"
          row={drawerRow}
          title={drawerRow ? `Payout PAY-${String(drawerRow.id).padStart(5, '0')}` : ''}
          adminAxios={adminAxios}
          onClose={() => setDrawerRow(null)}
          onRefresh={() => fetchPayouts({ silent: true })}
          quickActions={drawerRow ? [
            ...(Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('approve_payout') ? [
              { label: 'Mark as Paid', onClick: () => processPayout(drawerRow, 'paid') }
            ] : []),
            ...(Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('reject_payout') ? [
              { label: 'Reject', onClick: () => processPayout(drawerRow, 'rejected') }
            ] : []),
            ...(isSuperAdmin && Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('flag_payout') ? [
              { label: 'Flag Payout', onClick: () => toggleFlag(drawerRow, 'flag') }
            ] : []),
            ...(isSuperAdmin && Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('unflag_payout') ? [
              { label: 'Unflag Payout', onClick: () => toggleFlag(drawerRow, 'unflag') }
            ] : [])
          ] : []}
        />
      </>
    </PageWrapper>
  );
}
