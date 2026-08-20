import React, { useState } from 'react';
import { DATE_PRESETS, presetToRange } from './shared';
import TraderPerformanceTab from './TraderPerformanceTab';
import RiskViolationTab from './RiskViolationTab';
import FirmProfitabilityTab from './FirmProfitabilityTab';
import FunnelConversionTab from './FunnelConversionTab';
import TradeBehaviorTab from './TradeBehaviorTab';
import RealTimeMonitoringTab from './RealTimeMonitoringTab';
import ModelOptimizationTab from './ModelOptimizationTab';
import ComplianceAuditTab from './ComplianceAuditTab';

// New Admin Panel section (nested under the normal AdminLayout/AdminSidebar,
// unlike Support & Appeals Center) — 8 read-only analytics/reporting tabs.

const TABS = [
  { key: 'performance', label: 'Trader Performance' },
  { key: 'risk', label: 'Risk & Rule Violation' },
  { key: 'profitability', label: 'Firm Profitability' },
  { key: 'funnel', label: 'Funnel & Conversion' },
  { key: 'behavior', label: 'Trade Behavior' },
  { key: 'realtime', label: 'Real-Time Monitoring' },
  { key: 'optimization', label: 'Model Optimization' },
  { key: 'compliance', label: 'Compliance & Audit' },
];

const TAB_SUBTITLES = {
  performance: 'Per-trader and firm-aggregate performance metrics, with equity-curve drill-down.',
  risk: 'Live drawdown tracking and historical rule-violation flags across all active accounts.',
  profitability: 'Fees, payouts, net profit, and pass-rate economics across evaluation models.',
  funnel: 'Visitor-to-funded conversion funnels, drop-off rates, and retry behavior.',
  behavior: 'Trade-level behavior patterns: lot-size distribution, session timing, copy-trading signals.',
  realtime: 'Live P&L, open exposure, and directional bias across all accounts.',
  optimization: 'Pricing, difficulty, and rule-strictness tuning signals across evaluation models.',
  compliance: 'Read-only historical logs for record-keeping — not the actionable appeals queue.',
};

function DateRangeFilter({ range, onChange, preset, onPresetChange }) {
  return (
    <div className="admin-filter-bar" style={{ marginBottom: 'var(--space-5)' }}>
      {DATE_PRESETS.map((p) => (
        <button
          key={p.key}
          className={`admin-filter-chip ${preset === p.key ? 'active' : ''}`}
          onClick={() => {
            onPresetChange(p.key);
            onChange(presetToRange(p.key));
          }}
        >
          {p.label}
        </button>
      ))}
      <input
        type="date"
        className="admin-input"
        style={{ width: '150px' }}
        value={range.from}
        onChange={(e) => { onPresetChange(null); onChange({ ...range, from: e.target.value }); }}
      />
      <span style={{ color: 'var(--admin-text-faint)' }}>to</span>
      <input
        type="date"
        className="admin-input"
        style={{ width: '150px' }}
        value={range.to}
        onChange={(e) => { onPresetChange(null); onChange({ ...range, to: e.target.value }); }}
      />
    </div>
  );
}

export default function AdminAnalytics() {
  const [activeTab, setActiveTab] = useState('performance');
  const [preset, setPreset] = useState('month');
  const [dateRange, setDateRange] = useState(presetToRange('month'));

  return (
    <>
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div className="lx-card__eyebrow">ADMIN PANEL / ANALYTICS</div>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 2.4vw, 28px)', fontWeight: 700, color: 'var(--admin-text)', margin: 'var(--space-1) 0 var(--space-2)' }}>
          {TABS.find((t) => t.key === activeTab)?.label}
        </h1>
        <p style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)', maxWidth: '640px' }}>
          {TAB_SUBTITLES[activeTab]}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 'var(--space-2-5)', flexWrap: 'wrap', marginBottom: 'var(--space-5)' }}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            className={`admin-filter-chip ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab !== 'realtime' && (
        <DateRangeFilter range={dateRange} onChange={setDateRange} preset={preset} onPresetChange={setPreset} />
      )}

      {activeTab === 'performance' && <TraderPerformanceTab dateRange={dateRange} />}
      {activeTab === 'risk' && <RiskViolationTab />}
      {activeTab === 'profitability' && <FirmProfitabilityTab dateRange={dateRange} />}
      {activeTab === 'funnel' && <FunnelConversionTab />}
      {activeTab === 'behavior' && <TradeBehaviorTab />}
      {activeTab === 'realtime' && <RealTimeMonitoringTab />}
      {activeTab === 'optimization' && <ModelOptimizationTab />}
      {activeTab === 'compliance' && <ComplianceAuditTab dateRange={dateRange} />}
    </>
  );
}
