import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { PageWrapper } from '../../App';
import AdminDataTable from '../../components/admin/AdminDataTable';
import AdminFilterBar from '../../components/admin/AdminFilterBar';
import AdminBadge from '../../components/admin/AdminBadge';
import AdminStatCard from '../../components/admin/AdminStatCard';
import AdminModal from '../../components/admin/AdminModal';
import { useToast } from '../../components/admin/AdminToast';
import AdminListToolbar from '../../components/admin/AdminListToolbar';
import { exportAdminResource, normalizeAdminListResponse } from '../../utils/adminList';
import Card from '../../components/ui/Card';
import ClusterGraph from '../../components/admin/ClusterGraph';

const DEFAULT_FILTERS = {
  status: 'open',
  confidence: 'all'
};

const ALL_COLUMN_KEYS = ['cluster', 'members', 'signals', 'score', 'evidence', 'detected', 'status'];

const TABS = [
  { key: 'clusters', label: 'Linked Accounts' },
  { key: 'payout_fraud', label: 'Payout Fraud Scores' },
  { key: 'aml', label: 'AML Velocity' }
];

const SIGNAL_LABELS = {
  ip: 'Same IP',
  ip_subnet: 'Same network',
  device_fp: 'Same device',
  device_component: 'Device components',
  payout_dest: 'Same payout destination',
  kyc_doc: 'Same KYC document',
  simultaneous_execution: 'Simultaneous trades'
};

// Signals that on their own are close to proof, versus ones that only matter in
// combination. Drives colouring so an admin can triage the list at a glance.
const STRONG_SIGNALS = new Set(['payout_dest', 'kyc_doc', 'simultaneous_execution', 'device_fp']);

function confidenceTone(confidence) {
  if (confidence === 'high') return 'rejected';
  if (confidence === 'medium') return 'pending';
  return 'inactive';
}

