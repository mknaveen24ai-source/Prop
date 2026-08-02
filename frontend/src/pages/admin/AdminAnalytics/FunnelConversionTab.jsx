import React, { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, LabelList } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';

function withDropoff(stages) {
  return stages.map((s, i, arr) => {
    const prev = i === 0 ? null : arr[i - 1].count;
    const dropoff = i === 0 || !prev ? null : Math.round((1 - s.count / prev) * 100);
    return {
      ...s,
      dropoff,
      label: dropoff === null ? s.count.toLocaleString() : `${s.count.toLocaleString()} (-${dropoff}%)`,
    };
  });
}

function FunnelChart({ title, data }) {
  return (
    <AdminChart title={title} height={Math.max(180, data.length * 70)}>
      <BarChart data={data} layout="vertical" margin={{ right: 90 }}>
        <CartesianGrid {...chartThemeProps.grid} horizontal={false} />
        <XAxis type="number" hide />
        <YAxis dataKey="stage" type="category" {...chartThemeProps.yAxis} width={130} />
        <Tooltip {...chartThemeProps.tooltip} formatter={(value) => value.toLocaleString()} />
        <Bar dataKey="count" barSize={34} name="Count">
          <LabelList dataKey="label" position="right" style={{ fill: 'var(--admin-text)', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
          {data.map((row) => (
            <Cell key={row.stage} fill={row.dropoff !== null && row.dropoff >= 50 ? 'var(--admin-danger)' : 'var(--admin-accent)'} />
          ))}
        </Bar>
      </BarChart>
    </AdminChart>
  );
}

function formatDays(value) {
  if (value == null) return '—';
  const days = Math.floor(value);
  const hours = Math.round((value - days) * 24);
  return `${days}d ${hours}h`;
}

export default function FunnelConversionTab() {
  const { adminAxios } = useOutletContext();
  const [acquisitionFunnel, setAcquisitionFunnel] = useState([]);
  const [challengeFunnel, setChallengeFunnel] = useState([]);
  const [phaseTiming, setPhaseTiming] = useState([]);
  const [conversionByTier, setConversionByTier] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/funnel (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/funnel');
        setAcquisitionFunnel(withDropoff(res.data?.acquisitionFunnel || []));
        setChallengeFunnel(withDropoff(res.data?.challengeFunnel || []));
        setPhaseTiming(res.data?.phaseTiming || []);
        setConversionByTier(res.data?.conversionByTier || []);
      } catch {
        setAcquisitionFunnel([]);
        setChallengeFunnel([]);
        setPhaseTiming([]);
        setConversionByTier([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios]);

  const timingColumns = [
    { header: 'Phase', key: 'phase' },
    { header: 'Avg Time to Pass', render: (row) => formatDays(row.avgDaysToPass), isMono: true },
    { header: 'Avg Time to Fail', render: (row) => formatDays(row.avgDaysToFail), isMono: true },
    { header: 'Retry Rate', render: (row) => `${row.retryRate}%` },
  ];

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: '16px', marginBottom: '24px' }}>
        <FunnelChart title="Acquisition Funnel — Visitors to Purchases" data={acquisitionFunnel} />
        <FunnelChart title="Challenge Funnel — Start to Funded" data={challengeFunnel} />
      </div>

      <h2 className="admin-h2">Time-to-Outcome & Retry Rate per Phase</h2>
      <div className="admin-card" style={{ padding: 0, marginBottom: '24px' }}>
        <AdminDataTable columns={timingColumns} data={phaseTiming} loading={loading} emptyMessage="No completed phases yet" emptyIcon="timer" />
      </div>

      <AdminChart title="Conversion Rate per Order Tier">
        <BarChart data={conversionByTier}>
          <CartesianGrid {...chartThemeProps.grid} />
          <XAxis dataKey="tier" {...chartThemeProps.xAxis} />
          <YAxis {...chartThemeProps.yAxis} unit="%" />
          <Tooltip {...chartThemeProps.tooltip} formatter={(value) => `${value}%`} />
          <Bar dataKey="conversionRate" fill="var(--admin-accent)" barSize={48} name="Conversion Rate %" />
        </BarChart>
      </AdminChart>
    </>
  );
}
