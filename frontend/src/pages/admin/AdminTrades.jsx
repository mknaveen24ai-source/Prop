import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminModal from '../../components/admin/AdminModal';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminStatGrid from '../../components/admin/AdminStatGrid';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';

const DEFAULT_FILTERS = {
  direction: 'all',
  status: 'all'
};

const ALL_COLUMN_KEYS = ['id', 'account', 'symbol', 'direction', 'lots', 'prices', 'sltp', 'pnl', 'r_multiple', 'status', 'opened'];

function buildViewConfig({ search, filters, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    columns: visibleColumnKeys,
    density
  };
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '-';
  return value;
}

function formatTimestamp(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

export default function AdminTrades() {
  const { adminAxios, socket } = useOutletContext();
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [listData, setListData] = useState({
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 }
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState(searchParams.get('account') || searchParams.get('q') || '');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [selectedTrade, setSelectedTrade] = useState(null);
  const [showOverrideModal, setShowOverrideModal] = useState(false);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'trades' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  // FIX (AUDIT): mirrors AdminUsers.jsx's pageOverride pattern — the debounced
  // search/filter effect below calls setPage(1) then fetchTrades({silent:true}),
  // but fetchTrades would otherwise close over the pre-update `page`.
  const fetchTrades = async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/trades', {
        params: {
          page: effectivePage,
          page_size: 25,
          search,
          direction: filters.direction !== 'all' ? filters.direction : undefined,
          status: filters.status !== 'all' ? filters.status : undefined
        }
      });
      setListData(normalizeAdminListResponse(res.data));
    } catch {
      toast.error('Failed to load global executions');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrades();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  useEffect(() => {
    const nextSearch = searchParams.get('account') || searchParams.get('q') || '';
    setSearch(nextSearch);
  }, [searchParams]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      setPage(1);
      fetchTrades({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  useEffect(() => {
    if (!socket) return undefined;
    const refresh = () => fetchTrades({ silent: true });
    socket.on('admin_enforcement_event', refresh);
    socket.on('admin_command_center_updated', refresh);
    return () => {
      socket.off('admin_enforcement_event', refresh);
      socket.off('admin_command_center_updated', refresh);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, page, search, filters]);

  const trades = listData.rows || [];
  const pagination = listData.pagination || { current: 1, total: 1 };

  const executeForceClose = async () => {
    if (!selectedTrade) return;
    try {
      await adminAxios.post(`/api/admin/trades/${selectedTrade.id}/close`);
      toast.success(`Trade ${selectedTrade.id} force closed`);
      setShowOverrideModal(false);
      fetchTrades({ silent: true });
    } catch {
      toast.error('Failed to force close trade');
    }
  };

  const handleTradeAction = (trade) => {
    setSelectedTrade(trade);
    setShowOverrideModal(true);
  };

  const saveView = async () => {
    const name = window.prompt('Name this trade view', 'Open EURUSD Exposure');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'trades',
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

  const exportCurrentView = async () => {
    try {
      await exportAdminResource(adminAxios, 'trades', {
        search,
        filters: {
          direction: filters.direction !== 'all' ? filters.direction : null,
          status: filters.status !== 'all' ? filters.status : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export trades');
    }
  };

  // Filtering (search/direction/status) and the summary breakdown are now done
  // server-side (see GET /api/admin/trades) so pagination reflects the real
  // filtered total instead of slicing an unbounded, fully-loaded array.
  const filteredTrades = trades;
  const summary = listData.summary || { total: 0, open: 0, pending: 0, closed: 0 };

  const columns = useMemo(() => {
    const allColumns = [
      { header: 'Trade ID', key: 'id', isMono: true, render: (trade) => `#${String(trade.id).padStart(6, '0')}` },
      {
        header: 'Account / Trader',
        key: 'account',
        render: (trade) => (
          <div>
            <div style={{ color: 'var(--admin-text)' }}>Acc #{trade.account_id}</div>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '11px' }}>Trader #{trade.user_id}</div>
          </div>
        )
      },
      { header: 'Instrument', key: 'symbol', render: (trade) => <span style={{ fontWeight: 600 }}>{trade.symbol}</span> },
      {
        header: 'Direction',
        key: 'direction',
        render: (trade) => (
          trade.type === 'BUY'
            ? <AdminBadge status="active" label="BUY" />
            : <AdminBadge status="danger" label="SELL" outline />
        )
      },
      { header: 'Lots', key: 'lots', isMono: true, render: (trade) => parseFloat(trade.lots || 0).toFixed(2) },
      {
        header: 'Open / Close Price',
        key: 'prices',
        isMono: true,
        render: (trade) => (
          <div>
            <div>{formatPrice(trade.open_price)}</div>
            <div style={{ color: 'var(--admin-text-muted)' }}>{formatPrice(trade.close_price)}</div>
          </div>
        )
      },
      {
        header: 'SL / TP',
        key: 'sltp',
        isMono: true,
        render: (trade) => (
          <div>
            <div style={{ color: 'var(--admin-danger)' }}>{formatPrice(trade.sl)}</div>
            <div style={{ color: 'var(--admin-success)' }}>{formatPrice(trade.tp)}</div>
          </div>
        )
      },
      {
        header: 'P&L',
        key: 'pnl',
        isMono: true,
        render: (trade) => {
          const pnl = parseFloat(trade.pnl) || 0;
          return (
            <span style={{ color: pnl >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)', fontWeight: 700 }}>
              {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
            </span>
          );
        }
      },
      {
        header: 'R-Multiple',
        key: 'r_multiple',
        isMono: true,
        render: (trade) => {
          if (trade.r_multiple == null) return <span style={{ color: 'var(--admin-text-faint)' }}>—</span>;
          const r = parseFloat(trade.r_multiple);
          return (
            <span style={{ color: r >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
              {r >= 0 ? '+' : ''}{r.toFixed(2)}R
            </span>
          );
        }
      },
      {
        header: 'Status',
        key: 'status',
        render: (trade) => <AdminBadge status={trade.status === 'open' ? 'info' : trade.status === 'pending' ? 'warning' : 'neutral'} label={trade.status} />
      },
      {
        header: 'Opened',
        key: 'opened',
        render: (trade) => formatTimestamp(trade.open_time)
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));

  const rowActions = (trade) => {
    const actions = [
      { label: 'View Details', icon: 'info', onClick: () => handleTradeAction(trade) }
    ];
    if (trade.status === 'open') {
      actions.push({ label: 'Force Close Trade', icon: 'warning', onClick: () => handleTradeAction(trade), danger: true });
    }
    return actions;
  };

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">All Executions</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Monitor live market exposure, pending flow, and execution history from one global trade queue.
          </p>
        </div>
      </div>

      <AdminStatGrid>
        <AdminStatCard icon="trades" label="Visible Trades" value={summary.total} />
        <AdminStatCard icon="activity" label="Open" value={summary.open} />
        <AdminStatCard icon="history" label="Pending" value={summary.pending} />
        <AdminStatCard icon="approve" label="Closed" value={summary.closed} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search by trade ID, account, trader, or symbol..." searchValue={search} onSearchChange={setSearch}>
        {['all', 'buy', 'sell'].map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${filters.direction === value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, direction: value }))}
          >
            {value === 'all' ? 'All Directions' : value.toUpperCase()}
          </button>
        ))}
        {['all', 'open', 'pending', 'closed'].map((value) => (
          <button
            key={value}
            className={`admin-filter-chip ${filters.status === value ? 'active' : ''}`}
            onClick={() => setFilters((current) => ({ ...current, status: value }))}
          >
            {value === 'all' ? 'All Statuses' : value.toUpperCase()}
          </button>
        ))}
      </AdminFilterBar>

      <AdminListToolbar
        resourceLabel="trades"
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
      />

      <Card flush>
        <AdminDataTable
          columns={columns}
          data={filteredTrades}
          loading={loading}
          rowActions={rowActions}
          pagination={pagination}
          onPageChange={setPage}
          density={density}
          onRowClick={(trade) => handleTradeAction(trade)}
        />
      </Card>

      <AdminModal
        isOpen={showOverrideModal}
        onClose={() => setShowOverrideModal(false)}
        title={`Trade Ticket: #${String(selectedTrade?.id || '').padStart(6, '0')}`}
        size="md"
        footer={(
          <>
            <button className="admin-btn admin-btn-ghost" onClick={() => setShowOverrideModal(false)}>Close</button>
          </>
        )}
      >
        {selectedTrade && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '24px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Instrument</div>
                <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--admin-text)' }}>{selectedTrade.symbol}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase' }}>Direction And Size</div>
                <div style={{ fontSize: '18px', fontWeight: 600, color: selectedTrade.type === 'BUY' ? 'var(--admin-info)' : 'var(--admin-danger)' }}>
                  {selectedTrade.type} <span style={{ color: 'var(--admin-text)' }}>{selectedTrade.lots} Lot</span>
                </div>
              </div>
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--admin-danger)' }}>Stop Loss</div>
                <div style={{ fontSize: '16px', fontFamily: 'var(--admin-font-mono)' }}>{formatPrice(selectedTrade.sl)}</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', textTransform: 'uppercase', color: 'var(--admin-success)' }}>Take Profit</div>
                <div style={{ fontSize: '16px', fontFamily: 'var(--admin-font-mono)' }}>{formatPrice(selectedTrade.tp)}</div>
              </div>
            </div>

            <div style={{ background: 'var(--admin-surface)', border: '1px solid var(--admin-border)', padding: '16px', marginBottom: '24px', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', marginBottom: '4px' }}>Net Floating P&L</div>
              <div style={{ fontSize: '32px', fontFamily: 'var(--admin-font-mono)', fontWeight: 700, color: (parseFloat(selectedTrade.pnl) || 0) >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)' }}>
                {(parseFloat(selectedTrade.pnl) || 0) >= 0 ? '+' : ''}${(parseFloat(selectedTrade.pnl) || 0).toFixed(2)}
              </div>
            </div>

            {selectedTrade.status === 'open' && (
              <div style={{ background: 'color-mix(in srgb, var(--admin-danger) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--admin-danger) 20%, transparent)', padding: '16px' }}>
                <p style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
                  As an administrator, you may forcibly close this active market execution. This action will realize the current floating P&L and cannot be reversed.
                </p>
                <button className="admin-btn admin-btn-danger" style={{ width: '100%' }} onClick={executeForceClose}>
                  Force Close Position
                </button>
              </div>
            )}
          </div>
        )}
      </AdminModal>
    </>
  );
}
