import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminBadge from '../../../components/admin/AdminBadge';
import { pnlColor } from './shared';

const COPY_TRADING_THRESHOLD = 0.85;

function correlationCellStyle(value, isDiagonal) {
  if (isDiagonal) return { color: 'var(--admin-text-faint)' };
  if (value >= COPY_TRADING_THRESHOLD) {
    return { background: `color-mix(in srgb, var(--admin-danger) ${Math.round(value * 100)}%, transparent)`, color: 'var(--admin-text)', fontWeight: 700 };
  }
  if (value >= 0.4) {
    return { background: `color-mix(in srgb, var(--admin-warning) ${Math.round(value * 60)}%, transparent)` };
  }
  return {};
}

function CorrelationMatrix({ userIds, matrix, labelFor }) {
  if (userIds.length === 0) {
    return <p style={{ color: 'var(--admin-text-faint)', fontSize: '13px' }}>Not enough traders with overlapping trading days yet.</p>;
  }
  return (
    <div className="admin-card" style={{ overflowX: 'auto' }}>
      <table className="admin-table">
        <thead>
          <tr>
            <th className="admin-th"></th>
            {userIds.map((id) => (
              <th key={id} className="admin-th" style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{labelFor(id)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={userIds[i]}>
              <td className="admin-td admin-td-mono" style={{ fontWeight: 600 }}>{labelFor(userIds[i])}</td>
              {row.map((value, j) => (
                <td key={j} className="admin-td admin-td-mono" style={{ textAlign: 'center', ...correlationCellStyle(value, i === j) }}>
                  {value.toFixed(2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TradeBehaviorTab() {
  const { adminAxios } = useOutletContext();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/trade-behavior (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/trade-behavior');
        setData(res.data);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios]);

  const lotHistogram = data?.lotHistogram || [];
  const tradeFrequency = data?.tradeFrequency || [];
  const userIds = data?.userIds || [];
  const correlationMatrix = data?.correlationMatrix || [];
  const copyTradingFlags = data?.copyTradingFlags || [];
  const profitSpikes = data?.profitSpikes || [];
  const sessionTiming = data?.sessionTiming || [];

  const labelFor = (userId) => {
    const t = tradeFrequency.find((r) => r.userId === userId);
    return t?.email || t?.fullName || userId?.slice(0, 8) || '—';
  };

  const frequencyColumns = [
    { header: 'Trader', render: (row) => row.fullName || row.email, isMono: true },
    { header: 'Trades / Day', key: 'tradesPerDay', isMono: true },
    { header: 'Strategy', render: (row) => <AdminBadge bracket status="info" label={row.strategy} /> },
    { header: 'Overtrading Flag', render: (row) => row.overtrading ? <AdminBadge bracket status="danger" label="Overtrading" /> : <span style={{ color: 'var(--admin-text-faint)' }}>—</span> },
  ];

  const copyTradingColumns = [
    { header: 'Trader A', render: (row) => labelFor(row.userIdA), isMono: true },
    { header: 'Trader B', render: (row) => labelFor(row.userIdB), isMono: true },
    { header: 'Correlation', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-danger)', fontWeight: 700 }}>{row.correlation.toFixed(2)}</span> },
  ];

  const spikeColumns = [
    { header: 'Trader', render: (row) => labelFor(row.userId), isMono: true },
    { header: 'Instrument', key: 'instrument' },
    { header: 'Trade PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(row.tradePnl) }}>+${row.tradePnl}</span> },
    { header: 'Avg Historical PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)' }}>${row.avgHistoricalPnl}</span> },
    { header: 'Spike Multiple', render: (row) => `${(row.tradePnl / row.avgHistoricalPnl).toFixed(1)}x` },
    { header: 'Timestamp', render: (row) => new Date(row.timestamp).toLocaleString(), isMono: true },
  ];

  return (
    <>
      <AdminChart title="Lot Size Distribution">
        <BarChart data={lotHistogram}>
          <CartesianGrid {...chartThemeProps.grid} />
          <XAxis dataKey="bucket" {...chartThemeProps.xAxis} />
          <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
          <Tooltip {...chartThemeProps.tooltip} />
          <Bar dataKey="count" fill="var(--admin-accent)" barSize={40} name="Trades" />
        </BarChart>
      </AdminChart>

      <h2 className="admin-h2" style={{ marginTop: '24px' }}>Trade Frequency & Strategy Classification</h2>
      <div className="admin-card" style={{ padding: 0, marginBottom: '24px' }}>
        <AdminDataTable columns={frequencyColumns} data={tradeFrequency} loading={loading} emptyMessage="No trader data yet" emptyIcon="trade" />
      </div>

      <h2 className="admin-h2">Trader Correlation Matrix</h2>
      <p style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginBottom: '12px' }}>
        Cells at or above {COPY_TRADING_THRESHOLD.toFixed(2)} are flagged as a possible copy-trading signal. Requires at least 3 overlapping trading days between two traders.
      </p>
      <div style={{ marginBottom: '24px' }}>
        <CorrelationMatrix userIds={userIds} matrix={correlationMatrix} labelFor={labelFor} />
      </div>

      <h2 className="admin-h2">Copy-Trading Flags</h2>
      <div className="admin-card" style={{ padding: 0, marginBottom: '24px' }}>
        <AdminDataTable columns={copyTradingColumns} data={copyTradingFlags} loading={loading} emptyMessage="No flagged pairs" emptyIcon="dispute" />
      </div>

      <h2 className="admin-h2">Abnormal Profit Spike Detection</h2>
      <div className="admin-card" style={{ padding: 0, marginBottom: '24px' }}>
        <AdminDataTable columns={spikeColumns} data={profitSpikes} loading={loading} emptyMessage="No spikes detected" emptyIcon="pnl" />
      </div>

      <AdminChart title="Session Timing Pattern — Trade Volume by Hour (UTC)">
        <BarChart data={sessionTiming}>
          <CartesianGrid {...chartThemeProps.grid} />
          <XAxis dataKey="hour" {...chartThemeProps.xAxis} interval={2} />
          <YAxis {...chartThemeProps.yAxis} allowDecimals={false} />
          <Tooltip {...chartThemeProps.tooltip} />
          <Bar dataKey="volume" fill="var(--admin-accent)" barSize={12} name="Trade Volume" />
        </BarChart>
      </AdminChart>
    </>
  );
}
