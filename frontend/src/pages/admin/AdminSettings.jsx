import React, { useState, useEffect, useCallback } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}

const ACCOUNT_SIZES = [1000, 2000, 5000, 10000, 25000, 50000, 100000, 200000]

function formatMoney(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? `$${parsed.toLocaleString()}` : 'N/A'
}

const SETTINGS_GROUPS = [
  {
    title: 'Account Allocation',
    fields: [
      { key: 'allow_free_claims', label: 'Allow Free Claims', type: 'select', options: ['true', 'false'], hint: 'false = close free challenge claiming without deleting availability quotas' },
      { key: 'free_account_monthly_claim_limit', label: 'Free Claims / User / Month', type: 'number', hint: 'Default 1. Use 0 to close free claims this month.' },
      { key: 'free_account_monthly_claim_mode', label: 'Free Claim Limit Mode', type: 'select', options: ['total', 'active'], hint: 'total = all claimed accounts/orders. active = active accounts plus reserved claims.' },
      { key: 'challenge_start_requires_kyc', label: 'Require KYC Before Challenge', type: 'select', options: ['true', 'false'], hint: 'true = traders must be KYC approved before claiming or creating a challenge' },
      { key: 'hide_unavailable_sizes_on_landing', label: 'Hide Sold-Out Sizes On Landing', type: 'select', options: ['true', 'false'] },
      { key: 'sold_out_message', label: 'Sold-Out Message', type: 'textarea', hint: 'Shown when a monthly size batch is full or set to 0' },
    ]
  },
  {
    title: 'Challenge Workflow',
    fields: [
      { key: 'phase1_profit_target_pct', label: 'Phase 1 Profit Target (%)', type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_max_drawdown_pct', label: 'Phase 1 Max Drawdown (%)', type: 'number', hint: 'e.g. 10' },
      { key: 'phase1_day_limit', label: 'Phase 1 Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'phase2_profit_target_pct', label: 'Profit Target (%)', type: 'number', hint: 'e.g. 5' },
      { key: 'phase2_max_drawdown_pct', label: 'Max Drawdown (%)', type: 'number', hint: 'e.g. 10' },
      { key: 'phase2_day_limit', label: 'Time Limit (days)', type: 'number', hint: 'e.g. 30' },
      { key: 'promotion_requires_admin_review', label: 'Promotion Requires Admin Review', type: 'select', options: ['true', 'false'], hint: 'Default true for batch-wise firms' },
      { key: 'promotion_review_sla_hours', label: 'Promotion Review SLA (hours)', type: 'number', hint: 'e.g. 24' },
      { key: 'failed_account_visibility_days', label: 'Failed Account Visibility (days)', type: 'number', hint: 'Frontend hide window only' },
      { key: 'passed_account_visibility_days', label: 'Passed Account Visibility (days)', type: 'number', hint: 'Frontend hide window only' },
      { key: 'expired_account_visibility_days', label: 'Expired Account Visibility (days)', type: 'number', hint: 'Frontend hide window only' },
    ]
  },
  {
    title: 'Funded & Payouts',
    fields: [
      { key: 'funded_max_drawdown_pct', label: 'Max Drawdown (%)', type: 'number', hint: 'e.g. 5' },
      { key: 'profit_share_pct', label: 'Profit Share (%)', type: 'number', hint: 'e.g. 80 (trader keeps 80%)' },
      { key: 'payouts_enabled', label: 'Payout Requests Enabled', type: 'select', options: ['true', 'false'] },
      { key: 'min_payout_amount', label: 'Minimum Payout Amount', type: 'number', hint: 'e.g. 50' },
      { key: 'payout_request_cooldown_hours', label: 'Payout Cooldown (hours)', type: 'number', hint: 'e.g. 24' },
      { key: 'payout_requires_kyc_approved', label: 'Payout Requires Approved KYC', type: 'select', options: ['true', 'false'] },
      { key: 'payout_requires_no_open_positions', label: 'Payout Requires No Open/Pending Trades', type: 'select', options: ['true', 'false'] },
    ]
  },
  {
    title: 'Trading Rules',
    fields: [
      { key: 'min_hold_seconds', label: 'Min Hold Time (s)', type: 'number', hint: 'e.g. 60' },
      { key: 'min_lot_size', label: 'Minimum Lot Size', type: 'number', hint: 'e.g. 0.01' },
      { key: 'forex_lots_per_1k', label: 'Forex Lots per $1k', type: 'number', hint: 'e.g. 0.20' },
      { key: 'commodity_lots_per_1k', label: 'Commodity Lots per $1k', type: 'number', hint: 'e.g. 0.02' },
      { key: 'max_trades_per_1k', label: 'Max Open Trades per $1k', type: 'number', hint: 'e.g. 1' },
      { key: 'max_daily_trades', label: 'Max Daily Trades', type: 'number', hint: 'e.g. 20 per account, per UTC day' },
      { key: 'weekend_holding_enabled', label: 'Weekend Holding', type: 'select', hint: 'true = allow existing exposure into the weekend. false = flatten open trades and cancel pending orders after Friday 21:00 UTC.', options: ['true', 'false'] },
      { key: 'news_protection_enabled', label: 'News Protection', type: 'select', options: ['true', 'false'], hint: 'Blocks new market and pending orders during High-impact news windows' },
      { key: 'news_protection_block_new_orders', label: 'News Blocks New Orders', type: 'select', options: ['true', 'false'] },
      { key: 'news_protection_lookahead_minutes', label: 'News Lookahead (minutes)', type: 'number', hint: 'e.g. 3' },
      { key: 'rollover_guard_enabled', label: 'Rollover Guard', type: 'select', options: ['true', 'false'] },
      { key: 'rollover_guard_block_new_orders', label: 'Rollover Blocks New Orders', type: 'select', options: ['true', 'false'] },
    ]
  },
  {
    title: 'KYC & Compliance',
    fields: [
      { key: 'support_response_sla_hours', label: 'Support/KYC Response SLA (hours)', type: 'number', hint: 'e.g. 24' },
      { key: 'dispute_submission_window_days', label: 'Dispute Submission Window (days)', type: 'number', hint: 'e.g. 7' },
      { key: 'support_ticket_categories', label: 'Ticket Categories', type: 'textarea', hint: 'Comma-separated categories shown in support forms' },
      { key: 'support_escalation_label', label: 'Escalation Label', type: 'text', hint: 'e.g. Escalated' },
    ]
  },
  {
    title: 'Automation & Safety',
    fields: [
      { key: 'inactivity_auto_fail_enabled', label: 'Inactivity Auto-Fail', type: 'select', hint: 'true = auto-fail inactive challenge accounts once they exceed the inactivity window.', options: ['true', 'false'] },
      { key: 'inactivity_fail_days', label: 'Inactivity Window (days)', type: 'number', hint: 'e.g. 30' },
    ]
  },
  {
    title: 'Challenge Checkout',
    fields: [
      { key: 'requires_payment', label: 'Requires Payment', type: 'select', options: ['true', 'false'], hint: 'true = traders must pay before challenge creation' },
      { key: 'challenge_checkout_mode', label: 'Checkout Mode', type: 'select', options: ['free', 'paid'] },
      { key: 'challenge_fee_amount', label: 'Challenge Fee Amount', type: 'number', hint: 'e.g. 99' },
      { key: 'challenge_fee_currency', label: 'Challenge Fee Currency', type: 'text', hint: 'e.g. USD' },
      { key: 'challenge_fee_label', label: 'Challenge Fee Label', type: 'text', hint: 'e.g. FREE / $99' },
    ]
  },
  {
    title: 'Trade Copier',
    fields: [
      { key: 'copier_enabled', label: 'Copier Enabled', type: 'select', options: ['true', 'false'] },
      { key: 'phase1_copy_mode', label: 'Phase 1 Copy Mode', type: 'select', options: ['reverse', 'mirror'], hint: 'Default reverse: master BUY becomes follower SELL' },
      { key: 'phase2_copy_mode', label: 'Phase 2 Copy Mode', type: 'select', options: ['reverse', 'mirror'], hint: 'Default reverse' },
      { key: 'funded_copy_mode', label: 'Funded Copy Mode', type: 'select', options: ['mirror', 'reverse'], hint: 'Default mirror: master BUY stays follower BUY' },
      { key: 'copier_lot_mode', label: 'Copier Lot Mode', type: 'select', options: ['master_lots_1_1'], hint: '1 lot master = 1 lot follower in this pass' },
      { key: 'copier_sync_sl_tp', label: 'Sync SL/TP Changes', type: 'select', options: ['true', 'false'] },
      { key: 'copier_sync_pending_orders', label: 'Sync Pending Orders', type: 'select', options: ['true', 'false'] },
      { key: 'copier_sync_partial_closes', label: 'Sync Partial Closes', type: 'select', options: ['true', 'false'] },
    ]
  },
  {
    title: 'Security & Payment Provider',
    fields: [
      { key: 'payment_provider', label: 'Payment Provider', type: 'select', options: ['', 'stripe'] },
      { key: 'payment_provider_public_key', label: 'Publishable Key', type: 'text' },
      { key: 'payment_provider_secret_key', label: 'Secret Key', type: 'text' },
      { key: 'payment_provider_webhook_secret', label: 'Webhook Secret', type: 'text' },
      { key: 'payment_provider_account_id', label: 'Stripe Account Id', type: 'text', hint: 'Optional for connected accounts' },
      { key: 'revenue_share_enabled', label: 'Revenue Share Enabled', type: 'select', options: ['true', 'false'] },
      { key: 'revenue_share_pct', label: 'Revenue Share %', type: 'number', hint: 'Platform share of tenant challenge revenue' },
    ]
  },
]

export default function AdminSettings() {
  const { adminAxios, session } = useOutletContext()
  const toast = useToast()
  const isSuperAdmin = session?.role === 'super_admin'

  const [values, setValues] = useState({})
  const [quotaTenantScope, setQuotaTenantScope] = useState('')
  const [quotaMonth, setQuotaMonth] = useState(currentMonth())
  const [quotaRows, setQuotaRows] = useState([])
  const [quotaDrafts, setQuotaDrafts] = useState({})
  const [quotaSavingSize, setQuotaSavingSize] = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  const getQuotaParams = useCallback(() => {
    const params = { month: `${quotaMonth || currentMonth()}-01` }
    if (isSuperAdmin && quotaTenantScope.trim()) params.tenant_id = quotaTenantScope.trim()
    return params
  }, [isSuperAdmin, quotaMonth, quotaTenantScope])

  const applyQuotaRows = useCallback((payload) => {
    const rows = Array.isArray(payload?.sizes) ? payload.sizes : []
    setQuotaRows(rows)
    setQuotaDrafts(rows.reduce((acc, row) => {
      acc[row.account_size || row.size] = {
        mode: row.is_unlimited ? 'unlimited' : 'limited',
        limit: row.account_limit != null ? String(row.account_limit) : ''
      }
      return acc
    }, {}))
  }, [])

  const loadMonthlyQuota = useCallback(async ({ silent = false } = {}) => {
    try {
      const response = await adminAxios.get('/api/admin/account-batches', {
        params: { ...getQuotaParams(), all_sizes: true }
      })
      applyQuotaRows(response.data || null)
    } catch (error) {
      if (!silent) toast.error(error?.response?.data?.error || 'Could not load monthly quota')
    }
  }, [adminAxios, applyQuotaRows, getQuotaParams, toast])

  const loadSettings = () => {
    setLoading(true)
    Promise.all([
      adminAxios.get('/api/admin/settings'),
      adminAxios.get('/api/admin/account-batches', { params: { ...getQuotaParams(), all_sizes: true } }).catch(() => ({ data: null }))
    ])
      .then(([settingsResponse, quotaResponse]) => {
        setValues(settingsResponse.data || {})
        applyQuotaRows(quotaResponse.data || null)
        setDirty(false)
      })
      .catch(() => toast.error('Could not load settings'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    loadSettings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (loading) return
    loadMonthlyQuota({ silent: true })
  }, [loading, loadMonthlyQuota])

  const updateQuotaDraft = (size, patch) => {
    setQuotaDrafts(current => ({
      ...current,
      [size]: {
        mode: 'unlimited',
        limit: '',
        ...(current[size] || {}),
        ...patch
      }
    }))
  }

  const handleSaveQuota = async (size) => {
    const draft = quotaDrafts[size] || { mode: 'unlimited', limit: '' }
    setQuotaSavingSize(size)
    try {
      const payload = {
        ...getQuotaParams(),
        quota_month: `${quotaMonth || currentMonth()}-01`,
        account_size: size,
        is_unlimited: draft.mode === 'unlimited',
        account_limit: draft.mode === 'unlimited' ? null : Number(draft.limit)
      }
      const response = await adminAxios.post('/api/admin/account-batches', payload)
      setQuotaRows(current => {
        const nextRow = response.data || null
        if (!nextRow) return current
        const found = current.some(row => Number(row.account_size) === Number(size))
        return found
          ? current.map(row => Number(row.account_size) === Number(size) ? nextRow : row)
          : [...current, nextRow]
      })
      toast.success(`${formatMoney(size)} monthly quota saved`)
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save monthly quota')
    } finally {
      setQuotaSavingSize(null)
    }
  }

  const handleChange = (key, value) => {
    setValues(current => ({ ...current, [key]: value }))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await adminAxios.post('/api/admin/settings', values)
      toast.success('Settings saved successfully')
      setDirty(false)
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not save settings')
    }
    setSaving(false)
  }

  if (loading) {
    return (
      <div style={{ padding: '40px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: '24px' }}>
        {Array(6).fill(0).map((_, index) => (
          <div key={index} className="admin-skeleton" style={{ height: '240px', borderRadius: '12px' }} />
        ))}
      </div>
    )
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '32px' }}>
        <div>
          <h1 className="admin-h1">Platform Settings</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Changes are audited and take effect immediately (30s cache on trading rules).
            Per-size monthly allocation resets automatically at the start of each calendar month.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          {dirty && (
            <span style={{ fontSize: '12px', color: 'var(--admin-warning)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--admin-warning)', display: 'inline-block' }} />
              Unsaved changes
            </span>
          )}
          <button className="admin-btn admin-btn-ghost" onClick={loadSettings}>Reset</button>
          <button className="admin-btn admin-btn-primary" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save All'}
          </button>
        </div>
      </div>

      <div className="admin-card" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 18 }}>
          <div>
            <h2 className="admin-h2">Per-Size Monthly Allocation</h2>
            <p style={{ color: 'var(--admin-text-muted)', fontSize: 13, marginTop: 6 }}>
              Each account size has its own monthly batch limit. Usage resets at the start of the next calendar month.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {isSuperAdmin && (
              <input
                className="admin-input"
                style={{ width: 140 }}
                placeholder="Tenant ID"
                value={quotaTenantScope}
                onChange={(event) => setQuotaTenantScope(event.target.value)}
              />
            )}
            <input
              className="admin-input"
              style={{ width: 150 }}
              type="month"
              value={quotaMonth}
              onChange={(event) => setQuotaMonth(event.target.value || currentMonth())}
            />
            <button className="admin-btn admin-btn-ghost" onClick={() => loadMonthlyQuota()}>Refresh</button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          {ACCOUNT_SIZES.map((size) => {
            const row = quotaRows.find((item) => Number(item.account_size) === Number(size)) || {}
            const draft = quotaDrafts[size] || {
              mode: row.is_unlimited === false ? 'limited' : 'unlimited',
              limit: row.account_limit != null ? String(row.account_limit) : ''
            }
            const savingThisSize = quotaSavingSize === size
            return (
              <div key={size} style={{ border: '1px solid var(--admin-border)', borderRadius: 14, padding: 14, background: 'var(--admin-bg-elevated)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <div style={{ color: 'var(--admin-text)', fontSize: 18, fontWeight: 800, fontFamily: 'var(--font-mono)' }}>{formatMoney(size)}</div>
                    <div style={{ color: 'var(--admin-text-muted)', fontSize: 12, marginTop: 4 }}>
                      Used {row.used ?? 0} / {row.is_unlimited ? 'Unlimited' : row.account_limit ?? 0}
                    </div>
                  </div>
                  <span className={`admin-badge ${row.state === 'full' ? 'admin-badge-danger' : row.state === 'near_limit' ? 'admin-badge-warning' : 'admin-badge-success'}`}>
                    {row.state ? String(row.state).replace('_', ' ').toUpperCase() : 'UNLIMITED'}
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Remaining</div>
                    <div style={{ color: 'var(--admin-text)', fontWeight: 800, fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                      {row.is_unlimited ? 'Unlimited' : row.remaining ?? 0}
                    </div>
                  </div>
                  <div>
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em' }}>Month</div>
                    <div style={{ color: 'var(--admin-text)', fontWeight: 800, fontFamily: 'var(--font-mono)', marginTop: 4 }}>
                      {row.quota_month || `${quotaMonth}-01`}
                    </div>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'end' }}>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">Mode</label>
                    <select className="admin-select" value={draft.mode} onChange={(event) => updateQuotaDraft(size, { mode: event.target.value })}>
                      <option value="unlimited">Unlimited</option>
                      <option value="limited">Monthly quota</option>
                    </select>
                  </div>
                  <div className="admin-form-group" style={{ marginBottom: 0 }}>
                    <label className="admin-label">Limit</label>
                    <input
                      className="admin-input"
                      type="number"
                      min="0"
                      disabled={draft.mode === 'unlimited'}
                      value={draft.limit}
                      onChange={(event) => updateQuotaDraft(size, { limit: event.target.value })}
                      placeholder="0 = unavailable"
                    />
                  </div>
                </div>
                <button
                  className="admin-btn admin-btn-primary"
                  style={{ width: '100%', marginTop: 12 }}
                  onClick={() => handleSaveQuota(size)}
                  disabled={savingThisSize}
                >
                  {savingThisSize ? 'Saving...' : `Save ${formatMoney(size)} Quota`}
                </button>
              </div>
            )
          })}
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
                    onChange={event => handleChange(field.key, event.target.value)}
                  >
                    <option value="">- not set -</option>
                    {field.options.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                ) : field.type === 'textarea' ? (
                  <textarea
                    className="admin-input"
                    value={values[field.key] ?? ''}
                    onChange={event => handleChange(field.key, event.target.value)}
                    placeholder={field.hint || ''}
                    rows={3}
                    style={{
                      minHeight: 88,
                      resize: 'vertical',
                      borderColor: dirty && values[field.key] !== undefined ? 'var(--admin-accent)' : undefined,
                      colorScheme: 'dark'
                    }}
                  />
                ) : (
                  <input
                    type={field.type}
                    className="admin-input"
                    value={values[field.key] ?? ''}
                    onChange={event => handleChange(field.key, event.target.value)}
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
  )
}
