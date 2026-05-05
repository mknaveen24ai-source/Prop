import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { useToast } from '../../components/admin/AdminToast'

const EMPTY_FORM = {
  id: null,
  slug: '',
  name: '',
  status: 'active',
  primary_domain: '',
  logo_text: '',
  logo_url: '',
  support_email: '',
  email_from_name: '',
  short_name: '',
  tagline: '',
  hero_title: '',
  hero_subtitle: '',
  primary_color: '#2563eb',
  accent_color: '#0ea5e9',
  domains: '',
  requires_payment: 'false',
  challenge_checkout_mode: 'free',
  challenge_fee_amount: '0',
  challenge_fee_currency: 'USD',
  challenge_fee_label: 'FREE',
  marketing_mode: 'free',
  payment_provider: '',
  payment_provider_public_key: '',
  payment_provider_secret_key: '',
  payment_provider_webhook_secret: '',
  payment_provider_account_id: '',
  billing_email: '',
  subscription_plan_code: 'starter',
  revenue_share_enabled: 'false',
  revenue_share_pct: '0',
  clear_payment_provider_secret_key: false,
  clear_payment_provider_webhook_secret: false,
  has_payment_provider_secret_key: false,
  has_payment_provider_webhook_secret: false,
  feed_name: 'default',
  feed_mode: 'shared',
  feed_source_key: '',
  feed_source_name: '',
  feed_dwx_path: '',
  feed_fallback_to_shared: 'true',
  has_feed_dwx_path: false,
  clear_feed_dwx_path: false,
  admin_email: '',
  admin_password: '',
  admin_full_name: ''
}

function mapTenantToForm(tenant) {
  const settings = tenant.settings || tenant.settings_json || {}
  const feed = tenant.price_feed || {}

  return {
    ...EMPTY_FORM,
    id: tenant.id,
    slug: tenant.slug || '',
    name: tenant.name || '',
    status: tenant.status || 'active',
    primary_domain: tenant.primary_domain || '',
    logo_text: tenant.logo_text || '',
    logo_url: tenant.logo_url || '',
    support_email: tenant.support_email || '',
    email_from_name: tenant.email_from_name || '',
    short_name: tenant.brand_json?.short_name || '',
    tagline: tenant.brand_json?.tagline || '',
    hero_title: tenant.brand_json?.hero_title || '',
    hero_subtitle: tenant.brand_json?.hero_subtitle || '',
    primary_color: tenant.brand_json?.primary_color || '#2563eb',
    accent_color: tenant.brand_json?.accent_color || '#0ea5e9',
    domains: Array.isArray(tenant.domains) ? tenant.domains.join('\n') : '',
    requires_payment: settings.requires_payment || 'false',
    challenge_checkout_mode: settings.challenge_checkout_mode || 'free',
    challenge_fee_amount: settings.challenge_fee_amount || '0',
    challenge_fee_currency: settings.challenge_fee_currency || 'USD',
    challenge_fee_label: settings.challenge_fee_label || 'FREE',
    marketing_mode: settings.marketing_mode || 'free',
    payment_provider: settings.payment_provider || '',
    payment_provider_public_key: settings.payment_provider_public_key || '',
    payment_provider_account_id: settings.payment_provider_account_id || '',
    billing_email: settings.billing_email || '',
    subscription_plan_code: settings.subscription_plan_code || 'starter',
    revenue_share_enabled: settings.revenue_share_enabled || 'false',
    revenue_share_pct: settings.revenue_share_pct || '0',
    has_payment_provider_secret_key: settings.has_payment_provider_secret_key === true,
    has_payment_provider_webhook_secret: settings.has_payment_provider_webhook_secret === true,
    feed_name: feed.feed_name || 'default',
    feed_mode: feed.feed_mode || 'shared',
    feed_source_key: feed.source_key || '',
    feed_source_name: feed.source_name || '',
    feed_fallback_to_shared: feed.fallback_to_shared === false ? 'false' : 'true',
    has_feed_dwx_path: feed.has_dwx_path === true,
    admin_email: tenant.admin_email || '',
    admin_full_name: tenant.admin_full_name || ''
  }
}

