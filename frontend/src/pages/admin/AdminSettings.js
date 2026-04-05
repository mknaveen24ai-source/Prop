import React, { useState, useEffect } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useToast } from '../../components/admin/AdminToast';

const SETTINGS_GROUPS = [
  {
    title: '🏆 Phase 1 Rules',
    fields: [
      { key: 'phase1_profit_target_pct', label: 'Profit Target (%)', type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_max_drawdown_pct',  label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_day_limit',         label: 'Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'phase1_drawdown_type',     label: 'Drawdown Type',     type: 'select', options: ['trailing', 'static'] },
    ]
  },
  {
    title: '🎯 Phase 2 Rules',
    fields: [
      { key: 'phase2_profit_target_pct', label: 'Profit Target (%)', type: 'number', hint: 'e.g. 5' },
      { key: 'phase2_max_drawdown_pct',  label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 10' },
      { key: 'phase2_day_limit',         label: 'Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'phase2_drawdown_type',     label: 'Drawdown Type',     type: 'select', options: ['trailing', 'static'] },
    ]
  },
  {
    title: '💰 Funded Account Rules',
    fields: [
      { key: 'funded_max_drawdown_pct', label: 'Max Drawdown (%)',  type: 'number', hint: 'e.g. 5' },
      { key: 'funded_drawdown_type',    label: 'Drawdown Type',     type: 'select', options: ['trailing', 'static'] },
      { key: 'profit_share_pct',        label: 'Profit Share (%)',  type: 'number', hint: 'e.g. 80 (trader keeps 80%)' },
    ]
  },
  {
    title: '⚙️ Trading Rules',
    fields: [
      { key: 'min_hold_seconds',       label: 'Min Hold Time (s)',         type: 'number', hint: 'e.g. 60' },
      { key: 'min_lot_size',           label: 'Minimum Lot Size',          type: 'number', hint: 'e.g. 0.01' },
      { key: 'forex_lots_per_1k',      label: 'Forex Lots per $1k',        type: 'number', hint: 'e.g. 0.20' },
      { key: 'commodity_lots_per_1k',  label: 'Commodity Lots per $1k',    type: 'number', hint: 'e.g. 0.02' },
      { key: 'max_trades_per_1k',      label: 'Max Open Trades per $1k',   type: 'number', hint: 'e.g. 1' },
    ]
  },
  {
    title: '👥 Account Quotas',
    fields: [
      { key: 'max_total_accounts',    label: 'Max Total Active Accounts', type: 'number', hint: 'Blank = unlimited' },
      { key: 'max_accounts_per_user', label: 'Max Accounts per User',     type: 'number', hint: 'Blank = unlimited' },
      { key: 'quota_1000',    label: '$1,000 Quota',    type: 'number' },
      { key: 'quota_2000',    label: '$2,000 Quota',    type: 'number' },
      { key: 'quota_2500',    label: '$2,500 Quota',    type: 'number' },
      { key: 'quota_5000',    label: '$5,000 Quota',    type: 'number' },
      { key: 'quota_10000',   label: '$10,000 Quota',   type: 'number' },
      { key: 'quota_25000',   label: '$25,000 Quota',   type: 'number' },
      { key: 'quota_50000',   label: '$50,000 Quota',   type: 'number' },
      { key: 'quota_100000',  label: '$100,000 Quota',  type: 'number' },
      { key: 'quota_200000',  label: '$200,000 Quota',  type: 'number' },
    ]
  },
  {
    title: '📅 Quota Period',
    fields: [
      { key: 'max_accounts_period_start', label: 'Period Start', type: 'date' },
      { key: 'max_accounts_period_end',   label: 'Period End',   type: 'date' },
    ]
  },
];

export default function AdminSettings() {
  const { adminAxios } = useOutletContext();
  const toast = useToast();

  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadSettings = () => {
    setLoading(true);
    adminAxios.get('/api/admin/settings')
      .then(r => { setValues(r.data || {}); setDirty(false); })
      .catch(() => toast.error('Could not load settings'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadSettings();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = (key, value) => {
    setValues(v => ({ ...v, [key]: value }));
    setDirty(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await adminAxios.post('/api/admin/settings', values);
      toast.success('Settings saved successfully');
      setDirty(false);
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save settings');
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div style={{ padding: '40px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '24px' }}>
        {Array(6).fill(0).map((_, i) => <div key={i} className="admin-skeleton" style={{ height: '240px', borderRadius: '12px' }} />)}
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
        <div>
          <h1 className="admin-h1">Platform Settings</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>Changes are audited and take effect immediately (30s cache on trading rules).</p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {dirty && (
            <span style={{ fontSize: '12px', color: 'var(--admin-warning)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--admin-warning)', display: 'inline-block' }} />
              Unsaved changes
            </span>
          )}
          <button className="admin-btn admin-btn-ghost" onClick={loadSettings}>↺ Reset</button>
          <button className="admin-btn admin-btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : '💾 Save All'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '24px' }}>
        {SETTINGS_GROUPS.map(group => (
          <div key={group.title} className="admin-card">
            <h3 className="admin-h3" style={{ marginBottom: '20px', borderBottom: '1px solid var(--admin-border)', paddingBottom: '12px' }}>
              {group.title}
            </h3>
            {group.fields.map(field => (
              <div key={field.key} className="admin-form-group">
                <label className="admin-label">
                  {field.label}
                  {field.hint && <span style={{ color: 'var(--admin-text-faint)', fontWeight: 400, marginLeft: '8px', textTransform: 'none' }}>{field.hint}</span>}
                </label>
                {field.type === 'select' ? (
                  <select
                    className="admin-select"
                    value={values[field.key] || ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                  >
                    <option value="">– not set –</option>
                    {field.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type}
                    className="admin-input"
                    value={values[field.key] ?? ''}
                    onChange={e => handleChange(field.key, e.target.value)}
                    placeholder={field.hint || ''}
                    step={field.type === 'number' ? 'any' : undefined}
                    style={{
                      borderColor: dirty && values[field.key] !== undefined ? 'var(--admin-accent)' : undefined,
                      colorScheme: 'dark'
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
