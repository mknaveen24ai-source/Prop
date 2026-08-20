import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import AdminChart, { chartThemeProps, dimUnlessActive, barHoverHandlers, renderStackedTotalLabel } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import { pnlColor } from './shared';

const POLL_INTERVAL_MS = 5000;

export default function RealTimeMonitoringTab() {
  const { adminAxios } = useOutletContext();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exposureActiveIndex, setExposureActiveIndex] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async (silent) => {
      if (!silent) setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/open-positions (backend/routes/adminAnalytics.js)
        // Polled every 5s per your call — no new socket-push infrastructure.
        const res = await adminAxios.get('/api/admin/analytics/open-positions');
        if (!cancelled) setData(res.data);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!silent) setLoading(false);
      }
    };
    fetchOnce(false);
    const interval = setInterval(() => fetchOnce(true), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [adminAxios]);

  const totalFloatingPnl = data?.totalFloatingPnl || 0;
  const openPositionsCount = data?.openPositionsCount || 0;
  const activeAccounts = data?.activeAccounts || 0;
  const idleAccounts = data?.idleAccounts || 0;
  const positions = data?.positions || [];
  const exposure = data?.exposure || [];
  const riskAlerts = data?.riskAlerts || [];

  const totalBuyLots = exposure.reduce((sum, e) => sum + e.buyLots, 0);
  const totalSellLots = exposure.reduce((sum, e) => sum + e.sellLots, 0);
  const totalLots = totalBuyLots + totalSellLots;
  const buyPct = totalLots > 0 ? Math.round((totalBuyLots / totalLots) * 100) : 50;

  const positionColumns = [
    { header: 'Trader', render: (row) => row.fullName || row.email, isMono: true },
    { header: 'Instrument', key: 'instrument' },
    { header: 'Direction', render: (row) => <AdminBadge bracket status={row.direction === 'BUY' ? 'approved' : 'danger'} label={row.direction} /> },
    { header: 'Lots', key: 'lots', isMono: true },
    { header: 'Entry Price', render: (row) => row.entryPrice.toFixed(row.instrument === 'XAUUSD' ? 2 : 4), isMono: true },
    { header: 'Floating PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(row.pnl) }}>{row.pnl >= 0 ? '+' : ''}${row.pnl}</span> },
  ];

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="pnl" label="Total Floating P&L" value={<span style={{ color: pnlColor(totalFloatingPnl) }}>{totalFloatingPnl >= 0 ? '+' : ''}${totalFloatingPnl}</span>} />
        <AdminStatCard icon="trades" label="Open Positions" value={openPositionsCount} />
        <AdminStatCard icon="users" label="Active Accounts" value={activeAccounts} />
        <AdminStatCard icon="profile" label="Idle Accounts" value={idleAccounts} />
      </AdminStatGrid>

      <h2 className="admin-h2">Open Positions — All Accounts</h2>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable columns={positionColumns} data={positions} loading={loading} emptyMessage="No open positions" emptyIcon="trades" />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
        <AdminChart title="Firm Exposure per Instrument (Lots)">
          <BarChart data={exposure} {...barHoverHandlers(setExposureActiveIndex)}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="instrument" {...chartThemeProps.xAxis} />
            <YAxis {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar dataKey="buyLots" stackId="lots" fill="var(--admin-success)" name="Buy Lots">
              {exposure.map((_, index) => (
                <Cell key={`buy-${index}`} fillOpacity={dimUnlessActive(exposureActiveIndex, index)} />
              ))}
            </Bar>
            <Bar
              dataKey="sellLots"
              stackId="lots"
              fill="var(--admin-danger)"
              name="Sell Lots"
              label={renderStackedTotalLabel(exposureActiveIndex, (i) => {
                const row = exposure[i];
                return row ? row.buyLots + row.sellLots : null;
              })}
            >
              {exposure.map((_, index) => (
                <Cell key={`sell-${index}`} fillOpacity={dimUnlessActive(exposureActiveIndex, index)} />
              ))}
            </Bar>
          </BarChart>
        </AdminChart>

        <Card style={{ marginBottom: 'var(--space-6)' }}>
          <h3 className="admin-h2" style={{ marginBottom: 'var(--space-4)' }}>Directional Bias</h3>
          <div style={{ display: 'flex', height: '28px', border: '1px solid var(--rule)' }}>
            <div style={{ width: `${buyPct}%`, background: 'var(--admin-success)' }} />
            <div style={{ width: `${100 - buyPct}%`, background: 'var(--admin-danger)' }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--space-2)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>
            <span style={{ color: 'var(--admin-success)' }}>BUY {buyPct}%</span>
            <span style={{ color: 'var(--admin-danger)' }}>SELL {100 - buyPct}%</span>
          </div>

          <h3 className="admin-h2" style={{ margin: '24px 0 12px' }}>Risk Concentration Alerts</h3>
          {riskAlerts.length === 0 ? (
            <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)' }}>No instrument exceeds the 30% concentration threshold.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 'var(--space-4-5)', fontSize: 'var(--fs-base)' }}>
              {riskAlerts.map((a) => (
                <li key={a.instrument} style={{ color: 'var(--admin-text)' }}>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{a.instrument}</span> holds {a.share}% of total firm exposure
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
