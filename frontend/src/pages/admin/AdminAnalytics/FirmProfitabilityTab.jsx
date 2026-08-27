import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import Card from '../../../components/ui/Card';
import { pnlColor } from './shared';

function formatMoney(value) {
  return `$${Math.round(value || 0).toLocaleString()}`;
}

export default function FirmProfitabilityTab({ dateRange }) {
  const { adminAxios } = useOutletContext();
  const [operatingCost, setOperatingCost] = useState(0);
  const [totalFees, setTotalFees] = useState(0);
  const [totalPayouts, setTotalPayouts] = useState(0);
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // Backed by GET /api/admin/analytics/firm-profitability?from=&to= (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/firm-profitability', {
          params: { from: dateRange?.from || undefined, to: dateRange?.to || undefined },
        });
        setTotalFees(res.data?.totalFees || 0);
        setTotalPayouts(res.data?.totalPayouts || 0);
        setModels(res.data?.models || []);
      } catch {
        setTotalFees(0);
        setTotalPayouts(0);
        setModels([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios, dateRange?.from, dateRange?.to]);

  const netProfit = totalFees - totalPayouts - operatingCost;
  const payoutRatio = totalFees > 0 ? (totalPayouts / totalFees) * 100 : 0;

  const modelColumns = [
    { header: 'Model', key: 'model' },
    { header: 'Revenue', render: (row) => formatMoney(row.revenue) },
    { header: 'Pass Rate', render: (row) => `${row.passRate}%` },
    { header: 'Funded Traders', key: 'fundedCount', isMono: true },
    { header: 'Cost per Funded Trader', render: (row) => row.costPerFundedTrader == null ? <span style={{ color: 'var(--admin-text-faint)' }}>N/A — no cost ledger</span> : formatMoney(row.costPerFundedTrader) },
    { header: 'Avg Trader LTV', render: (row) => formatMoney(row.avgLtv) },
  ];

  return (
    <>
      <AdminStatGrid>
        <AdminStatCard icon="pnl" label="Net Profit" value={<span style={{ color: pnlColor(netProfit) }}>{formatMoney(netProfit)}</span>} />
        <AdminStatCard icon="analytics" label="Payout Ratio" value={`${payoutRatio.toFixed(1)}%`} />
        <AdminStatCard icon="balance" label="Total Fees" value={formatMoney(totalFees)} />
        <AdminStatCard icon="payouts" label="Total Payouts" value={formatMoney(totalPayouts)} />
      </AdminStatGrid>

      <Card style={{ marginBottom: 'var(--space-6)' }}>
        <div className="admin-form-group" style={{ maxWidth: '260px', marginBottom: 0 }}>
          <label className="admin-label">Operating Costs (for selected range)</label>
          <input
            type="number"
            className="admin-input"
            value={operatingCost}
            onChange={(e) => setOperatingCost(Number(e.target.value) || 0)}
          />
        </div>
      </Card>

      <AdminChart title="Pass Rate per Evaluation Model">
        <BarChart data={models}>
          <CartesianGrid {...chartThemeProps.grid} />
          <XAxis dataKey="model" {...chartThemeProps.xAxis} />
          <YAxis {...chartThemeProps.yAxis} unit="%" />
          <Tooltip {...chartThemeProps.tooltip} />
          <Bar dataKey="passRate" fill="var(--admin-accent)" barSize={48} name="Pass Rate %" />
        </BarChart>
      </AdminChart>

      <h2 className="admin-h2" style={{ marginTop: 'var(--space-6)' }}>Model Economics</h2>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable columns={modelColumns} data={models} loading={loading} emptyMessage="No model data" emptyIcon="pnl" />
      </Card>
    </>
  );
}
