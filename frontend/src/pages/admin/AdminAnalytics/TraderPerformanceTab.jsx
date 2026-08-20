import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminFilterBar from '../../../components/admin/AdminFilterBar';
import Card from '../../../components/ui/Card';
import { pnlColor } from './shared';

function average(list, key) {
  if (!list.length) return 0;
  return list.reduce((sum, item) => sum + item[key], 0) / list.length;
}

export default function TraderPerformanceTab() {
  const { adminAxios } = useOutletContext();
  const [traders, setTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState({ key: 'winRate', direction: 'desc' });
  const [selectedId, setSelectedId] = useState(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/trader-performance (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/trader-performance');
        const rows = res.data?.rows || [];
        setTraders(rows);
        if (rows.length > 0) setSelectedId(rows[0].traderId);
      } catch (err) {
        // no toast infra imported here yet — mirrors other tabs that fail silent-to-empty
        setTraders([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios]);

  const filtered = traders.filter((t) => `${t.traderId} ${t.email || ''} ${t.fullName || ''}`.toLowerCase().includes(search.toLowerCase()));

  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      const dir = sort.direction === 'asc' ? 1 : -1;
      return ((a[sort.key] ?? 0) - (b[sort.key] ?? 0)) * dir;
    });
    return list;
  }, [filtered, sort]);

  const onSortChange = (key) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const selected = traders.find((t) => t.traderId === selectedId) || null;

  const columns = [
    { header: 'Trader', render: (row) => row.fullName || row.email || row.traderId, isMono: true, sortKey: 'traderId' },
    { header: 'Trades', key: 'totalTrades', isMono: true, sortKey: 'totalTrades' },
    { header: 'Win Rate', render: (row) => `${row.winRate}%`, sortKey: 'winRate' },
    { header: 'Risk:Reward', render: (row) => row.riskReward.toFixed(1), sortKey: 'riskReward' },
    { header: 'Profit Factor', render: (row) => row.profitFactor.toFixed(2), sortKey: 'profitFactor' },
    { header: 'Consistency', render: (row) => row.consistency, sortKey: 'consistency' },
    { header: 'Max Win Streak', key: 'maxWinStreak', isMono: true, sortKey: 'maxWinStreak' },
    { header: 'Max Loss Streak', key: 'maxLossStreak', isMono: true, sortKey: 'maxLossStreak' },
    { header: 'Avg Duration', render: (row) => `${row.avgDurationMin}m`, sortKey: 'avgDurationMin' },
    {
      header: 'Avg Win / Avg Loss',
      render: (row) => (
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          <span style={{ color: pnlColor(row.avgWin) }}>+${row.avgWin}</span>
          {' / '}
          <span style={{ color: pnlColor(row.avgLoss) }}>${row.avgLoss}</span>
        </span>
      ),
    },
  ];

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="trade" label="Avg Win Rate" value={`${average(traders, 'winRate').toFixed(0)}%`} />
        <AdminStatCard icon="analytics" label="Avg Risk:Reward" value={average(traders, 'riskReward').toFixed(2)} />
        <AdminStatCard icon="pnl" label="Avg Profit Factor" value={average(traders, 'profitFactor').toFixed(2)} />
        <AdminStatCard icon="badgeCheck" label="Avg Consistency" value={average(traders, 'consistency').toFixed(0)} />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search by trader email or name..." searchValue={search} onSearchChange={setSearch} />

      <Card flush style={{ marginBottom: '24px' }}>
        <AdminDataTable
          columns={columns}
          data={sorted}
          loading={loading}
          sort={sort}
          onSortChange={onSortChange}
          onRowClick={(row) => setSelectedId(row.traderId)}
          emptyMessage="No closed trades yet — this firm has no trading activity recorded"
          emptyIcon="trade"
        />
      </Card>

      {selected && (
        <>
          <AdminChart title={`Equity Curve — ${selected.fullName || selected.email || selected.traderId}`}>
            <LineChart data={selected.equityCurve}>
              <CartesianGrid {...chartThemeProps.grid} />
              <XAxis dataKey="date" {...chartThemeProps.xAxis} tickFormatter={(v) => new Date(v).toLocaleDateString()} />
              <YAxis {...chartThemeProps.yAxis} />
              <Tooltip {...chartThemeProps.tooltip} labelFormatter={(v) => new Date(v).toLocaleString()} />
              <ReferenceLine y={0} stroke="var(--admin-border-strong)" strokeDasharray="3 3" />
              <Line type="monotone" dataKey="equity" stroke="var(--admin-accent)" strokeWidth={2} dot={false} />
            </LineChart>
          </AdminChart>

          <Card style={{ marginTop: '24px' }}>
            <h2 className="admin-h2">Full Stat Block — {selected.fullName || selected.email || selected.traderId}</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '16px' }}>
              {[
                ['Win Rate', `${selected.winRate}%`],
                ['Risk:Reward', selected.riskReward.toFixed(1)],
                ['Profit Factor', selected.profitFactor.toFixed(2)],
                ['Consistency Score', selected.consistency],
                ['Max Consecutive Wins', selected.maxWinStreak],
                ['Max Consecutive Losses', selected.maxLossStreak],
                ['Avg Trade Duration', `${selected.avgDurationMin}m`],
                ['Avg Win / Avg Loss', `+$${selected.avgWin} / $${selected.avgLoss}`],
              ].map(([label, value]) => (
                <div key={label}>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)', color: 'var(--admin-text)', marginTop: '4px' }}>{value}</div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}
