import React, { useCallback, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { DATE_PRESETS, presetToRange } from '../AdminAnalytics/shared';
import { LastUpdated } from './shared';
import RevenueTab from './RevenueTab';
import ModelsTab from './ModelsTab';
import LiabilityTab from './LiabilityTab';
import GrowthTab from './GrowthTab';
import OpsHealthTab from './OpsHealthTab';
import PulseTab from './PulseTab';
import CatalogueTab from './CatalogueTab';

// Firm Intelligence — 75 read-only analyses over the firm's own numbers.
//
// This page has no controls. Nothing here approves, bans, adjusts or overrides
// anything: the only interactions are choosing a tab, moving the date window,
// and exporting a table to CSV. Every endpoint behind it is a GET.

const TABS = [
  { key: 'revenue', label: 'Revenue & Economics', subtitle: 'Where the money comes from, what it costs to earn, and what each cohort is worth. (A1–A25)' },
  { key: 'models', label: 'Models & Pricing', subtitle: 'Pass rates, fail causes, survival, and which rule is actually deciding outcomes. (B26–B40)' },
  { key: 'liability', label: 'Payouts & Liability', subtitle: 'What the firm owes now, what it could owe, and whether the split is holding. (C41–C52)' },
  { key: 'growth', label: 'Growth & Affiliate', subtitle: 'Acquisition, activation, retention, affiliate quality and competition return. (E78–E95)' },
  { key: 'ops', label: 'Ops Health', subtitle: 'Support load, dispute cost, price-feed integrity and engine health. (F96–F100)' },
  { key: 'pulse', label: 'Live Pulse', subtitle: 'Live exposure, floating P&L, accounts near the line and everything waiting on the firm.' },
  { key: 'catalogue', label: 'Catalogue', subtitle: 'Every analysis on both intelligence pages, what it measures and which tables it reads.' }
];

// Tabs whose data is a point-in-time snapshot rather than a windowed
// aggregation — a date filter above them would be a lie.
const RANGELESS = new Set(['pulse', 'catalogue']);

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

export default function AdminIntelligence() {
  const { adminAxios } = useOutletContext();
  const [activeTab, setActiveTab] = useState('revenue');
  const [preset, setPreset] = useState('month');
  const [dateRange, setDateRange] = useState(presetToRange('month'));
  const [updatedAt, setUpdatedAt] = useState(null);

  // Stable identity so a tab's effect does not re-fire on every parent render.
  const handleUpdated = useCallback((at) => setUpdatedAt(at), []);

  const tab = TABS.find((t) => t.key === activeTab);
  const tabProps = { adminAxios, dateRange, onUpdated: handleUpdated };

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div className="lx-card__eyebrow">ADMIN PANEL / FIRM INTELLIGENCE</div>
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
        {activeTab !== 'pulse' && updatedAt ? (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <LastUpdated at={updatedAt} intervalMs={60000} />
          </div>
        ) : null}
      </div>

      <div
        role="tablist"
        aria-label="Firm intelligence sections"
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

      {!RANGELESS.has(activeTab) ? (
        <DateRangeFilter range={dateRange} onChange={setDateRange} preset={preset} onPresetChange={setPreset} />
      ) : null}

      {activeTab === 'revenue' && <RevenueTab {...tabProps} />}
      {activeTab === 'models' && <ModelsTab {...tabProps} />}
      {activeTab === 'liability' && <LiabilityTab {...tabProps} />}
      {activeTab === 'growth' && <GrowthTab {...tabProps} />}
      {activeTab === 'ops' && <OpsHealthTab {...tabProps} />}
      {activeTab === 'pulse' && <PulseTab adminAxios={adminAxios} onUpdated={handleUpdated} />}
      {activeTab === 'catalogue' && <CatalogueTab adminAxios={adminAxios} />}
    </>
  );
}
