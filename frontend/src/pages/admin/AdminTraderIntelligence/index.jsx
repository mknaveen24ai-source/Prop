import React, { useCallback, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { DATE_PRESETS, presetToRange } from '../AdminAnalytics/shared';
import { useIntelligence, TabLoading, TabError, LastUpdated, fmtMoney, fmtNumber, toneFor } from '../AdminIntelligence/shared';
import AdminBadge from '../../../components/admin/AdminBadge';
import Card from '../../../components/ui/Card';
import RiskFraudTab from './RiskFraudTab';
import EdgeTab from './EdgeTab';
import DisciplineTab from './DisciplineTab';
import ForecastTab from './ForecastTab';
import BenchmarkTab from './BenchmarkTab';

// Trader & Risk Intelligence — 75 read-only analyses.
//
// Two halves that share a page because they answer the same question from
// different distances: the Risk & Fraud tab is the firm-wide surface, and the
// remaining four are the full analytics suite for one selected trader. An
// operator moves from "something is wrong somewhere" to "here is exactly what
// this person did" without leaving the page.
//
// No controls. Every endpoint behind this page is a GET; enforcement still
// happens in the existing Violations, Account Linking and Payouts pages.

const TABS = [
  { key: 'risk', label: 'Risk & Fraud', scope: 'firm', subtitle: 'Violations, collusion, strategy-shape detection, shared identity and payout risk across the whole book. (D53–D77)' },
  { key: 'edge', label: 'Edge', scope: 'trader', subtitle: 'Where this trader’s result actually comes from, and whether it is repeatable. (G101–G120)' },
  { key: 'discipline', label: 'Discipline', scope: 'trader', subtitle: 'Risk behaviour, rule proximity and the probability of ruin. (H121–H132)' },
  { key: 'forecast', label: 'Forecast', scope: 'trader', subtitle: 'Progress, pass probability and headroom on every rule at once. (I133–I142)' },
  { key: 'benchmark', label: 'Benchmark', scope: 'trader', subtitle: 'How this trader compares to peers and to the accounts that passed. (J143–J150)' }
];

function TraderPicker({ adminAxios, selectedId, onSelect }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');

  const { data, loading } = useIntelligence(adminAxios, '/api/admin/trader-intelligence/traders', {
    params: { q: query, limit: 50 },
    intervalMs: 0
  });

  const traders = data?.traders || [];

  return (
    <Card style={{ marginBottom: 'var(--space-5)' }}>
      <form
        onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }}
        className="admin-filter-bar"
        style={{ marginBottom: traders.length ? 'var(--space-4)' : 0 }}
      >
        <input
          type="search"
          className="admin-input"
          style={{ minWidth: '260px', flex: '1 1 260px' }}
          placeholder="Search by name, email or trader UID…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search traders"
        />
        <button type="submit" className="admin-filter-chip">Search</button>
        {query ? (
          <button
            type="button"
            className="admin-filter-chip"
            onClick={() => { setSearch(''); setQuery(''); }}
          >
            Clear
          </button>
        ) : null}
      </form>

      {loading ? (
        <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>Loading traders…</p>
      ) : traders.length === 0 ? (
        <p style={{ color: 'var(--admin-text-faint)', fontSize: 'var(--fs-base)', margin: 0 }}>
          No trader matches that search.
        </p>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 'var(--space-2-5)',
          maxHeight: '320px',
          overflowY: 'auto'
        }}>
          {traders.map((t) => {
            const selected = t.user_id === selectedId;
            return (
              <button
                key={t.user_id}
                type="button"
                onClick={() => onSelect(t.user_id)}
                aria-pressed={selected}
                style={{
                  textAlign: 'left',
                  padding: 'var(--space-3)',
                  border: `1px solid ${selected ? 'var(--admin-accent)' : 'var(--rule)'}`,
                  background: selected ? 'var(--glass-2, transparent)' : 'transparent',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
                  <strong style={{ fontSize: 'var(--fs-base)', color: 'var(--admin-text)' }}>
                    {t.full_name || t.email}
                  </strong>
                  {t.open_violations > 0 ? <AdminBadge bracket status="danger" label={String(t.open_violations)} /> : null}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-3xs)', color: 'var(--admin-text-faint)', marginTop: 'var(--space-1)' }}>
                  {t.trader_uid || t.email}
                </div>
                <div style={{
                  display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-2)',
                  fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums',
                  fontSize: 'var(--fs-3xs)', color: 'var(--admin-text-muted)'
                }}>
                  <span>{fmtNumber(t.active_accounts)} active</span>
                  <span>{fmtNumber(t.funded_accounts)} funded</span>
                  <span style={{ color: toneFor(t.net_pnl) }}>{fmtMoney(t.net_pnl, { signed: true })}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function TraderDetail({ adminAxios, userId, tab }) {
  const { data, loading, error, updatedAt } = useIntelligence(
    adminAxios,
    `/api/admin/trader-intelligence/trader/${userId}`,
    { intervalMs: 60000 }
  );

  if (loading) return <TabLoading stats={6} />;
  if (error) return <TabError message={error} />;
  if (!data) return null;

  const t = data.trader;

  return (
    <>
      <Card style={{ marginBottom: 'var(--space-5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
          <div>
            <h2 className="admin-h2" style={{ margin: 0 }}>{t.full_name || t.email}</h2>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-faint)', marginTop: 'var(--space-1)' }}>
              {t.trader_uid || '—'} · {t.email} · {t.country || 'unknown country'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <AdminBadge bracket status={t.kyc_status} label={`KYC ${t.kyc_status}`} />
            {t.is_banned ? <AdminBadge bracket status="danger" label="banned" /> : null}
            {t.is_bot ? <AdminBadge bracket status="warn" label="bot account" /> : null}
            <AdminBadge bracket status="muted" label={`${data.accounts.length} accounts`} />
            {(data.violations || []).length > 0
              ? <AdminBadge bracket status="danger" label={`${data.violations.length} violations`} />
              : null}
          </div>
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <LastUpdated at={updatedAt} intervalMs={60000} />
        </div>
      </Card>

      {tab === 'edge' && <EdgeTab data={data} />}
      {tab === 'discipline' && <DisciplineTab data={data} />}
      {tab === 'forecast' && <ForecastTab data={data} />}
      {tab === 'benchmark' && <BenchmarkTab data={data} />}
    </>
  );
}

function DateRangeFilter({ range, onChange, preset, onPresetChange }) {
  return (
    <div className="admin-filter-bar" style={{ marginBottom: 'var(--space-5)' }}>
      {DATE_PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          className={`admin-filter-chip ${preset === p.key ? 'active' : ''}`}
          onClick={() => { onPresetChange(p.key); onChange(presetToRange(p.key)); }}
        >
          {p.label}
        </button>
      ))}
      <input
        type="date"
        className="admin-input"
        style={{ width: '150px' }}
        value={range.from}
        aria-label="Range start"
        onChange={(e) => { onPresetChange(null); onChange({ ...range, from: e.target.value }); }}
      />
      <span style={{ color: 'var(--admin-text-faint)' }}>to</span>
      <input
        type="date"
        className="admin-input"
        style={{ width: '150px' }}
        value={range.to}
        aria-label="Range end"
        onChange={(e) => { onPresetChange(null); onChange({ ...range, to: e.target.value }); }}
      />
    </div>
  );
}

export default function AdminTraderIntelligence() {
  const { adminAxios } = useOutletContext();
  const [activeTab, setActiveTab] = useState('risk');
  const [preset, setPreset] = useState('month');
  const [dateRange, setDateRange] = useState(presetToRange('month'));
  const [selectedTrader, setSelectedTrader] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);

  const handleUpdated = useCallback((at) => setUpdatedAt(at), []);
  const tab = useMemo(() => TABS.find((t) => t.key === activeTab), [activeTab]);
  const isTraderScoped = tab?.scope === 'trader';

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div className="lx-card__eyebrow">ADMIN PANEL / TRADER &amp; RISK INTELLIGENCE</div>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(22px, 2.4vw, 28px)',
          fontWeight: 700,
          color: 'var(--admin-text)',
          margin: 'var(--space-1) 0 var(--space-2)'
        }}>
          {tab?.label}
        </h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', maxWidth: '720px', margin: 0 }}>
          {tab?.subtitle}
        </p>
        {!isTraderScoped && updatedAt ? (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <LastUpdated at={updatedAt} intervalMs={60000} />
          </div>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Trader and risk intelligence sections"
        style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap', marginBottom: 'var(--space-5)' }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            className={`admin-filter-chip ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isTraderScoped ? (
        <>
          <TraderPicker adminAxios={adminAxios} selectedId={selectedTrader} onSelect={setSelectedTrader} />
          {selectedTrader ? (
            <TraderDetail adminAxios={adminAxios} userId={selectedTrader} tab={activeTab} />
          ) : (
            <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
              <h3 style={{ color: 'var(--admin-text)', marginBottom: 'var(--space-2)' }}>Choose a trader</h3>
              <p style={{ color: 'var(--admin-text-muted)', margin: 0, fontSize: 'var(--fs-base)' }}>
                These four tabs analyse one trader at a time. Pick someone above, or start from the Risk &amp; Fraud tab to find who is worth looking at.
              </p>
            </Card>
          )}
        </>
      ) : (
        <>
          <DateRangeFilter range={dateRange} onChange={setDateRange} preset={preset} onPresetChange={setPreset} />
          <RiskFraudTab adminAxios={adminAxios} dateRange={dateRange} onUpdated={handleUpdated} />
        </>
      )}
    </>
  );
}
