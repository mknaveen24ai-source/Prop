import React, { useMemo, useState } from 'react';
import AdminDataTable from '../../../components/admin/AdminDataTable';
import AdminStatCard from '../../../components/admin/AdminStatCard';
import AdminStatGrid from '../../../components/admin/AdminStatGrid';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import { useIntelligence, TabLoading, TabError, SectionNote, fmtNumber } from './shared';
import { downloadCsv } from '../AdminAnalytics/shared';

// Firm Intelligence → Catalogue.
//
// Rendered straight from the backend metric registry, so this page cannot drift
// from what the other tabs actually compute: if a metric is removed from a
// module, its entry here goes stale in an obvious way rather than quietly
// describing something that no longer exists.

export default function CatalogueTab({ adminAxios }) {
  const [search, setSearch] = useState('');
  const [pageFilter, setPageFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // The catalogue is static per deploy — no need to poll it.
  const { data, loading, error } = useIntelligence(adminAxios, '/api/admin/intelligence/catalogue', {
    intervalMs: 0
  });

  const filtered = useMemo(() => {
    if (!data?.metrics) return [];
    const term = search.trim().toLowerCase();
    return data.metrics.filter((m) => {
      if (pageFilter !== 'all' && m.page !== pageFilter) return false;
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (!term) return true;
      return [m.id, m.name, m.definition, m.tab, ...(m.tables || [])]
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [data, search, pageFilter, statusFilter]);

  if (loading) return <TabLoading stats={3} />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const PAGE_LABELS = {
    'firm-intelligence': 'Firm Intelligence',
    'trader-risk-intelligence': 'Trader & Risk Intelligence'
  };

  return (
    <>
      <AdminStatGrid minColumnWidth={220}>
        <AdminStatCard icon="analytics" label="Analyses" value={fmtNumber(data.summary.total)} />
        <AdminStatCard icon="approve" label="Computed From Live Data" value={fmtNumber(data.summary.total - data.summary.conditional)} />
        <AdminStatCard icon="info" label="Awaiting Data" value={fmtNumber(data.summary.conditional)} />
      </AdminStatGrid>

      <div className="admin-filter-bar" style={{ marginBottom: 'var(--space-4)', flexWrap: 'wrap' }}>
        <input
          type="search"
          className="admin-input"
          style={{ minWidth: '240px', flex: '1 1 240px' }}
          placeholder="Search by name, definition or source table…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search the analysis catalogue"
        />
        {[
          { key: 'all', label: 'Both pages' },
          { key: 'firm-intelligence', label: 'Firm' },
          { key: 'trader-risk-intelligence', label: 'Trader & Risk' }
        ].map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={`admin-filter-chip ${pageFilter === opt.key ? 'active' : ''}`}
            onClick={() => setPageFilter(opt.key)}
          >
            {opt.label}
          </button>
        ))}
        {[
          { key: 'all', label: 'Any status' },
          { key: 'live', label: 'Live' },
          { key: 'conditional', label: 'Awaiting data' }
        ].map((opt) => (
          <button
            key={opt.key}
            type="button"
            className={`admin-filter-chip ${statusFilter === opt.key ? 'active' : ''}`}
            onClick={() => setStatusFilter(opt.key)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          className="admin-filter-chip"
          onClick={() => downloadCsv('analysis-catalogue.csv', filtered, [
            { header: 'ID', value: (r) => r.id },
            { header: 'Name', value: (r) => r.name },
            { header: 'Page', value: (r) => PAGE_LABELS[r.page] || r.page },
            { header: 'Tab', value: (r) => r.tab },
            { header: 'Definition', value: (r) => r.definition },
            { header: 'Source tables', value: (r) => (r.tables || []).join(' ') },
            { header: 'Status', value: (r) => r.status },
            { header: 'Requires', value: (r) => r.requires || '' }
          ])}
        >
          Export CSV
        </button>
      </div>

      <Card flush style={{ marginBottom: 'var(--space-2)' }}>
        <AdminDataTable
          density="compact"
          columns={[
            { header: 'ID', key: 'id', isMono: true },
            { header: 'Analysis', render: (r) => <strong style={{ color: 'var(--admin-text)' }}>{r.name}</strong> },
            { header: 'What it measures', render: (r) => <span style={{ color: 'var(--admin-text-muted)' }}>{r.definition}</span> },
            { header: 'Page', render: (r) => PAGE_LABELS[r.page] || r.page },
            { header: 'Tab', key: 'tab', isMono: true },
            {
              header: 'Source tables',
              render: (r) => (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', color: 'var(--admin-text-faint)' }}>
                  {(r.tables || []).join(', ')}
                </span>
              )
            },
            {
              header: 'Status',
              render: (r) => (r.status === 'live'
                ? <AdminBadge bracket status="approved" label="live" />
                : <AdminBadge bracket status="warn" label="needs data" />)
            }
          ]}
          data={filtered}
          emptyMessage="No analyses match this filter"
          emptyIcon="search"
        />
      </Card>
      <SectionNote>
        Showing {fmtNumber(filtered.length)} of {fmtNumber(data.summary.total)}. &quot;Needs data&quot; means the analysis is implemented and will populate once its prerequisite exists —
        campaign-tagged traffic, recorded acquisition spend, an edge country header, or trades inside the 90-day price-history window.
      </SectionNote>
    </>
  );
}
