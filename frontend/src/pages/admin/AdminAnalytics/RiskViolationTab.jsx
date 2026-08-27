import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { PieChart, Pie, Cell, Legend, Tooltip } from 'recharts';
import AdminChart, { chartThemeProps } from '../../../components/admin/AdminChart';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminFilterBar from '../../../components/admin/AdminFilterBar';
import AdminBadge from '../../../components/admin/AdminBadge';
import AdminModal from '../../../components/admin/AdminModal';
import Sparkline from './Sparkline';
import { pnlColor } from './shared';
import { getAdminStatusColor } from '../../../components/admin/adminStatusTone';
import Card from '../../../components/ui/Card';

function accountStatusBadgeProps(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'failed' || s === 'locked') return { status: 'danger', label: status };
  if (!status) return { status: 'neutral', label: 'No Account' };
  return { status: 'approved', label: status };
}

export default function RiskViolationTab() {
  const { adminAxios } = useOutletContext();
  const [typeFilter, setTypeFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [evidenceRow, setEvidenceRow] = useState(null);
  const [evidenceTrades, setEvidenceTrades] = useState([]);

  const [statusCounts, setStatusCounts] = useState({ clean: 0, warned: 0, breached: 0 });
  const [accounts, setAccounts] = useState([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [violations, setViolations] = useState([]);
  const [violationsLoading, setViolationsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setAccountsLoading(true);
      try {
        // Backed by GET /api/admin/analytics/risk-overview (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/risk-overview');
        setStatusCounts(res.data?.statusCounts || { clean: 0, warned: 0, breached: 0 });
        setAccounts(res.data?.accounts || []);
      } catch {
        setStatusCounts({ clean: 0, warned: 0, breached: 0 });
        setAccounts([]);
      } finally {
        setAccountsLoading(false);
      }
    })();
  }, [adminAxios]);

  useEffect(() => {
    (async () => {
      setViolationsLoading(true);
      try {
        // Reuses the same endpoint the Breach Appeals Queue (Support & Appeals
        // Center) uses — real admin_rule_violations rows, not a separate mock.
        const res = await adminAxios.get('/api/admin/violations');
        setViolations(Array.isArray(res.data) ? res.data : []);
      } catch {
        setViolations([]);
      } finally {
        setViolationsLoading(false);
      }
    })();
  }, [adminAxios]);

  const pieData = [
    { name: 'Clean', value: statusCounts.clean || 0, color: getAdminStatusColor('clean') },
    { name: 'Warned', value: statusCounts.warned || 0, color: getAdminStatusColor('warned') },
    { name: 'Breached', value: statusCounts.breached || 0, color: getAdminStatusColor('breached') },
  ];

  const violationTypes = useMemo(() => ['All', ...Array.from(new Set(violations.map((v) => v.violation_type)))], [violations]);

  const filteredViolations = violations.filter((v) => {
    if (typeFilter !== 'All' && v.violation_type !== typeFilter) return false;
    if (search && !String(v.user_id || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const openEvidence = async (row) => {
    setEvidenceRow(row);
    setEvidenceTrades([]);
    try {
      const res = await adminAxios.get(`/api/admin/violations/${row.id}/evidence`);
      setEvidenceTrades(res.data?.trades || []);
    } catch {
      setEvidenceTrades([]);
    }
  };

  const drawdownColumns = [
    { header: 'User ID', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{row.userId}</span> },
    { header: 'Current DD', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: row.currentDD >= row.maxAllowedDD ? 'var(--admin-danger)' : 'var(--admin-text)' }}>{row.currentDD}%</span> },
    { header: 'Max Allowed', render: (row) => `${row.maxAllowedDD}%` },
    { header: '14-Day Trend', render: (row) => <Sparkline data={row.ddTrend} dataKey="value" danger={row.currentDD >= row.maxAllowedDD} /> },
    { header: 'Status', render: (row) => <AdminBadge bracket status={row.status === 'Clean' ? 'approved' : row.status === 'Breached' ? 'danger' : 'warning'} label={row.status} /> },
  ];

  const violationColumns = [
    { header: 'User ID', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)' }}>{row.user_id}</span> },
    { header: 'Violation Type', key: 'violation_type' },
    { header: 'Timestamp', render: (row) => new Date(row.first_detected_at).toLocaleString(), isMono: true },
    { header: 'Account Status', render: (row) => { const b = accountStatusBadgeProps(row.account_status); return <AdminBadge bracket status={b.status} label={b.label} />; } },
    { header: 'Message', render: (row) => <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>{row.message}</span> },
  ];

  return (
    <>
      <AdminStatGrid minColumnWidth={180}>
        <AdminStatCard icon="badgeCheck" label="Clean Accounts" value={statusCounts.clean || 0} />
        <AdminStatCard icon="warning" label="Warned Accounts" value={statusCounts.warned || 0} />
        <AdminStatCard icon="violations" label="Breached Accounts" value={statusCounts.breached || 0} />
        <AdminStatCard icon="flag" label="Open Violations" value={violations.filter((v) => v.status === 'open').length} />
      </AdminStatGrid>

      <AdminChart title="Account Breach Status Overview" height={240}>
        <PieChart>
          <Tooltip {...chartThemeProps.tooltip} />
          <Legend wrapperStyle={{ fontSize: 'var(--fs-sm)' }} />
          <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={78} paddingAngle={4} dataKey="value" stroke="var(--admin-surface)" strokeWidth={2}>
            {pieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
          </Pie>
        </PieChart>
      </AdminChart>

      <h2 className="admin-h2" style={{ marginTop: 'var(--space-6)' }}>Daily Drawdown Tracking — Active Accounts</h2>
      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable columns={drawdownColumns} data={accounts} loading={accountsLoading} emptyMessage="No active accounts" emptyIcon="violations" />
      </Card>

      <h2 className="admin-h2">Violation Log</h2>
      <AdminFilterBar searchPlaceholder="Search by user ID..." searchValue={search} onSearchChange={setSearch}>
        {violationTypes.map((type) => (
          <button key={type} className={`admin-filter-chip ${typeFilter === type ? 'active' : ''}`} onClick={() => setTypeFilter(type)}>{type === 'All' ? 'All Types' : type}</button>
        ))}
      </AdminFilterBar>

      <Card flush style={{ marginBottom: 'var(--space-6)' }}>
        <AdminDataTable
          columns={violationColumns}
          data={filteredViolations}
          loading={violationsLoading}
          emptyMessage="No violations found"
          emptyIcon="violations"
          rowActions={(row) => [{ label: 'View Evidence', icon: 'file', onClick: () => openEvidence(row) }]}
        />
      </Card>

      <AdminModal isOpen={!!evidenceRow} onClose={() => setEvidenceRow(null)} title={evidenceRow ? `Violation #${evidenceRow.id} — ${evidenceRow.violation_type}` : ''} size="lg">
        {evidenceRow && (
          <div>
            <p style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text-muted)', marginBottom: 'var(--space-4)' }}>{evidenceRow.message}</p>
            <Card flush style={{ marginBottom: 'var(--space-6)' }}>
              <AdminDataTable
                columns={[
                  { header: 'Opened', render: (row) => new Date(row.open_time).toLocaleTimeString(), isMono: true },
                  { header: 'Instrument', key: 'instrument' },
                  { header: 'Direction', key: 'direction' },
                  { header: 'Lots', key: 'lot_size', isMono: true },
                  { header: 'PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(row.demo_pnl) }}>{Number(row.demo_pnl || 0).toFixed(2)}</span> },
                ]}
                data={evidenceTrades}
                emptyMessage="No trade data available for this account/window"
              />
            </Card>
          </div>
        )}
      </AdminModal>
    </>
  );
}
