import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { PageWrapper } from '../../App';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';

const DEFAULT_FILTERS = {
  kycStatus: 'all',
  bannedState: 'all',
  fundedOnly: false,
  riskTier: 'all'
};

const ALL_COLUMN_KEYS = [
  'trader',
  'uid',
  'country',
  'kyc',
  'accounts',
  'risk',
  'classification',
  'tags',
  'joined',
  'status'
];

function buildViewConfig({ search, filters, sort, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    sort,
    columns: visibleColumnKeys,
    density
  };
}

export default function AdminUsers() {
  const { adminAxios, session, socket } = useOutletContext();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isSuperAdmin = session?.role === 'super_admin';

  const [loading, setLoading] = useState(true);
  const [listData, setListData] = useState({
    summary: {},
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 },
    facets: {},
    default_sort: { key: 'created_at', direction: 'desc' }
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState(searchParams.get('q') || '');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'created_at', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [drawerRow, setDrawerRow] = useState(null);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'traders' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchUsers = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/traders', {
        params: {
          format: 'list',
          page,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          kyc_status: filters.kycStatus !== 'all' ? filters.kycStatus : undefined,
          is_banned: filters.bannedState === 'all' ? undefined : filters.bannedState === 'banned',
          funded_only: filters.fundedOnly ? true : undefined,
          risk_tier: filters.riskTier !== 'all' ? filters.riskTier : undefined
        }
      });
      const nextData = normalizeAdminListResponse(res.data);
      setListData(nextData);
      setSelectedIds((current) => current.filter((id) => nextData.rows.some((row) => String(row.id) === id)));
    } catch (err) {
      if (!silent) {
        toast.error(err?.response?.data?.error || 'Failed to load users');
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchUsers({ silent: true });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchUsers({ silent: true });
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
    const name = window.prompt('Name this saved view', activeViewId ? 'My Saved View' : 'KYC Review Queue');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'traders',
        name,
        config: buildViewConfig({ search, filters, sort, visibleColumnKeys, density }),
        is_default: false
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
    const tag = window.prompt(`Tag ${selectedIds.length} selected traders`, 'manual-review');
    if (!tag) return;
    try {
      await adminAxios.post('/api/admin/tags/assign', {
        entity_type: 'user',
        ids: selectedIds,
        tags: [tag],
        mode: 'add'
      });
      toast.success('Tags updated');
      fetchUsers({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to tag traders');
    }
  };

  const handleAction = async (action, user) => {
    if (!user) return;

    if (action === 'view') {
      setDrawerRow(user);
      return;
    }

    if (action === 'ban') {
      try {
        await adminAxios.post('/api/admin/ban', { user_id: user.id, reason: 'Admin console ban' });
        toast.success('Trader banned');
        fetchUsers({ silent: true });
      } catch (err) {
        toast.error(err?.response?.data?.error || 'Failed to ban trader');
      }
      return;
    }

    if (action === 'unban') {
      try {
        await adminAxios.post('/api/admin/unban', { user_id: user.id, reason: 'Admin console unban' });
        toast.success('Trader unbanned');
        fetchUsers({ silent: true });
      } catch (err) {
        toast.error(err?.response?.data?.error || 'Failed to unban trader');
      }
      return;
    }

    if (action === 'revoke_sessions') {
      const reason = window.prompt(`Why are you revoking sessions for ${user.email}?`, 'Support session reset');
      if (!reason) return;
      try {
        await adminAxios.post(`/api/admin/users/${user.id}/revoke-sessions`, { reason });
        toast.success('Trader sessions revoked');
        fetchUsers({ silent: true });
      } catch (err) {
        toast.error(err?.response?.data?.error || 'Failed to revoke sessions');
      }
      return;
    }

    if (action === 'manual_account') {
      const reason = window.prompt(`Why are you issuing a manual account to ${user.email}?`, 'Support courtesy account');
      if (!reason) return;
      const accountType = window.prompt('Account type: phase1, phase2, or funded', 'phase1');
      if (!accountType) return;
      const accountSize = window.prompt('Account size', '10000');
      if (!accountSize) return;

      try {
        await adminAxios.post(`/api/admin/users/${user.id}/manual-account`, {
          reason,
          account_type: accountType,
          account_size: parseInt(accountSize, 10)
        });
        toast.success('Manual account issued');
        fetchUsers({ silent: true });
      } catch (err) {
        toast.error(err?.response?.data?.error || 'Failed to issue manual account');
      }
      return;
    }
  };

  const columns = useMemo(() => ([
    {
      header: 'Trader',
      key: 'trader',
      sortKey: 'full_name',
      width: '260px',
      render: (u) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="admin-avatar" style={{ width: '36px', height: '36px', fontSize: '13px', background: u.is_banned ? 'var(--admin-danger)' : undefined }}>
            {(u.full_name || u.email || 'A').charAt(0).toUpperCase()}
          </div>
          <div>
            <div style={{ color: 'var(--admin-text)', fontWeight: 500, fontSize: '13px' }}>{u.full_name || 'Unnamed Trader'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px' }}>{u.email}</div>
          </div>
        </div>
      )
    },
    { header: 'UID', key: 'uid', isMono: true, sortKey: 'created_at', render: (u) => String(u.id).padStart(5, '0') },
    { header: 'Country', key: 'country', sortKey: 'country', render: (u) => u.country || '—' },
    { header: 'KYC', key: 'kyc', sortKey: 'kyc_status', render: (u) => <AdminBadge status={u.kyc_status || 'pending'} /> },
    {
      header: 'Accounts',
      key: 'accounts',
      sortKey: 'account_count',
      render: (u) => (
        <div>
          <div style={{ color: 'var(--admin-text)' }}>{u.account_count || 0} total</div>
          <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{u.active_account_count || 0} active</div>
        </div>
      )
    },
    { header: 'Risk', key: 'risk', sortKey: 'risk_tier', render: (u) => <AdminBadge status={u.risk_tier === 'critical' ? 'danger' : u.risk_tier === 'high' ? 'warning' : 'info'} label={u.risk_tier || 'low'} /> },
    { header: 'Classification', key: 'classification', render: (u) => u.classification || '—' },
    {
      header: 'Tags',
      key: 'tags',
      render: (u) => (
        <div className="admin-tag-row">
          {(u.tags || []).slice(0, 3).map((tag) => <span key={tag} className="admin-tag-pill static">{tag}</span>)}
          {(u.tags || []).length > 3 && <span style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>+{u.tags.length - 3}</span>}
        </div>
      )
    },
    { header: 'Joined', key: 'joined', sortKey: 'created_at', render: (u) => new Date(u.created_at).toLocaleDateString() },
    { header: 'Status', key: 'status', render: (u) => u.is_banned ? <AdminBadge status="banned" /> : <AdminBadge status={u.lifecycle_stage || 'active'} label={u.lifecycle_stage || 'active'} /> }
  ]), []);

  const visibleColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));

  const getRowActions = (user) => {
    const allowedActions = new Set(Array.isArray(user.allowed_actions) ? user.allowed_actions : []);
    const actions = [
      { label: 'Preview', icon: 'info', onClick: () => handleAction('view', user) }
    ];

    if (isSuperAdmin && allowedActions.has('revoke_sessions')) {
      actions.push({ label: 'Revoke Sessions', icon: 'lock', onClick: () => handleAction('revoke_sessions', user) });
      actions.push({ label: 'Manual Account', icon: 'funded', onClick: () => handleAction('manual_account', user) });
    }

    if (allowedActions.has('unban')) {
      actions.push({ label: 'Unban User', icon: 'approve', onClick: () => handleAction('unban', user) });
    } else if (allowedActions.has('ban')) {
      actions.push({ label: 'Ban User', icon: 'reject', onClick: () => handleAction('ban', user), danger: true });
    }

    return actions;
  };

  const selectedRows = rows.filter((row) => selectedIds.includes(String(row.id)));
  const allSelected = rows.length > 0 && selectedIds.length === rows.length;
  const someSelected = selectedIds.length > 0 && selectedIds.length < rows.length;

  return (
    <PageWrapper>
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <h1 className="admin-h1">Trader Operations</h1>
            <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Classify, segment, and act on traders with reusable filters and saved views.</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '24px' }}>
          <AdminStatCard icon="users" label="Total Traders" value={summary.total || 0} />
          <AdminStatCard icon="kyc" label="Pending KYC" value={summary.pending_kyc || 0} />
          <AdminStatCard icon="funded" label="Funded Traders" value={summary.funded_traders || 0} />
          <AdminStatCard icon="warning" label="Needs Attention" value={summary.needs_attention || 0} />
        </div>

        <AdminFilterBar searchPlaceholder="Search via email, name, country, referral, or UID..." searchValue={search} onSearchChange={setSearch}>
          {['all', 'approved', 'pending', 'rejected'].map((status) => (
            <button
              key={status}
              className={`admin-filter-chip ${filters.kycStatus === status ? 'active' : ''}`}
              onClick={() => setFilters((current) => ({ ...current, kycStatus: status }))}
            >
              {status === 'all' ? 'All KYC' : status}
            </button>
          ))}
          <select className="admin-select" style={{ width: '160px' }} value={filters.bannedState} onChange={(event) => setFilters((current) => ({ ...current, bannedState: event.target.value }))}>
            <option value="all">All status</option>
            <option value="active">Active only</option>
            <option value="banned">Banned only</option>
          </select>
          <select className="admin-select" style={{ width: '160px' }} value={filters.riskTier} onChange={(event) => setFilters((current) => ({ ...current, riskTier: event.target.value }))}>
            <option value="all">All risk tiers</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <button
            className={`admin-filter-chip ${filters.fundedOnly ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, fundedOnly: !current.fundedOnly }))}
          >
            Funded Only
          </button>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="traders"
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
          onExport={() => exportAdminResource(adminAxios, 'traders', {
            search,
            sort: sort.key,
            order: sort.direction,
            filters: {
              kyc_status: filters.kycStatus !== 'all' ? filters.kycStatus : null,
              is_banned: filters.bannedState === 'all' ? null : filters.bannedState === 'banned',
              funded_only: filters.fundedOnly ? true : null,
              risk_tier: filters.riskTier !== 'all' ? filters.riskTier : null
            }
          })}
          selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
          extraActions={selectedIds.length > 0 ? (
            <button className="admin-btn admin-btn-ghost" onClick={applyTagToSelection}>
              Tag Selected
            </button>
          ) : null}
        />

        <div className="admin-card" style={{ padding: 0 }}>
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
              onToggleAll: () => {
                setSelectedIds(allSelected ? [] : rows.map((row) => String(row.id)));
              }
            }}
          />
        </div>

        <AdminEntityDrawer
          open={!!drawerRow}
          entityType="user"
          row={drawerRow}
          title={drawerRow ? (drawerRow.full_name || drawerRow.email || `Trader ${drawerRow.id}`) : ''}
          adminAxios={adminAxios}
          onClose={() => setDrawerRow(null)}
          onRefresh={() => fetchUsers({ silent: true })}
          quickActions={drawerRow ? [
            { label: 'View Trades', onClick: () => navigate(`/admin/trades?q=${encodeURIComponent(drawerRow.id)}`) },
            ...(Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('revoke_sessions') ? [
              { label: 'Revoke Sessions', onClick: () => handleAction('revoke_sessions', drawerRow) }
            ] : []),
            ...(Array.isArray(drawerRow.allowed_actions) && drawerRow.allowed_actions.includes('manual_account') ? [
              { label: 'Manual Account', onClick: () => handleAction('manual_account', drawerRow) }
            ] : [])
          ] : []}
        />
      </>
    </PageWrapper>
  );
}