function statusTone(status) {
  if (status === 'confirmed_sharing') return 'rejected';
  if (status === 'false_positive') return 'approved';
  if (status === 'monitoring') return 'pending';
  return 'active';
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

export default function AdminAccountLinking() {
  const { adminAxios, session, socket } = useOutletContext();
  const toast = useToast();
  const isSuperAdmin = session?.role === 'super_admin';

  const [tab, setTab] = useState('clusters');
  const [loading, setLoading] = useState(true);
  const [listData, setListData] = useState({
    summary: {},
    rows: [],
    pagination: { current: 1, total: 1, total_items: 0, page_size: 25 }
  });
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: 'score', direction: 'desc' });
  const [density, setDensity] = useState('comfortable');
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(ALL_COLUMN_KEYS);
  const [scanning, setScanning] = useState(false);

  // Cluster detail modal
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [graph, setGraph] = useState(null);

  // Secondary tabs — these render the two endpoints that shipped with no UI.
  const [fraudScores, setFraudScores] = useState([]);
  const [amlRows, setAmlRows] = useState([]);
  const [secondaryLoading, setSecondaryLoading] = useState(false);

  const fetchViews = useCallback(async () => {
    try {
      const res = await adminAxios.get('/api/admin/saved-views', { params: { resource: 'account_links' } });
      setViews(Array.isArray(res.data) ? res.data : []);
    } catch {
      setViews([]);
    }
  }, [adminAxios]);

  const fetchClusters = useCallback(async ({ silent = false, pageOverride } = {}) => {
    const effectivePage = pageOverride ?? page;
    if (!silent) setLoading(true);
    try {
      const res = await adminAxios.get('/api/admin/account-links', {
        params: {
          format: 'list',
          page: effectivePage,
          page_size: 25,
          search,
          sort: sort.key,
          order: sort.direction,
          status: filters.status !== 'all' ? filters.status : undefined,
          confidence: filters.confidence !== 'all' ? filters.confidence : undefined
        }
      });
      setListData(normalizeAdminListResponse(res.data));
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load linked accounts');
    } finally {
      if (!silent) setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminAxios, page, search, sort, filters]);

  useEffect(() => {
    if (tab !== 'clusters') return;
    fetchClusters();
    fetchViews();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, tab]);

  useEffect(() => {
    if (tab !== 'clusters') return undefined;
    const timeout = setTimeout(() => {
      setPage(1);
      fetchClusters({ silent: true, pageOverride: 1 });
    }, 150);
    return () => clearTimeout(timeout);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters]);

  // The scan writes violations, which broadcast admin_violation_updated — so the
  // list refreshes itself the moment a new cluster is detected.
  useEffect(() => {
    if (!socket || tab !== 'clusters') return undefined;
    const refresh = () => fetchClusters({ silent: true });
    socket.on('admin_violation_updated', refresh);
    return () => socket.off('admin_violation_updated', refresh);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, tab, page, sort, search, filters]);

  useEffect(() => {
    if (tab === 'clusters') return;
    let cancelled = false;
    setSecondaryLoading(true);
    const endpoint = tab === 'payout_fraud'
      ? '/api/admin/payout-fraud-scores'
      : '/api/admin/aml-velocity';

    adminAxios.get(endpoint)
      .then((res) => {
        if (cancelled) return;
        const payload = Array.isArray(res.data) ? res.data : (res.data?.rows || res.data?.scores || []);
        if (tab === 'payout_fraud') setFraudScores(payload);
        else setAmlRows(payload);
      })
      .catch((err) => {
        if (!cancelled) toast.error(err?.response?.data?.error || 'Failed to load risk signals');
      })
      .finally(() => { if (!cancelled) setSecondaryLoading(false); });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, adminAxios]);

  const rows = listData.rows || [];
  const summary = listData.summary || {};
  const pagination = listData.pagination || { current: 1, total: 1 };

  const handleSortChange = (sortKey) => {
    setSort((current) => ({
      key: sortKey,
      direction: current.key === sortKey && current.direction === 'desc' ? 'asc' : 'desc'
    }));
  };

  const toggleColumn = (columnKey) => {
    setVisibleColumnKeys((current) => (
      current.includes(columnKey)
        ? current.filter((key) => key !== columnKey)
        : [...current, columnKey]
    ));
  };

  const openDetail = async (cluster) => {
    setDetail({ cluster, evidence: [], members: [] });
    setDetailLoading(true);
    setGraph(null);
    try {
      const [detailRes, graphRes] = await Promise.all([
        adminAxios.get(`/api/admin/account-links/${cluster.id}`),
        adminAxios.get(`/api/admin/account-links/${cluster.id}/graph`)
      ]);
      setDetail(detailRes.data);
      setGraph(graphRes.data);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Failed to load cluster evidence');
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const resolveCluster = async (cluster, status, promptLabel) => {
    const reason = window.prompt(promptLabel, '');
    if (!reason) return;
    try {
      await adminAxios.post(`/api/admin/account-links/${cluster.id}/resolve`, { status, reason });
      toast.success('Cluster updated');
      setDetail(null);
      fetchClusters({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not update cluster');
    }
  };

  const runScan = async () => {
    setScanning(true);
    try {
      const res = await adminAxios.post('/api/admin/account-links/scan');
      toast.success(`Scan complete — ${res.data?.persisted ?? 0} cluster(s) recorded`);
      fetchClusters({ silent: true });
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const saveView = async () => {
    const name = window.prompt('Name this view', 'High confidence sharing');
    if (!name) return;
    try {
      await adminAxios.post('/api/admin/saved-views', {
        resource: 'account_links',
        name,
        config: { search, filters, sort, columns: visibleColumnKeys, density }
      });
      toast.success('View saved');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save view');
    }
  };

  const selectView = (viewId) => {
    setActiveViewId(viewId);
    const view = views.find((item) => String(item.id) === String(viewId));
    if (!view?.config) return;
    setSearch(view.config.search || '');
    setFilters({ ...DEFAULT_FILTERS, ...(view.config.filters || {}) });
    if (view.config.sort) setSort(view.config.sort);
    if (view.config.columns) setVisibleColumnKeys(view.config.columns);
    if (view.config.density) setDensity(view.config.density);
  };

  const deleteView = async (viewId) => {
    try {
      await adminAxios.delete(`/api/admin/saved-views/${viewId}`);
      setActiveViewId('');
      fetchViews();
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not delete view');
    }
  };

  const columns = useMemo(() => [
    {
      header: 'Cluster',
      key: 'cluster',
      isMono: true,
      render: (row) => `LNK-${String(row.id).padStart(5, '0')}`
    },
    {
      header: 'Linked traders',
      key: 'members',
      sortKey: 'member_count',
      render: (row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{row.member_count} accounts</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
            {(row.member_emails || []).slice(0, 2).join(', ')}
            {(row.member_emails || []).length > 2 ? ` +${row.member_emails.length - 2} more` : ''}
          </div>
        </div>
      )
    },
    {
      header: 'Evidence',
      key: 'signals',
      render: (row) => (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
          {(row.signal_types || []).map((type) => (
            <span
              key={type}
              className="admin-filter-chip"
              style={{
                fontSize: 'var(--fs-xs)',
                padding: '2px 8px',
                cursor: 'default',
                borderColor: STRONG_SIGNALS.has(type) ? 'var(--admin-danger, #e5484d)' : undefined,
                color: STRONG_SIGNALS.has(type) ? 'var(--admin-danger, #e5484d)' : undefined
              }}
            >
              {SIGNAL_LABELS[type] || type}
            </span>
          ))}
        </div>
      )
    },
    {
      header: 'Score',
      key: 'score',
      sortKey: 'score',
      render: (row) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <strong style={{ fontSize: '15px' }}>{row.score}</strong>
          <AdminBadge status={confidenceTone(row.confidence)} label={row.confidence} />
        </div>
      )
    },
    {
      header: 'Items',
      key: 'evidence',
      render: (row) => row.evidence_count ?? 0
    },
    {
      header: 'Last seen',
      key: 'detected',
      sortKey: 'last_detected_at',
      render: (row) => formatDate(row.last_detected_at)
    },
    {
      header: 'Status',
      key: 'status',
      sortKey: 'status',
      render: (row) => <AdminBadge status={statusTone(row.status)} label={String(row.status || '').replace(/_/g, ' ')} />
    }
  ], []);

  const visibleColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));

  const getRowActions = (cluster) => {
    const allowed = new Set(Array.isArray(cluster.allowed_actions) ? cluster.allowed_actions : []);
    const actions = [{ label: 'View evidence', icon: 'info', onClick: () => openDetail(cluster) }];
    if (allowed.has('confirm_sharing')) {
      actions.push({
        label: 'Confirm sharing',
        icon: 'flag',
        danger: true,
        onClick: () => resolveCluster(cluster, 'confirmed_sharing', 'Why is this confirmed account sharing?')
      });
    }
    if (allowed.has('mark_false_positive')) {
      actions.push({
        label: 'Mark false positive',
        icon: 'approve',
        onClick: () => resolveCluster(cluster, 'false_positive', 'Why is this not account sharing?')
      });
    }
    if (allowed.has('mark_monitoring')) {
      actions.push({
        label: 'Keep monitoring',
        icon: 'history',
        onClick: () => resolveCluster(cluster, 'monitoring', 'What are you watching for?')
      });
    }
    if (allowed.has('reopen_cluster')) {
      actions.push({
        label: 'Reopen',
        icon: 'history',
        onClick: () => resolveCluster(cluster, 'open', 'Why reopen this cluster?')
      });
    }
    return actions;
  };

  return (
    <PageWrapper>
      <>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
          <div>
            <h1 className="admin-h1">Account Linking</h1>
            <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>
              Suspected account sharing and challenge-passing services, scored from shared devices,
              networks, payout destinations, KYC documents and simultaneous order flow.
            </p>
          </div>
          {isSuperAdmin && tab === 'clusters' && (
            <button className="admin-btn admin-btn-ghost" onClick={runScan} disabled={scanning}>
              {scanning ? 'Scanning…' : 'Run scan now'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', borderBottom: '1px solid var(--admin-border)' }}>
          {TABS.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className="admin-btn admin-btn-ghost"
              style={{
                borderRadius: 0,
                borderBottom: tab === item.key ? '2px solid var(--admin-accent, #5b8def)' : '2px solid transparent',
                color: tab === item.key ? 'var(--admin-text)' : 'var(--admin-text-muted)'
              }}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'clusters' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '20px', marginBottom: '24px' }}>
              <AdminStatCard icon="warning" label="Open clusters" value={summary.open || 0} />
              <AdminStatCard icon="flag" label="High confidence" value={summary.high_confidence || 0} />
              <AdminStatCard icon="users" label="Traders involved" value={summary.users_involved || 0} />
              <AdminStatCard icon="approve" label="Confirmed" value={summary.confirmed || 0} />
            </div>

            <AdminFilterBar
              searchPlaceholder="Search by trader email or name..."
              searchValue={search}
              onSearchChange={setSearch}
            >
              {['open', 'monitoring', 'confirmed_sharing', 'false_positive', 'all'].map((status) => (
                <button
                  key={status}
                  className={`admin-filter-chip ${filters.status === status ? 'active' : ''}`}
                  onClick={() => setFilters((current) => ({ ...current, status }))}
                >
                  {status === 'all' ? 'All' : status.replace(/_/g, ' ')}
                </button>
              ))}
              <select
                className="admin-select"
                style={{ width: '180px' }}
                value={filters.confidence}
                onChange={(event) => setFilters((current) => ({ ...current, confidence: event.target.value }))}
              >
                <option value="all">All confidence</option>
                <option value="high">High only</option>
                <option value="medium">Medium only</option>
                <option value="low">Low only</option>
              </select>
            </AdminFilterBar>

            <AdminListToolbar
              resourceLabel="clusters"
              views={views}
              activeViewId={activeViewId}
              onSelectView={selectView}
              onSaveView={saveView}
              onDeleteView={deleteView}
              density={density}
              onDensityChange={setDensity}
              columns={columns}
              visibleColumnKeys={visibleColumnKeys}
              onToggleColumn={toggleColumn}
              onExport={() => exportAdminResource(adminAxios, 'account_links', {
                search,
                sort: sort.key,
                order: sort.direction,
                filters: {
                  status: filters.status !== 'all' ? filters.status : null,
                  confidence: filters.confidence !== 'all' ? filters.confidence : null
                }
              })}
            />

            <Card flush>
              <AdminDataTable
                columns={visibleColumns}
                data={rows}
                loading={loading}
                emptyMessage="No linked account clusters detected."
                rowActions={getRowActions}
                pagination={pagination}
                onPageChange={setPage}
                sort={sort}
                onSortChange={handleSortChange}
                density={density}
                onRowClick={openDetail}
              />
            </Card>
          </>
        )}

        {tab === 'payout_fraud' && (
          <Card flush>
            <AdminDataTable
              loading={secondaryLoading}
              emptyMessage="No payout fraud signals."
              data={fraudScores}
              columns={[
                { header: 'Payout', key: 'id', isMono: true, render: (row) => `PAY-${String(row.payout_id ?? row.id).padStart(5, '0')}` },
                { header: 'Trader', key: 'email', render: (row) => row.email || row.user_email || '—' },
                { header: 'Amount', key: 'amount', render: (row) => `$${Number(row.amount_requested || row.amount || 0).toLocaleString()}` },
                { header: 'Risk score', key: 'score', render: (row) => <strong>{row.risk_score ?? row.score ?? 0}</strong> },
                {
                  header: 'Level',
                  key: 'level',
                  render: (row) => <AdminBadge status={confidenceTone(String(row.risk_level || '').toLowerCase())} label={row.risk_level || 'low'} />
                },
                {
                  header: 'Reasons',
                  key: 'reasons',
                  render: (row) => (Array.isArray(row.reasons) ? row.reasons.join('; ') : (row.reasons || '—'))
                }
              ]}
            />
          </Card>
        )}

        {tab === 'aml' && (
          <Card flush>
            <AdminDataTable
              loading={secondaryLoading}
              emptyMessage="No AML velocity signals."
              data={amlRows}
              columns={[
                { header: 'Trader', key: 'email', render: (row) => row.email || '—' },
                { header: 'Logins 24h', key: 'logins', render: (row) => row.logins_24h ?? 0 },
                { header: 'Unique IPs 24h', key: 'ips', render: (row) => row.unique_ips_24h ?? 0 },
                { header: 'Trades 24h', key: 'trades', render: (row) => row.trades_24h ?? 0 },
                { header: 'Payouts 24h', key: 'payouts', render: (row) => row.payouts_24h ?? 0 },
                { header: 'Score', key: 'score', render: (row) => <strong>{row.velocity_score ?? row.score ?? 0}</strong> },
                {
                  header: 'Flags',
                  key: 'flags',
                  render: (row) => (Array.isArray(row.flags) ? row.flags.join('; ') : (row.flags || '—'))
                }
              ]}
            />
          </Card>
        )}

        <AdminModal
          isOpen={!!detail}
          onClose={() => setDetail(null)}
          title={detail ? `Cluster LNK-${String(detail.cluster?.id).padStart(5, '0')} — score ${detail.cluster?.score}/100` : ''}
          size="lg"
        >
          {detailLoading && <p style={{ color: 'var(--admin-text-muted)' }}>Loading evidence…</p>}

          {!detailLoading && detail && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {graph && graph.nodes?.length > 0 && (
                <div>
                  <h3 style={{ fontSize: 'var(--fs-base)', marginBottom: '8px' }}>Link graph</h3>
                  <ClusterGraph nodes={graph.nodes} edges={graph.edges} />
                </div>
              )}

              <div>
                <h3 style={{ fontSize: 'var(--fs-base)', marginBottom: '8px' }}>Linked traders</h3>
                <table className="admin-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Email</th><th>Name</th><th>Country</th><th>KYC</th><th>Accounts</th><th>Joined</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.members || []).map((member) => (
                      <tr key={member.id}>
                        <td>{member.email}</td>
                        <td>{member.full_name || '—'}</td>
                        <td>{member.country || '—'}</td>
                        <td>{member.kyc_status || '—'}</td>
                        <td>{member.account_count}{member.flagged_count > 0 ? ` (${member.flagged_count} flagged)` : ''}</td>
                        <td>{formatDate(member.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div>
                <h3 style={{ fontSize: 'var(--fs-base)', marginBottom: '8px' }}>Why these accounts were linked</h3>
                <table className="admin-table" style={{ width: '100%' }}>
                  <thead>
                    <tr><th>Signal</th><th>Detail</th><th>Traders</th><th>Weight</th></tr>
                  </thead>
                  <tbody>
                    {(detail.evidence || []).map((item) => (
                      <tr key={item.id}>
                        <td>
                          <AdminBadge
                            status={STRONG_SIGNALS.has(item.evidence_type) ? 'rejected' : 'pending'}
                            label={SIGNAL_LABELS[item.evidence_type] || item.evidence_type}
                          />
                        </td>
                        <td style={{ fontSize: 'var(--fs-sm)' }}>{item.evidence_label || item.evidence_value || '—'}</td>
                        <td>{item.distinct_users}</td>
                        <td>
                          {item.weight}
                          {item.detail?.entropy_factor !== undefined && item.detail.entropy_factor < 1 && (
                            <span style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-xs)' }}>
                              {' '}(×{item.detail.entropy_factor} shared by {item.detail.distinct_users})
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--admin-text-muted)', marginTop: '8px' }}>
                  Weights are reduced the more users share a value — a device or network seen across many
                  accounts is usually shared infrastructure (office, VPN, browser anti-fingerprinting),
                  not a ring. Detection never locks or flags an account on its own.
                </p>
              </div>

              {detail.cluster?.resolution_note && (
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                  <strong>Resolution:</strong> {detail.cluster.status} — {detail.cluster.resolution_note}
                  {detail.cluster.resolved_by ? ` (${detail.cluster.resolved_by})` : ''}
                </div>
              )}

              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  className="admin-btn admin-btn-ghost"
                  onClick={() => resolveCluster(detail.cluster, 'false_positive', 'Why is this not account sharing?')}
                >
                  False positive
                </button>
                <button
                  className="admin-btn admin-btn-ghost"
                  onClick={() => resolveCluster(detail.cluster, 'monitoring', 'What are you watching for?')}
                >
                  Keep monitoring
                </button>
                <button
                  className="admin-btn"
                  onClick={() => resolveCluster(detail.cluster, 'confirmed_sharing', 'Why is this confirmed account sharing?')}
                >
                  Confirm sharing
                </button>
              </div>
            </div>
          )}
        </AdminModal>
      </>
    </PageWrapper>
  );
}
