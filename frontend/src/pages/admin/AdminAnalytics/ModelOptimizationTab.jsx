import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { ScatterChart, Scatter, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';

export default function ModelOptimizationTab() {
  const { adminAxios } = useOutletContext();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/model-optimization (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/model-optimization');
        setData(res.data);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios]);

  const passRateVsPricing = data?.passRateVsPricing || [];
  const difficultyVsRevenue = data?.difficultyVsRevenue || [];
  const strictnessVsRetention = data?.strictnessVsRetention || [];
  const abTests = data?.abTests || [];
  const revenueBySegment = data?.revenueBySegment || [];
  const failurePatterns = data?.failurePatterns || [];

  const strictnessColumns = [
    { header: 'Rule Set', key: 'ruleSet' },
    { header: 'Strictness Score', key: 'strictness', isMono: true },
    { header: 'Avg Retention', render: (row) => `${row.avgRetentionDays}d` },
    { header: 'Retention Rate', render: (row) => `${row.retentionRate}%` },
  ];

  const abColumns = [
    { header: 'Variant', key: 'variant' },
    { header: 'Sample Size', key: 'sampleSize', isMono: true },
    { header: 'Outcome Metric', key: 'outcomeMetric' },
    { header: 'Result', key: 'resultValue', isMono: true },
    { header: 'Significance', render: (row) => row.significant == null ? <span style={{ color: 'var(--admin-text-faint)' }}>—</span> : <AdminBadge bracket status={row.significant ? 'approved' : 'neutral'} label={row.significant ? 'Significant' : 'Not Significant'} /> },
  ];

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <AdminChart title="Pass Rate vs Pricing">
          <ScatterChart>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis type="number" dataKey="price" name="Price" unit="$" {...chartThemeProps.xAxis} />
            <YAxis type="number" dataKey="passRate" name="Pass Rate" unit="%" {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter data={passRateVsPricing} fill="var(--admin-accent)" />
          </ScatterChart>
        </AdminChart>

        <AdminChart title="Difficulty vs Revenue per Model">
          <BarChart data={difficultyVsRevenue}>
            <CartesianGrid {...chartThemeProps.grid} />
            <XAxis dataKey="model" {...chartThemeProps.xAxis} />
            <YAxis yAxisId="left" {...chartThemeProps.yAxis} />
            <YAxis yAxisId="right" orientation="right" {...chartThemeProps.yAxis} />
            <Tooltip {...chartThemeProps.tooltip} />
            <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
            <Bar yAxisId="left" dataKey="difficulty" fill="var(--admin-text-faint)" name="Difficulty (derived)" barSize={28} />
            <Bar yAxisId="right" dataKey="revenue" fill="var(--admin-accent)" name="Revenue ($)" barSize={28} />
          </BarChart>
        </AdminChart>
      </div>

      <h2 className="admin-h2">Rule Strictness vs Retention</h2>
      <Card flush style={{ marginBottom: '24px' }}>
        <AdminDataTable columns={strictnessColumns} data={strictnessVsRetention} loading={loading} emptyMessage="No data" emptyIcon="challenges" />
      </Card>

      <h2 className="admin-h2">A/B Test Results</h2>
      <Card flush style={{ marginBottom: '24px' }}>
        <AdminDataTable columns={abColumns} data={abTests} loading={loading} emptyMessage="No experiments running yet — infrastructure is in place (ab_experiments/ab_experiment_events), waiting on a real experiment to be wired up" emptyIcon="challenges" />
      </Card>

      <AdminChart title="Revenue per Acquisition Segment">
        <BarChart data={revenueBySegment}>
          <CartesianGrid {...chartThemeProps.grid} />
          <XAxis dataKey="segment" {...chartThemeProps.xAxis} />
          <YAxis {...chartThemeProps.yAxis} />
          <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `$${value.toLocaleString()}`} />
          <Bar dataKey="revenue" fill="var(--admin-accent)" barSize={48} name="Revenue" />
        </BarChart>
      </AdminChart>

      <h2 className="admin-h2" style={{ marginTop: '24px' }}>Failure Pattern Analysis</h2>
      <Card style={{ marginBottom: '24px' }}>
        {failurePatterns.length === 0 ? (
          <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)' }}>No failed accounts yet.</p>
        ) : (
          <ol style={{ margin: 0, paddingLeft: '20px' }}>
            {failurePatterns.map((f) => (
              <li key={f.reason} style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--rule)', fontSize: 'var(--fs-base)' }}>
                <span>{f.reason}</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--admin-text-muted)' }}>{f.count}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
