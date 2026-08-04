import React, { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminFilterBar from '../../../components/admin/AdminFilterBar';
import AdminBadge from '../../../components/admin/AdminBadge';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import Card from '../../../components/ui/Card';
import { pnlColor, downloadCsv } from './shared';

function formatHours(hours) {
  if (hours === null || hours === undefined) return 'N/A';
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function LogSection({ title, columns, csvColumns, csvFilename, rows, loading, emptyIcon }) {
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px', marginBottom: '12px' }}>
        <h2 className="admin-h2" style={{ margin: 0 }}>{title}</h2>
        <button className="admin-btn admin-btn-ghost" onClick={() => downloadCsv(csvFilename, rows, csvColumns)}>Export CSV</button>
      </div>
      <Card flush>
        <AdminDataTable columns={columns} data={rows} loading={loading} emptyMessage="No records in the selected range" emptyIcon={emptyIcon} />
      </Card>
    </>
  );
}

export default function ComplianceAuditTab({ dateRange }) {
  const { adminAxios } = useOutletContext();
  const [search, setSearch] = useState('');
  const [instrumentFilter, setInstrumentFilter] = useState('All');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        // TODO: GET /api/admin/analytics/compliance-audit?from=&to= (backend/routes/adminAnalytics.js)
        const res = await adminAxios.get('/api/admin/analytics/compliance-audit', {
          params: { from: dateRange?.from || undefined, to: dateRange?.to || undefined },
        });
        setData(res.data);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [adminAxios, dateRange?.from, dateRange?.to]);

  const tradeLog = data?.tradeLog || [];
  const violationHistory = data?.violationHistory || [];
  const payoutHistory = data?.payoutHistory || [];
  const accountActivity = data?.accountActivity || [];
  const suspiciousActivity = data?.suspiciousActivity || [];

  const matchesSearch = (id) => !search || String(id || '').toLowerCase().includes(search.toLowerCase());

  const instruments = useMemo(() => ['All', ...Array.from(new Set(tradeLog.map((t) => t.instrument)))], [tradeLog]);

  const filteredTradeLog = tradeLog.filter((t) => matchesSearch(t.trader) && (instrumentFilter === 'All' || t.instrument === instrumentFilter));
  const filteredViolationHistory = violationHistory.filter((v) => matchesSearch(v.userId));
  const filteredPayoutHistory = payoutHistory.filter((p) => matchesSearch(p.userId));
  const filteredAccountActivity = accountActivity.filter((a) => matchesSearch(a.actor));
  const filteredSuspiciousActivity = suspiciousActivity.filter((s) => matchesSearch(s.userId));

  const kycProcessingTime = data?.kycProcessingTime || { avgHours: null, decidedCount: 0 };
  const payoutMetrics = data?.payoutMetrics || { avgAmount: null, avgApprovalHours: null, paidCount: 0 };

  return (
    <>
      <AdminStatGrid minColumnWidth={200}>
        <AdminStatCard
          icon="kyc"
          label="Avg KYC Processing Time"
          value={formatHours(kycProcessingTime.avgHours)}
          trend={`${kycProcessingTime.decidedCount} decided`}
        />
        <AdminStatCard
          icon="payouts"
          label="Avg Payout Amount"
          value={payoutMetrics.avgAmount !== null ? `$${payoutMetrics.avgAmount.toLocaleString()}` : 'N/A'}
        />
        <AdminStatCard
          icon="timer"
          label="Avg Time To Approval"
          value={formatHours(payoutMetrics.avgApprovalHours)}
          trend={`${payoutMetrics.paidCount} paid`}
        />
      </AdminStatGrid>

      <AdminFilterBar searchPlaceholder="Search all logs by trader/user/actor..." searchValue={search} onSearchChange={setSearch}>
        {instruments.map((i) => (
          <button key={i} className={`admin-filter-chip ${instrumentFilter === i ? 'active' : ''}`} onClick={() => setInstrumentFilter(i)}>{i}</button>
        ))}
      </AdminFilterBar>

      <LogSection
        title="Trade Log & Full History"
        rows={filteredTradeLog}
        loading={loading}
        emptyIcon="trades"
        csvFilename="trade-log.csv"
        csvColumns={[
          { header: 'Trader', value: (r) => r.trader },
          { header: 'Instrument', value: (r) => r.instrument },
          { header: 'Direction', value: (r) => r.direction },
          { header: 'Lots', value: (r) => r.lots },
          { header: 'PnL', value: (r) => r.pnl },
          { header: 'Timestamp', value: (r) => r.timestamp },
        ]}
        columns={[
          { header: 'Trader', key: 'trader', isMono: true },
          { header: 'Instrument', key: 'instrument' },
          { header: 'Direction', render: (row) => <AdminBadge bracket status={row.direction === 'BUY' ? 'approved' : 'danger'} label={row.direction} /> },
          { header: 'Lots', key: 'lots', isMono: true },
          { header: 'PnL', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(row.pnl) }}>{row.pnl >= 0 ? '+' : ''}${row.pnl}</span> },
          { header: 'Timestamp', render: (row) => new Date(row.timestamp).toLocaleString(), isMono: true },
        ]}
      />

      <LogSection
        title="Rule Violation History"
        rows={filteredViolationHistory}
        loading={loading}
        emptyIcon="violations"
        csvFilename="violation-history.csv"
        csvColumns={[
          { header: 'User ID', value: (r) => r.userId },
          { header: 'Type', value: (r) => r.type },
          { header: 'Timestamp', value: (r) => r.timestamp },
          { header: 'Resolution', value: (r) => r.resolution },
        ]}
        columns={[
          { header: 'User ID', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{row.userId}</span> },
          { header: 'Violation Type', key: 'type' },
          { header: 'Timestamp', render: (row) => new Date(row.timestamp).toLocaleString(), isMono: true },
          { header: 'Resolution', render: (row) => <AdminBadge bracket status={row.resolution === 'resolved' ? 'approved' : row.resolution === 'Pending' ? 'warning' : 'neutral'} label={row.resolution} /> },
        ]}
      />

      <LogSection
        title="Payout History"
        rows={filteredPayoutHistory}
        loading={loading}
        emptyIcon="payouts"
        csvFilename="payout-history.csv"
        csvColumns={[
          { header: 'User ID', value: (r) => r.userId },
          { header: 'Amount', value: (r) => r.amount },
          { header: 'Payout Date', value: (r) => r.payoutDate },
          { header: 'Status', value: (r) => r.status },
          { header: 'Method', value: (r) => r.method },
        ]}
        columns={[
          { header: 'User ID', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{row.userId}</span> },
          { header: 'Amount', render: (row) => `$${row.amount.toLocaleString()}` },
          { header: 'Payout Date', render: (row) => row.payoutDate ? new Date(row.payoutDate).toLocaleDateString() : '—', isMono: true },
          { header: 'Status', render: (row) => <AdminBadge bracket status={row.status === 'paid' ? 'approved' : 'danger'} label={row.status} /> },
          { header: 'Method', key: 'method' },
        ]}
      />

      <LogSection
        title="Account Activity Log"
        rows={filteredAccountActivity}
        loading={loading}
        emptyIcon="key"
        csvFilename="account-activity.csv"
        csvColumns={[
          { header: 'Actor', value: (r) => r.actor },
          { header: 'Action Type', value: (r) => r.actionType },
          { header: 'Timestamp', value: (r) => r.timestamp },
          { header: 'Details', value: (r) => r.details },
        ]}
        columns={[
          { header: 'Actor', key: 'actor', isMono: true },
          { header: 'Action Type', key: 'actionType' },
          { header: 'Timestamp', render: (row) => new Date(row.timestamp).toLocaleString(), isMono: true },
          { header: 'Details', key: 'details' },
        ]}
      />

      <LogSection
        title="Suspicious Activity Flags (Resolved)"
        rows={filteredSuspiciousActivity}
        loading={loading}
        emptyIcon="dispute"
        csvFilename="suspicious-activity-history.csv"
        csvColumns={[
          { header: 'User ID', value: (r) => r.userId },
          { header: 'Flag Type', value: (r) => r.flagType },
          { header: 'Detected At', value: (r) => r.detectedAt },
          { header: 'Resolved At', value: (r) => r.resolvedAt },
          { header: 'Resolution', value: (r) => r.resolution },
        ]}
        columns={[
          { header: 'User ID', render: (row) => <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{row.userId}</span> },
          { header: 'Flag Type', key: 'flagType' },
          { header: 'Detected At', render: (row) => new Date(row.detectedAt).toLocaleString(), isMono: true },
          { header: 'Resolved At', render: (row) => row.resolvedAt ? new Date(row.resolvedAt).toLocaleString() : '—', isMono: true },
          { header: 'Resolution', key: 'resolution' },
        ]}
      />
    </>
  );
}
