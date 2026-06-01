import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource } from '../../utils/adminList';

const DEFAULT_FILTERS = {
  visibility: 'all'
};

const ALL_COLUMN_KEYS = ['rank', 'trader', 'country', 'account', 'profitUsd', 'profitPct', 'winRate', 'trades', 'visible'];

function buildViewConfig({ search, filters, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    columns: visibleColumnKeys,
    density
  };
}

function formatMoney(value) {
  return `$${(parseFloat(value || 0) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export default function AdminLeaderboard() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [traders, setTraders] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedIds, setSelectedIds] = useState([]);
  const [drawerRow, setDrawerRow] = useState(null);
  const [savingIds, setSavingIds] = useState({});
  const [bulkSaving, setBulkSaving] = useState(false);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'leaderboard' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchLeaderboard = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/leaderboard').catch(() => ({ data: [] }));
      const rows = Array.isArray(res.data) ? res.data : [];
      setTraders(rows.map((row) => ({
        ...row,
        id: row.user_id || row.id,
        full_name: row.full_name || row.username || row.display_name || 'Anonymous',
        email: row.email || '',
        user_email: row.email || '',
        visible: row.visible !== false
      })));
      setSelectedIds((current) => current.filter((id) => rows.some((row) => String(row.user_id || row.id) === id)));
    } catch {
      toast.error('Failed to load leaderboard');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchLeaderboard();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredTraders = useMemo(() => traders.filter((trader) => {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        trader.rank,
        trader.email,
        trader.full_name,
        trader.country,
        trader.trader_uid,
        trader.account_uid
      ].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (filters.visibility === 'visible' && trader.visible === false) return false;
    if (filters.visibility === 'hidden' && trader.visible !== false) return false;
    return true;
  }), [filters.visibility, search, traders]);

  const summary = useMemo(() => ({
    total: filteredTraders.length,
    visible: filteredTraders.filter((trader) => trader.visible !== false).length,
    hidden: filteredTraders.filter((trader) => trader.visible === false).length,
    avgWinRate: filteredTraders.length > 0
      ? filteredTraders.reduce((sum, trader) => sum + (parseFloat(trader.win_rate || 0) || 0), 0) / filteredTraders.length
      : 0
  }), [filteredTraders]);

  const saveView = async () => {
    const name = window.prompt('Name this leaderboard view', 'Public Traders');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'leaderboard',
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

  const toggleRowSelection = (row) => {
    const nextId = String(row.id);
    setSelectedIds((current) => (
      current.includes(nextId)
        ? current.filter((id) => id !== nextId)
        : [...current, nextId]
    ));
  };

  const toggleAllSelection = () => {
    const visibleIds = filteredTraders.map((row) => String(row.id));
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? [] : visibleIds);
  };

  const setTraderVisibility = async (traderIds, visible) => {
    if (traderIds.length === 0) return;
    if (traderIds.length === 1) {
      setSavingIds((current) => ({ ...current, [traderIds[0]]: true }));
    } else {
      setBulkSaving(true);
    }

    try {
      await Promise.all(traderIds.map((traderId) => (
        adminAxios.post('/api/admin/leaderboard/visibility', {
          userId: traderId,
          visible
        })
      )));
      toast.success(`${visible ? 'Showed' : 'Hid'} ${traderIds.length} trader${traderIds.length === 1 ? '' : 's'} on the leaderboard`);
      await fetchLeaderboard({ silent: true });
    } catch {
      toast.error('Failed to update leaderboard visibility');
    } finally {
      if (traderIds.length === 1) {
        setSavingIds((current) => ({ ...current, [traderIds[0]]: false }));
      } else {
        setBulkSaving(false);
      }
    }
  };

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'leaderboard', {
        search,
        filters: {
          visible: filters.visibility !== 'all' ? filters.visibility : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export leaderboard');
    }
  };

  const columns = useMemo(() => {
    const allColumns = [
      {
        header: 'Rank',
        key: 'rank',
        render: (trader) => {
          const rank = trader.rank || 0;
          return (
            <span className="admin-td-mono" style={{ fontWeight: 700 }}>
              #{rank}
            </span>
          );
        }
      },
      {
        header: 'Trader',
        key: 'trader',
        render: (trader) => (
          <div>
            <div style={{ color: 'var(--admin-text)', fontWeight: 600 }}>{trader.full_name || 'Anonymous'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>{trader.email || 'No email'}</div>
          </div>
        )
      },
      {
        header: 'Country',
        key: 'country',
        render: (trader) => trader.country || 'N/A'
      },
      {
        header: 'Account',
        key: 'account',
        render: (trader) => (
          <div>
            <div className="admin-td-mono">{trader.account_uid || 'N/A'}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>
              {formatMoney(trader.account_size)}
            </div>
          </div>
        )
      },
      {
        header: 'Profit USD',
        key: 'profitUsd',
        isMono: true,
        render: (trader) => (
          <span style={{ color: 'var(--admin-success)', fontWeight: 700 }}>
            {formatMoney(trader.profit_usd)}
          </span>
        )
      },
      {
        header: 'Profit %',
        key: 'profitPct',
        isMono: true,
        render: (trader) => (
          <span style={{ color: 'var(--admin-success)', fontWeight: 700 }}>
            +{parseFloat(trader.profit_pct || 0).toFixed(2)}%
          </span>
        )
      },
      {
        header: 'Win Rate',
        key: 'winRate',
        isMono: true,
        render: (trader) => `${parseFloat(trader.win_rate || 0).toFixed(1)}%`
      },
      {
        header: 'Trades',
        key: 'trades',
        isMono: true,
        render: (trader) => (parseInt(trader.total_trades || 0, 10) || 0).toLocaleString()
      },
      {
        header: 'Visible',
        key: 'visible',
        render: (trader) => (
          <AdminBadge
            status={trader.visible !== false ? 'success' : 'warning'}
            label={trader.visible !== false ? 'VISIBLE' : 'HIDDEN'}
          />
        )
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));
  const selectedRows = filteredTraders.filter((trader) => selectedIds.includes(String(trader.id)));

  const rowActions = (trader) => {
    const isSaving = !!savingIds[String(trader.id)];
    return [
      {
        label: trader.visible !== false ? 'Hide Trader' : 'Show Trader',
        icon: trader.visible !== false ? 'hide' : 'show',
        onClick: () => setTraderVisibility([trader.id], trader.visible === false),
        disabled: isSaving
      }
    ];
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Leaderboard Management</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Curate which funded traders appear on the public leaderboard and review the top visible performers.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '24px' }}>
        <AdminStatCard icon="RANK" label="Ranked Traders" value={summary.total.toLocaleString()} />
        <AdminStatCard icon="SHOW" label="Visible" value={summary.visible.toLocaleString()} />
        <AdminStatCard icon="HIDE" label="Hidden" value={summary.hidden.toLocaleString()} />
        <AdminStatCard icon="WR" label="Avg Win Rate" value={`${summary.avgWinRate.toFixed(1)}%`} />
      </div>

      <div className="admin-card" style={{ marginBottom: '20px' }}>
        <AdminFilterBar
          searchPlaceholder="Search by trader, email, country, or account UID"
          searchValue={search}
          onSearchChange={setSearch}
        >
          <select className="admin-select" value={filters.visibility} onChange={(event) => setFilters((current) => ({ ...current, visibility: event.target.value }))}>
            <option value="all">All visibility states</option>
            <option value="visible">Visible only</option>
            <option value="hidden">Hidden only</option>
          </select>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="leaderboard"
          views={views}
          activeViewId={activeViewId}
          onSelectView={selectView}
          onSaveView={saveView}
          onUpdateView={currentView ? () => updateView(currentView) : undefined}
          onDeleteView={currentView ? () => deleteView(currentView) : undefined}
          density={density}
          onDensityChange={setDensity}
          columns={columns}
          visibleColumnKeys={visibleColumnKeys}
          onToggleColumn={toggleColumn}
          onExport={exportCurrentView}
          selectionLabel={selectedIds.length > 0 ? `${selectedIds.length} selected` : ''}
          extraActions={(
            <>
              <button
                className="admin-btn admin-btn-ghost"
                disabled={selectedIds.length === 0 || bulkSaving}
                onClick={() => setTraderVisibility(selectedIds, true)}
              >
                Show Selected
              </button>
              <button
                className="admin-btn admin-btn-ghost"
                disabled={selectedIds.length === 0 || bulkSaving}
                onClick={() => setTraderVisibility(selectedIds, false)}
              >
                Hide Selected
              </button>
            </>
          )}
        />
      </div>

      <div className="admin-card" style={{ padding: 0 }}>
        <AdminDataTable
          columns={columns}
          data={filteredTraders}
          loading={loading}
          emptyMessage="No leaderboard traders match this view"
          emptyIcon="trophy"
          rowActions={rowActions}
          density={density}
          onRowClick={(row) => setDrawerRow(row)}
          selection={{
            selectedIds,
            allSelected: filteredTraders.length > 0 && filteredTraders.every((row) => selectedIds.includes(String(row.id))),
            someSelected: filteredTraders.some((row) => selectedIds.includes(String(row.id))),
            onToggleAll: toggleAllSelection,
            onToggleRow: toggleRowSelection
          }}
          pagination={{ current: 1, total: 1, total_items: filteredTraders.length, page_size: filteredTraders.length || 1 }}
          onPageChange={() => {}}
        />
      </div>

      <AdminEntityDrawer
        open={!!drawerRow}
        entityType="trader"
        row={drawerRow}
        title={drawerRow ? `${drawerRow.full_name || 'Trader'} leaderboard profile` : ''}
        adminAxios={adminAxios}
        onClose={() => setDrawerRow(null)}
        onRefresh={() => fetchLeaderboard({ silent: true })}
        quickActions={drawerRow ? [
          {
            label: drawerRow.visible !== false ? 'Hide Trader' : 'Show Trader',
            onClick: () => setTraderVisibility([drawerRow.id], drawerRow.visible === false)
          }
        ] : []}
      />
    </>
  );
}