function buildSavePayload(form) {
  const payload = {
    ...form,
    clear_payment_provider_secret_key: form.clear_payment_provider_secret_key,
    clear_payment_provider_webhook_secret: form.clear_payment_provider_webhook_secret,
    clear_feed_dwx_path: form.clear_feed_dwx_path
  }

  delete payload.has_payment_provider_secret_key
  delete payload.has_payment_provider_webhook_secret
  delete payload.has_feed_dwx_path

  if (!String(payload.payment_provider_secret_key || '').trim()) {
    delete payload.payment_provider_secret_key
  }
  if (!String(payload.payment_provider_webhook_secret || '').trim()) {
    delete payload.payment_provider_webhook_secret
  }
  if (!String(payload.feed_dwx_path || '').trim()) {
    delete payload.feed_dwx_path
  }
  if (!payload.clear_payment_provider_secret_key) {
    delete payload.clear_payment_provider_secret_key
  }
  if (!payload.clear_payment_provider_webhook_secret) {
    delete payload.clear_payment_provider_webhook_secret
  }
  if (!payload.clear_feed_dwx_path) {
    delete payload.clear_feed_dwx_path
  }

  return payload
}

export default function AdminTenants() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()
  const [tenants, setTenants] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const selectedTenant = useMemo(
    () => tenants.find((tenant) => String(tenant.id) === String(selectedId)) || null,
    [tenants, selectedId]
  )

  const loadTenants = useCallback(() => {
    setLoading(true)
    adminAxios.get('/api/admin/tenants')
      .then((response) => {
        const rows = Array.isArray(response.data) ? response.data : []
        setTenants(rows)
        if (rows.length > 0) {
          setSelectedId((currentSelectedId) => {
            const next = rows.find((row) => String(row.id) === String(currentSelectedId)) || rows[0]
            setForm(mapTenantToForm(next))
            return next.id
          })
        } else {
          setSelectedId(null)
          setForm(EMPTY_FORM)
        }
      })
      .catch((error) => {
        toast.error(error?.response?.data?.error || 'Could not load tenants')
      })
      .finally(() => setLoading(false))
  }, [adminAxios, toast])

  useEffect(() => {
    loadTenants()
  }, [loadTenants])

  const selectTenant = (tenant) => {
    setSelectedId(tenant.id)
    setForm(mapTenantToForm(tenant))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const payload = buildSavePayload(form)
      if (form.id) {
        await adminAxios.patch(`/api/admin/tenants/${form.id}`, payload)
        toast.success('Tenant updated')
      } else {
        await adminAxios.post('/api/admin/tenants', payload)
        toast.success('Tenant created')
      }
      loadTenants()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Could not save tenant')
    } finally {
      setSaving(false)
    }
  }

  const setField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px' }}>
        <div>
          <h1 className="admin-h1">White Label</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
            Create tenant brands with isolated billing, branding, and feed configuration.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button className="admin-btn admin-btn-ghost" onClick={loadTenants}>Refresh</button>
          <button
            className="admin-btn admin-btn-primary"
            onClick={() => {
              setSelectedId('new')
              setForm(EMPTY_FORM)
            }}
          >
            New Tenant
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '360px minmax(0, 1fr)', gap: '24px' }}>
        <div className="admin-card" style={{ padding: '18px' }}>
          <h3 className="admin-h3" style={{ marginBottom: '14px' }}>Tenants</h3>
          {loading ? (
            <div className="admin-skeleton" style={{ height: '320px', borderRadius: '12px' }} />
          ) : (
            <div style={{ display: 'grid', gap: '12px' }}>
              {tenants.map((tenant) => (
                <button
                  key={tenant.id}
                  className="admin-btn-ghost"
                  onClick={() => selectTenant(tenant)}
                  style={{
                    textAlign: 'left',
                    padding: '14px',
                    border: String(selectedId) === String(tenant.id) ? '1px solid var(--admin-accent)' : '1px solid var(--admin-border)',
                    borderRadius: '12px',
                    background: String(selectedId) === String(tenant.id) ? 'var(--admin-accent-bg)' : 'var(--admin-surface)',
                    cursor: 'pointer'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '6px' }}>
                    <strong style={{ color: 'var(--admin-text)' }}>{tenant.name}</strong>
                    <span style={{ color: tenant.status === 'active' ? 'var(--admin-success)' : 'var(--admin-warning)', fontSize: '12px', textTransform: 'capitalize' }}>
                      {tenant.status}
                    </span>
                  </div>
                  <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px', marginBottom: '6px' }}>{tenant.slug}</div>
                  <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px' }}>
                    {tenant.user_count || 0} traders • {tenant.account_count || 0} accounts
                  </div>
                  {tenant.operational_state && (
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginTop: '6px', lineHeight: 1.5 }}>
                      Billing: {tenant.operational_state.subscription_status || 'n/a'} {'\u2022'} Feed: {tenant.operational_state.feed_health?.status || 'unknown'} {'\u2022'} Domains: {tenant.operational_state.domain_summary?.verified_count || 0}/{tenant.operational_state.domain_summary?.total || 0} verified
                    </div>
                  )}
                  {tenant.primary_domain && (
                    <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginTop: '6px' }}>{tenant.primary_domain}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="admin-card" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '18px' }}>
            <div>
              <h3 className="admin-h3" style={{ marginBottom: '6px' }}>
                {form.id ? 'Tenant Details' : 'Create Tenant'}
              </h3>
              <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
                Use `/?tenant={form.slug || 'slug'}` locally to preview branding before domain cutover.
              </p>
            </div>
            {selectedTenant?.slug && (
              <a
                href={`/?tenant=${selectedTenant.slug}`}
                target="_blank"
                rel="noreferrer"
                className="admin-btn admin-btn-ghost"
                style={{ textDecoration: 'none' }}
              >
                Preview
              </a>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '16px' }}>
            {selectedTenant?.operational_state && (
              <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
                <label className="admin-label">Operational State</label>
                <div
                  style={{
                    border: '1px solid var(--admin-border)',
                    borderRadius: '12px',
                    padding: '14px',
                    background: 'var(--admin-surface-2, rgba(255,255,255,0.02))',
                    display: 'grid',
                    gap: '8px',
                    fontSize: '13px'
                  }}
                >
                  <div style={{ color: 'var(--admin-text)' }}>
                    Subscription: <strong>{selectedTenant.operational_state.subscription_status || 'n/a'}</strong>
                    {selectedTenant.operational_state.grace_until ? ` until ${new Date(selectedTenant.operational_state.grace_until).toLocaleString()}` : ''}
                  </div>
                  <div style={{ color: 'var(--admin-text)' }}>
                    Payment Provider: <strong>{selectedTenant.operational_state.payment_provider_configured ? 'configured' : 'not configured'}</strong>
                  </div>
                  <div style={{ color: 'var(--admin-text)' }}>
                    Feed: <strong>{selectedTenant.operational_state.feed_health?.status || 'unknown'}</strong>
                    {selectedTenant.operational_state.feed_health?.message ? ` • ${selectedTenant.operational_state.feed_health.message}` : ''}
                  </div>
                  <div style={{ color: 'var(--admin-text-muted)' }}>
                    Mode: {selectedTenant.operational_state.feed_health?.feed_mode || 'shared'} → {selectedTenant.operational_state.feed_health?.effective_feed_mode || 'shared'} • Symbols: {selectedTenant.operational_state.feed_health?.healthy_symbol_count || 0}/{selectedTenant.operational_state.feed_health?.symbol_count || 0}
                  </div>
                  {Array.isArray(selectedTenant.operational_state.feed_health?.missing_launch_instruments) && selectedTenant.operational_state.feed_health.missing_launch_instruments.length > 0 && (
                    <div style={{ color: 'var(--admin-warning)' }}>
                      Missing launch instruments: {selectedTenant.operational_state.feed_health.missing_launch_instruments.join(', ')}
                    </div>
                  )}
                  <div style={{ color: 'var(--admin-text)' }}>
                    Domains: <strong>{selectedTenant.operational_state.domain_summary?.verified_count || 0}/{selectedTenant.operational_state.domain_summary?.total || 0} verified</strong>
                    {' • '}SSL active: <strong>{selectedTenant.operational_state.domain_summary?.active_ssl_count || 0}</strong>
                  </div>
                </div>
              </div>
            )}
            {[
              ['name', 'Tenant Name'],
              ['slug', 'Slug'],
              ['status', 'Status'],
              ['primary_domain', 'Primary Domain'],
              ['logo_text', 'Logo Text'],
              ['logo_url', 'Logo URL'],
              ['support_email', 'Support Email'],
              ['email_from_name', 'Email Sender Name'],
              ['short_name', 'Short Name'],
              ['tagline', 'Tagline'],
              ['hero_title', 'Hero Title'],
              ['hero_subtitle', 'Hero Subtitle'],
              ['primary_color', 'Primary Color'],
              ['accent_color', 'Accent Color']
            ].map(([key, label]) => (
              <div key={key} className="admin-form-group" style={{ gridColumn: key === 'hero_subtitle' ? '1 / -1' : undefined }}>
                <label className="admin-label">{label}</label>
                {key === 'status' ? (
                  <select className="admin-select" value={form[key]} onChange={(event) => setField(key, event.target.value)}>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="pending">pending</option>
                    <option value="suspended">suspended</option>
                  </select>
                ) : (
                  <input
                    className="admin-input"
                    type={key.includes('color') ? 'color' : 'text'}
                    value={form[key]}
                    onChange={(event) => setField(key, event.target.value)}
                  />
                )}
              </div>
            ))}

            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Extra Domains</label>
              <textarea
                className="admin-input"
                value={form.domains}
                onChange={(event) => setField('domains', event.target.value)}
                rows={5}
                placeholder="one hostname per line"
                style={{ resize: 'vertical', minHeight: '120px' }}
              />
            </div>
            {Array.isArray(selectedTenant?.domain_records) && selectedTenant.domain_records.length > 0 && (
              <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
                <label className="admin-label">Managed Domain Status</label>
                <div style={{ display: 'grid', gap: '8px' }}>
                  {selectedTenant.domain_records.map((domain) => (
                    <div
                      key={domain.id || domain.hostname}
                      style={{
                        border: '1px solid var(--admin-border)',
                        borderRadius: '10px',
                        padding: '10px 12px',
                        background: 'var(--admin-surface-2, rgba(255,255,255,0.02))'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '4px' }}>
                        <strong style={{ color: 'var(--admin-text)' }}>{domain.hostname}</strong>
                        <span style={{ color: domain.is_primary ? 'var(--admin-success)' : 'var(--admin-text-faint)', fontSize: '12px' }}>
                          {domain.is_primary ? 'primary' : domain.domain_type}
                        </span>
                      </div>
                      <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>
                        Verification: {domain.verification_status} • SSL: {domain.ssl_status}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="admin-form-group">
              <label className="admin-label">Requires Payment</label>
              <select className="admin-select" value={form.requires_payment} onChange={(event) => setField('requires_payment', event.target.value)}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Checkout Mode</label>
              <select className="admin-select" value={form.challenge_checkout_mode} onChange={(event) => setField('challenge_checkout_mode', event.target.value)}>
                <option value="free">free</option>
                <option value="paid">paid</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Challenge Fee Amount</label>
              <input className="admin-input" type="number" min="0" step="0.01" value={form.challenge_fee_amount} onChange={(event) => setField('challenge_fee_amount', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Challenge Fee Currency</label>
              <input className="admin-input" value={form.challenge_fee_currency} onChange={(event) => setField('challenge_fee_currency', event.target.value.toUpperCase())} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Challenge Fee Label</label>
              <input className="admin-input" value={form.challenge_fee_label} onChange={(event) => setField('challenge_fee_label', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Marketing Mode</label>
              <select className="admin-select" value={form.marketing_mode} onChange={(event) => setField('marketing_mode', event.target.value)}>
                <option value="free">free</option>
                <option value="paid">paid</option>
                <option value="hybrid">hybrid</option>
              </select>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Payment Provider</label>
              <select className="admin-select" value={form.payment_provider} onChange={(event) => setField('payment_provider', event.target.value)}>
                <option value="">none</option>
                <option value="stripe">stripe</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Billing Email</label>
              <input className="admin-input" type="email" value={form.billing_email} onChange={(event) => setField('billing_email', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Subscription Plan</label>
              <select className="admin-select" value={form.subscription_plan_code} onChange={(event) => setField('subscription_plan_code', event.target.value)}>
                <option value="starter">starter</option>
                <option value="growth">growth</option>
                <option value="enterprise">enterprise</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Revenue Share Enabled</label>
              <select className="admin-select" value={form.revenue_share_enabled} onChange={(event) => setField('revenue_share_enabled', event.target.value)}>
                <option value="false">false</option>
                <option value="true">true</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Revenue Share %</label>
              <input className="admin-input" type="number" min="0" step="0.01" value={form.revenue_share_pct} onChange={(event) => setField('revenue_share_pct', event.target.value)} />
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Stripe Publishable Key</label>
              <input className="admin-input" value={form.payment_provider_public_key} onChange={(event) => setField('payment_provider_public_key', event.target.value)} />
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Stripe Secret Key</label>
              <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginBottom: '8px' }}>
                {form.has_payment_provider_secret_key ? 'Configured in backend. Leave blank to keep current value.' : 'Not configured yet.'}
              </div>
              <input className="admin-input" type="password" value={form.payment_provider_secret_key} onChange={(event) => setField('payment_provider_secret_key', event.target.value)} placeholder={form.id ? 'Leave blank to keep current secret' : ''} />
              <label style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--admin-text-muted)' }}>
                <input type="checkbox" checked={form.clear_payment_provider_secret_key} onChange={(event) => setField('clear_payment_provider_secret_key', event.target.checked)} />
                Clear stored secret key
              </label>
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Stripe Webhook Secret</label>
              <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginBottom: '8px' }}>
                {form.has_payment_provider_webhook_secret ? 'Configured in backend. Leave blank to keep current value.' : 'Not configured yet.'}
              </div>
              <input className="admin-input" type="password" value={form.payment_provider_webhook_secret} onChange={(event) => setField('payment_provider_webhook_secret', event.target.value)} placeholder={form.id ? 'Leave blank to keep current secret' : ''} />
              <label style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--admin-text-muted)' }}>
                <input type="checkbox" checked={form.clear_payment_provider_webhook_secret} onChange={(event) => setField('clear_payment_provider_webhook_secret', event.target.checked)} />
                Clear stored webhook secret
              </label>
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Stripe Account Id</label>
              <input className="admin-input" value={form.payment_provider_account_id} onChange={(event) => setField('payment_provider_account_id', event.target.value)} />
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Feed Name</label>
              <input className="admin-input" value={form.feed_name} onChange={(event) => setField('feed_name', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Feed Mode</label>
              <select className="admin-select" value={form.feed_mode} onChange={(event) => setField('feed_mode', event.target.value)}>
                <option value="shared">shared</option>
                <option value="dedicated">dedicated</option>
              </select>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Feed Source Key</label>
              <input className="admin-input" value={form.feed_source_key} onChange={(event) => setField('feed_source_key', event.target.value.toLowerCase())} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Feed Source Name</label>
              <input className="admin-input" value={form.feed_source_name} onChange={(event) => setField('feed_source_name', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Shared Fallback</label>
              <select className="admin-select" value={form.feed_fallback_to_shared} onChange={(event) => setField('feed_fallback_to_shared', event.target.value)}>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Dedicated Feed DWX Path</label>
              <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px', marginBottom: '8px' }}>
                {form.has_feed_dwx_path ? 'Configured in backend. Leave blank to keep current path.' : 'Not configured yet.'}
              </div>
              <input className="admin-input" value={form.feed_dwx_path} onChange={(event) => setField('feed_dwx_path', event.target.value)} placeholder={form.id ? 'Leave blank to keep current path' : 'E:\\path\\to\\DWX'} />
              <label style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--admin-text-muted)' }}>
                <input type="checkbox" checked={form.clear_feed_dwx_path} onChange={(event) => setField('clear_feed_dwx_path', event.target.checked)} />
                Clear stored DWX path
              </label>
            </div>

            <div className="admin-form-group">
              <label className="admin-label">Tenant Admin Email</label>
              <input className="admin-input" type="email" value={form.admin_email} onChange={(event) => setField('admin_email', event.target.value)} />
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Tenant Admin Name</label>
              <input className="admin-input" value={form.admin_full_name} onChange={(event) => setField('admin_full_name', event.target.value)} />
            </div>
            <div className="admin-form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="admin-label">Tenant Admin Password</label>
              <input className="admin-input" type="password" value={form.admin_password} onChange={(event) => setField('admin_password', event.target.value)} placeholder={form.id ? 'Leave blank to keep current password' : ''} />
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px' }}>
            <div style={{ color: 'var(--admin-text-faint)', fontSize: '12px' }}>
              Tenant secrets stay write-only. Read APIs only return configured/not-configured flags.
            </div>
            <button className="admin-btn admin-btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving...' : form.id ? 'Save Tenant' : 'Create Tenant'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
