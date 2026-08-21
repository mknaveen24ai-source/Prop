import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
  PieChart, Pie, Cell, Legend
} from 'recharts';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminChart, { chartThemeProps, renderActiveDonutArc, dimUnlessActive } from '../../components/admin/AdminChart';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminEntityDrawer from '../../components/admin/AdminEntityDrawer';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminStatGrid from '../../components/admin/AdminStatGrid';
import Card from '../../components/ui/Card';
import { useToast } from '../../components/admin/AdminToast';
import { exportAdminResource } from '../../utils/adminList';

const DEFAULT_FILTERS = {
  direction: 'all',
  edgeSide: 'all'
};

const ALL_COLUMN_KEYS = ['trade', 'symbol', 'direction', 'lots', 'traderPnl', 'platformPnl', 'fees', 'closedAt'];

function buildViewConfig({ search, filters, visibleColumnKeys, density }) {
  return {
    search,
    filters,
    columns: visibleColumnKeys,
    density
  };
}

function formatMoney(value) {
  const parsed = parseFloat(value || 0) || 0;
  return `$${parsed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  return new Date(value).toLocaleString();
}

export default function AdminPlatformPnL() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [bbook, setBbook] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [drawerRow, setDrawerRow] = useState(null);
  const [passFailActiveIndex, setPassFailActiveIndex] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [costActiveIndex, setCostActiveIndex] = useState(null);

  const fetchViews = async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'bbook' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  };

  const fetchData = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [overviewRes, bbookRes] = await Promise.all([
        adminAxios.get('/api/admin/overview').catch(() => ({ data: {} })),
        adminAxios.get('/api/admin/bbook').catch(() => ({ data: [] }))
      ]);
      setOverview(overviewRes.data || {});
      setBbook(Array.isArray(bbookRes.data) ? bbookRes.data : []);
    } catch {
      toast.error('Failed to load platform PnL data');
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    fetchViews();
    adminAxios.get('/api/admin/pnl-ledger').then((res) => setLedger(res.data)).catch(() => setLedger(null));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filteredTrades = useMemo(() => bbook.filter((row) => {
    const query = search.trim().toLowerCase();
    if (query) {
      const haystack = [
        row.id,
        row.symbol,
        row.type
      ].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }

    if (filters.direction !== 'all' && String(row.type || '').toLowerCase() !== filters.direction) return false;
    if (filters.edgeSide === 'positive' && parseFloat(row.platform_pnl || 0) < 0) return false;
    if (filters.edgeSide === 'negative' && parseFloat(row.platform_pnl || 0) >= 0) return false;
    return true;
  }), [bbook, filters.direction, filters.edgeSide, search]);

  const chartRows = filteredTrades.slice(0, 30).slice().reverse();
  const rollingData = chartRows.map((row, index) => ({
    label: row.closed_at
      ? new Date(row.closed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : `#${index + 1}`,
    edge: parseFloat(row.platform_pnl || 0),
    fees: parseFloat(row.fee_revenue || 0)
  }));

  const totalEdge = filteredTrades.reduce((sum, row) => sum + (parseFloat(row.platform_pnl || 0) || 0), 0);
  const totalFees = filteredTrades.reduce((sum, row) => sum + (parseFloat(row.fee_revenue || 0) || 0), 0);
  const winningTrades = filteredTrades.filter((row) => parseFloat(row.trader_pnl || 0) > 0).length;
  const winRate = filteredTrades.length > 0 ? `${((winningTrades / filteredTrades.length) * 100).toFixed(1)}%` : '-';
  const fundedAccounts = overview?.accounts?.funded || 0;
  const totalTraders = overview?.users?.total || 0;

  // Passed = accounts that cleared evaluation (passed + already-funded); Failed
  // = accounts that didn't make it (failed + expired); Active = still evaluating.
  const passFailData = useMemo(() => {
    const accounts = overview?.accounts || {};
    return [
      { name: 'Active', value: (accounts.phase1 || 0) + (accounts.phase2 || 0), color: 'var(--admin-info)' },
      { name: 'Passed', value: (accounts.passed || 0) + (accounts.funded || 0), color: 'var(--admin-success)' },
      { name: 'Failed', value: (accounts.failed || 0) + (accounts.expired || 0), color: 'var(--admin-danger)' }
    ].filter((item) => item.value > 0);
  }, [overview]);

  const saveView = async () => {
    const name = window.prompt('Name this platform PnL view', 'Positive Edge');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'bbook',
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
      await exportAdminResource(adminAxios, 'bbook', {
        search,
        filters: {
          direction: filters.direction !== 'all' ? filters.direction : null,
          edge_side: filters.edgeSide !== 'all' ? filters.edgeSide : null
        }
      });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not export platform PnL');
    }
  };

  const columns = useMemo(() => {
    const allColumns = [
      {
        header: 'Trade',
        key: 'trade',
        render: (row) => <span className="admin-td-mono">#{row.id}</span>
      },
      {
        header: 'Symbol',
        key: 'symbol',
        render: (row) => <span style={{ fontWeight: 600 }}>{row.symbol || 'N/A'}</span>
      },
      {
        header: 'Direction',
        key: 'direction',
        render: (row) => (
          <AdminBadge
            status={String(row.type || '').toUpperCase() === 'BUY' ? 'info' : 'danger'}
            label={String(row.type || 'N/A').toUpperCase()}
          />
        )
      },
      {
        header: 'Lots',
        key: 'lots',
        isMono: true,
        render: (row) => parseFloat(row.lots || 0).toFixed(2)
      },
      {
        header: 'Trader PnL',
        key: 'traderPnl',
        isMono: true,
        render: (row) => {
          const value = parseFloat(row.trader_pnl || 0) || 0;
          return (
            <span style={{ color: value >= 0 ? 'var(--admin-danger)' : 'var(--admin-success)' }}>
              {value >= 0 ? '+' : ''}{formatMoney(value).replace('$', '$')}
            </span>
          );
        }
      },
      {
        header: 'Platform Edge',
        key: 'platformPnl',
        isMono: true,
        render: (row) => {
          const value = parseFloat(row.platform_pnl || 0) || 0;
          return (
            <span style={{ color: value >= 0 ? 'var(--admin-success)' : 'var(--admin-danger)', fontWeight: 700 }}>
              {value >= 0 ? '+' : ''}{formatMoney(value).replace('$', '$')}
            </span>
          );
        }
      },
      {
        header: 'Fees',
        key: 'fees',
        isMono: true,
        render: (row) => formatMoney(row.fee_revenue)
      },
      {
        header: 'Closed At',
        key: 'closedAt',
        render: (row) => formatDateTime(row.closed_at)
      }
    ];

    return allColumns.filter((column) => visibleColumnKeys.includes(column.key));
  }, [visibleColumnKeys]);

  const currentView = views.find((view) => String(view.id) === String(activeViewId));

  if (loading) {
    return (
      <div style={{ padding: 'var(--space-8)' }}>
        <div className="admin-skeleton" style={{ height: '120px', marginBottom: 'var(--space-6)' }} />
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );
  }

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1 className="admin-h1">Platform P&amp;L</h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
          Review B-book edge, fee revenue, and recent funded-trade outcomes with saved views and export controls.
        </p>
      </div>

      <AdminStatGrid minColumnWidth={190}>
        <AdminStatCard icon="pnl" label="Filtered Edge" value={formatMoney(totalEdge)} trendDirection={totalEdge >= 0 ? 'up' : 'down'} />
        <AdminStatCard icon="payouts" label="Filtered Fees" value={formatMoney(totalFees)} trendDirection="up" />
        <AdminStatCard icon="trades" label="Trader Win Rate" value={winRate} />
        <AdminStatCard icon="history" label="Closed Trades" value={filteredTrades.length.toLocaleString()} />
        <AdminStatCard icon="users" label="Total Traders" value={totalTraders.toLocaleString()} />
        <AdminStatCard icon="funded" label="Funded Accounts" value={fundedAccounts.toLocaleString()} />
      </AdminStatGrid>

      {ledger && (
        <>
          <h2 className="admin-h2" style={{ margin: '28px 0 16px' }}>Firm Ledger</h2>
          <AdminStatGrid minColumnWidth={190} style={{ marginBottom: 'var(--space-5)' }}>
            <AdminStatCard icon="pnl" label="Gross Fees (90d)" value={formatMoney(ledger.gross_fees_90d)} />
            <AdminStatCard icon="payouts" label="Trader Payouts (90d)" value={formatMoney(ledger.cost_breakdown.find((b) => b.label === 'Trader Payouts')?.amount || 0)} />
            <AdminStatCard icon="affiliate" label="Affiliate Payouts (90d)" value={formatMoney(ledger.cost_breakdown.find((b) => b.label === 'Affiliate Payouts')?.amount || 0)} />
            <AdminStatCard icon="funded" label="Retained (90d)" value={formatMoney(ledger.cost_breakdown.find((b) => b.label === 'Retained')?.amount || 0)} trendDirection="up" />
          </AdminStatGrid>

          <Card ruled title="Fees In, Payouts Out" eyebrow="Net position · monthly" style={{ marginBottom: 'var(--space-6)' }}>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={ledger.monthly}>
                <CartesianGrid {...chartThemeProps.grid} />
                <XAxis dataKey="month" {...chartThemeProps.xAxis} />
                <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `$${Number(value).toLocaleString()}`} />
                <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
                <Bar dataKey="fees" fill="var(--gain)" name="Fees" radius={[3, 3, 0, 0]} />
                <Bar dataKey="payouts" fill="var(--loss)" name="Payouts" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: 'var(--space-4)', alignItems: 'start', marginBottom: 'var(--space-6)' }}>
            <Card title="Cumulative Net Revenue" eyebrow="After payouts · trailing 12 months">
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={ledger.monthly}>
                  <defs>
                    <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...chartThemeProps.grid} />
                  <XAxis dataKey="month" {...chartThemeProps.xAxis} />
                  <YAxis {...chartThemeProps.yAxis} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                  <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `$${Number(value).toLocaleString()}`} />
                  <ReferenceLine y={0} stroke="var(--admin-border-strong)" strokeDasharray="4 2" />
                  <Area type="monotone" dataKey="cumulative_net" stroke="var(--accent)" fill="url(#netGrad)" strokeWidth={2} name="Cumulative Net" />
                </AreaChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Where the Money Goes" eyebrow="Share of gross fees · trailing 90d">
              {ledger.cost_breakdown.length > 0 ? (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <PieChart>
                      <Pie
                        data={ledger.cost_breakdown}
                        dataKey="amount"
                        nameKey="label"
                        cx="50%"
                        cy="50%"
                        innerRadius={45}
                        outerRadius={68}
                        paddingAngle={4}
                        activeIndex={costActiveIndex}
                        activeShape={renderActiveDonutArc}
                        onMouseEnter={(_, index) => setCostActiveIndex(index)}
                        onMouseLeave={() => setCostActiveIndex(null)}
                      >
                        {ledger.cost_breakdown.map((entry, index) => (
                          <Cell
                            key={entry.label}
                            fill={[ 'var(--loss)', 'var(--warn)', 'var(--gain)' ][index % 3]}
                            fillOpacity={dimUnlessActive(costActiveIndex, index)}
                          />
                        ))}
                      </Pie>
                    </PieChart>
                  </ResponsiveContainer>
                  {ledger.cost_breakdown.map((b, index) => (
                    <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 0', borderBottom: '1px solid var(--rule-soft)' }}>
                      <span style={{ width: '9px', height: '9px', background: ['var(--loss)', 'var(--warn)', 'var(--gain)'][index % 3], flex: '0 0 auto' }} />
                      <span style={{ flex: 1, fontSize: '12.5px' }}>{b.label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>{formatMoney(b.amount)}</span>
                    </div>
                  ))}
                </>
              ) : (
                <div style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--admin-text-faint)' }}>No paid fees in the last 90 days</div>
              )}
            </Card>
          </div>

          <Card
            ruled flush title="Monthly Ledger"
            actions={(
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => {
                  const headers = ['Month', 'Fees', 'Payouts', 'Net', 'Cumulative Net'];
                  const rows = ledger.monthly.map((m) => [m.month, m.fees, m.payouts, m.net, m.cumulative_net]);
                  const csv = [headers, ...rows].map((r) => r.join(',')).join('\n');
                  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = `platform_pnl_ledger_${new Date().toISOString().slice(0, 10)}.csv`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  URL.revokeObjectURL(url);
                }}
              >
                Export ledger
              </button>
            )}
            style={{ marginBottom: 'var(--space-6)' }}
          >
            {/* .lx-table has a min-width floor below md; unwrapped it scrolls
                the page rather than itself. */}
            <div className="lx-table-wrap">
            <table className="lx-table">
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Fees</th>
                  <th>Payouts</th>
                  <th>Net</th>
                  <th>Cumulative Net</th>
                </tr>
              </thead>
              <tbody>
                {ledger.monthly.map((m) => (
                  <tr key={m.month + m.cumulative_net}>
                    <td>{m.month}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--gain)' }}>{formatMoney(m.fees)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: 'var(--loss)' }}>{formatMoney(m.payouts)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', color: m.net >= 0 ? 'var(--gain)' : 'var(--loss)' }}>{formatMoney(m.net)}</td>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>{formatMoney(m.cumulative_net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </Card>

          <h2 className="admin-h2" style={{ margin: '28px 0 16px' }}>B-Book Trading Edge</h2>
        </>
      )}

      <Card ruled title="Recent Platform Edge" style={{ marginBottom: 'var(--space-6)' }}>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={rollingData}>
            <defs>
              <linearGradient id="edgeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--admin-accent)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--admin-accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="label" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} tickFormatter={(value) => `$${value}`} />
            <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `$${Number(value || 0).toFixed(2)}`} />
            <ReferenceLine y={0} stroke="var(--admin-border-strong)" strokeDasharray="4 2" />
            <Area type="monotone" dataKey="edge" stroke="var(--admin-accent)" fill="url(#edgeGrad)" strokeWidth={2} name="B-Book Edge" />
            <Area type="monotone" dataKey="fees" stroke="var(--admin-gold)" fill="none" strokeWidth={2} name="Fee Revenue" strokeDasharray="5 3" />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <div style={{ marginBottom: 'var(--space-6)' }}>
        {passFailData.length > 0 ? (
          <AdminChart title="Pass / Fail Breakdown">
            <PieChart>
              <Tooltip {...chartThemeProps.tooltip} />
              <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
              <Pie
                data={passFailData}
                cx="50%"
                cy="50%"
                innerRadius={55}
                outerRadius={78}
                paddingAngle={4}
                dataKey="value"
                stroke="var(--admin-surface)"
                strokeWidth={2}
                activeIndex={passFailActiveIndex}
                activeShape={renderActiveDonutArc}
                onMouseEnter={(_, index) => setPassFailActiveIndex(index)}
                onMouseLeave={() => setPassFailActiveIndex(null)}
              >
                {passFailData.map((entry, index) => (
                  <Cell
                    key={entry.name || index}
                    fill={entry.color}
                    fillOpacity={dimUnlessActive(passFailActiveIndex, index)}
                    style={{ transition: 'fill-opacity 160ms ease' }}
                  />
                ))}
              </Pie>
            </PieChart>
          </AdminChart>
        ) : (
          <Card title="Pass / Fail Breakdown">
            <div style={{ height: '220px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--admin-text-faint)' }}>
              No account data yet
            </div>
          </Card>
        )}
      </div>

      <Card style={{ marginBottom: 'var(--space-5)' }}>
        <AdminFilterBar
          searchPlaceholder="Search by trade id or symbol"
          searchValue={search}
          onSearchChange={setSearch}
        >
          <select className="admin-select" value={filters.direction} onChange={(event) => setFilters((current) => ({ ...current, direction: event.target.value }))}>
            <option value="all">All directions</option>
            <option value="buy">Buy only</option>
            <option value="sell">Sell only</option>
          </select>
          <select className="admin-select" value={filters.edgeSide} onChange={(event) => setFilters((current) => ({ ...current, edgeSide: event.target.value }))}>
            <option value="all">All edge states</option>
            <option value="positive">Positive edge</option>
            <option value="negative">Negative edge</option>
          </select>
        </AdminFilterBar>

        <AdminListToolbar
          resourceLabel="platform PnL"
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
          extraActions={(
            <button className="admin-btn admin-btn-ghost" onClick={() => fetchData()}>
              Refresh
            </button>
          )}
        />
      </Card>

      <Card flush>
        <AdminDataTable
          columns={columns}
          data={filteredTrades}
          loading={loading}
          emptyMessage="No closed funded trades match this PnL view"
          emptyIcon="chart"
          density={density}
          onRowClick={(row) => setDrawerRow({
            ...row,
            status: 'closed',
            created_at: row.closed_at,
            updated_at: row.closed_at
          })}
          pagination={{ current: 1, total: 1, total_items: filteredTrades.length, page_size: filteredTrades.length || 1 }}
          onPageChange={() => {}}
        />
      </Card>

      <AdminEntityDrawer
        open={!!drawerRow}
        entityType="trade"
        row={drawerRow}
        title={drawerRow ? `Trade #${drawerRow.id} platform PnL` : ''}
        adminAxios={adminAxios}
        onClose={() => setDrawerRow(null)}
        onRefresh={() => fetchData({ silent: true })}
      />
    </>
  );
}
