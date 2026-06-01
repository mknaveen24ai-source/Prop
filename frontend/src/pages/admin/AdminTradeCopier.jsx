import React, { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AdminBadge from '../../components/admin/AdminBadge'
import AdminDataTable from '../../components/admin/AdminDataTable'
import AdminStatCard from '../../components/admin/AdminStatCard'
import { useToast } from '../../components/admin/AdminToast'

const TABS = [
  ['overview', 'Overview'],
  ['activeAccounts', 'Active Accounts'],
  ['masters', 'Masters'],
  ['followers', 'Followers'],
  ['mappings', 'Mappings'],
  ['symbols', 'Symbol Maps'],
  ['queue', 'Queue'],
  ['reconciliation', 'Reconciliation']
]

const COPY_MODE_OPTIONS = ['mirror', 'reverse']
const RISK_MODE_OPTIONS = ['fixed_lots', 'balance_ratio', 'equity_ratio', 'risk_percent']
const MASTER_TYPE_OPTIONS = ['phase1', 'phase2', 'funded']
const RESYNC_ACTIONS = [
  'resync position',
  'resync pending',
  'sync sl/tp',
  'requeue last actionable event',
  'flatten orphan follower position'
]

function formatDateTime(value) {
  if (!value) return 'N/A'
  return new Date(value).toLocaleString()
}

function formatNumber(value, digits = 2) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : 'N/A'
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function SectionCard({ title, children, actions = null }) {
  return (
    <div className="admin-card" style={{ marginBottom: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 className="admin-h2" style={{ margin: 0 }}>{title}</h2>
        {actions}
      </div>
      {children}
    </div>
  )
}

function FormGrid({ children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
      {children}
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div className="admin-form-group">
      <label className="admin-label">{label}</label>
      {children}
    </div>
  )
}

export default function AdminTradeCopier() {
  const { adminAxios } = useOutletContext()
  const toast = useToast()

  const [activeTab, setActiveTab] = useState('overview')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [tenantScope, setTenantScope] = useState('')
  const [data, setData] = useState({
    health: null,
    activeAccounts: [],
    masters: [],
    followers: [],
    mappings: [],
    symbolMappings: [],
    jobs: [],
    deadLetters: [],
    reconciliation: []
  })

  const [masterForm, setMasterForm] = useState({ account_id: '', label: '' })
  const [followerForm, setFollowerForm] = useState({
    display_name: '',
    bridge_target_key: '',
    status: 'active',
    copy_mode: 'mirror',
    risk_mode: 'fixed_lots',
    fixed_lots: '0.10',
    ratio_multiplier: '1',
    risk_percent: '',
    symbol_allowlist: '',
    max_slippage_points: '',
    max_spread_points: ''
  })
  const [mappingForm, setMappingForm] = useState({
    master_id: '',
    follower_id: '',
    copy_mode_override: '',
    allowed_master_account_types: 'phase1,phase2,funded',
    symbol_allowlist: ''
  })
  const [symbolForm, setSymbolForm] = useState({
    follower_id: '',
    master_symbol: '',
    follower_symbol: ''
  })
  const [resyncForm, setResyncForm] = useState({
    follower_id: '',
    master_trade_id: '',
    action: 'resync position',
    external_ticket: '',
    instrument: ''
  })

  const scopeParams = useMemo(() => {
    const params = {}
    if (tenantScope.trim()) {
      params.tenant_id = tenantScope.trim()
    }
    return params
  }, [tenantScope])

  async function fetchAll() {
    setLoading(true)
    try {
      const [
        healthRes,
        activeAccountsRes,
        mastersRes,
        followersRes,
        mappingsRes,
        symbolMappingsRes,
        jobsRes,
        deadLettersRes,
        reconciliationRes
      ] = await Promise.all([
        adminAxios.get('/api/admin/copier/health', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/active-accounts', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/masters', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/followers', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/mappings', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/symbol-mappings', { params: scopeParams }),
        adminAxios.get('/api/admin/copier/jobs', { params: { ...scopeParams, limit: 100 } }),
        adminAxios.get('/api/admin/copier/dead-letters', { params: { ...scopeParams, limit: 100 } }),
        adminAxios.get('/api/admin/copier/reconciliation', { params: scopeParams })
      ])

      setData({
        health: healthRes.data || null,
        activeAccounts: Array.isArray(activeAccountsRes.data) ? activeAccountsRes.data : [],
        masters: Array.isArray(mastersRes.data) ? mastersRes.data : [],
        followers: Array.isArray(followersRes.data) ? followersRes.data : [],
        mappings: Array.isArray(mappingsRes.data) ? mappingsRes.data : [],
        symbolMappings: Array.isArray(symbolMappingsRes.data) ? symbolMappingsRes.data : [],
        jobs: Array.isArray(jobsRes.data) ? jobsRes.data : [],
        deadLetters: Array.isArray(deadLettersRes.data) ? deadLettersRes.data : [],
        reconciliation: Array.isArray(reconciliationRes.data?.rows) ? reconciliationRes.data.rows : []
      })
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Failed to load copier v2 data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantScope])

  async function runAction(action, successMessage) {
    setSaving(true)
    try {
      await action()
      toast.success(successMessage)
      await fetchAll()
    } catch (error) {
      toast.error(error?.response?.data?.error || 'Action failed')
    } finally {
      setSaving(false)
    }
  }

  const withTenantBody = (body) => (
    tenantScope.trim() ? { ...body, tenant_id: tenantScope.trim() } : body
  )

  const health = data.health || {}
  const runtime = health.runtime || {}
  const totals = health.totals || {}

  const mastersColumns = [
    { header: 'ID', key: 'id', isMono: true },
    { header: 'Account ID', key: 'account_id', isMono: true },
    { header: 'Label', key: 'label', render: (row) => row.label || 'N/A' },
    { header: 'Account Type', key: 'account_type', render: (row) => <AdminBadge status="info" label={row.account_type || 'N/A'} /> },
    { header: 'Trader', key: 'user_email', render: (row) => row.user_email || 'N/A' },
    { header: 'Status', key: 'is_enabled', render: (row) => <AdminBadge status={row.is_enabled ? 'success' : 'danger'} label={row.is_enabled ? 'ENABLED' : 'DISABLED'} /> }
  ]

  const activeAccountColumns = [
    { header: 'Account', key: 'id', isMono: true, render: (row) => (
      <div>
        <div>#{row.id}</div>
        <div style={{ color: 'var(--admin-text-faint)', fontSize: 11 }}>{row.account_uid || 'No UID'}</div>
      </div>
    ) },
    { header: 'Trader', key: 'user_email', render: (row) => (
      <div>
        <div>{row.user_full_name || 'Unnamed Trader'}</div>
        <div style={{ color: 'var(--admin-text-faint)', fontSize: 11 }}>{row.user_email || row.user_id}</div>
      </div>
    ) },
    { header: 'Type', key: 'account_type', render: (row) => <AdminBadge status="info" label={String(row.account_type || '').toUpperCase()} /> },
    { header: 'Size', key: 'account_size', isMono: true, render: (row) => `$${Number(row.account_size || 0).toLocaleString()}` },
    { header: 'Balance', key: 'current_balance', isMono: true, render: (row) => `$${formatNumber(row.current_balance)}` },
    { header: 'Open/Pending', key: 'trade_counts', isMono: true, render: (row) => `${row.open_trade_count || 0}/${row.pending_trade_count || 0}` },
    { header: 'Copier Master', key: 'copier_master_enabled', render: (row) => row.copier_master_id ? <AdminBadge status={row.copier_master_enabled ? 'success' : 'warning'} label={row.copier_master_enabled ? 'ENABLED' : 'DISABLED'} /> : 'No' },
    { header: 'Created', key: 'created_at', render: (row) => formatDateTime(row.created_at) }
  ]

  const followersColumns = [
    { header: 'ID', key: 'id', isMono: true },
    { header: 'Follower', key: 'display_name' },
    { header: 'Bridge Target', key: 'bridge_target_key', isMono: true },
    { header: 'Status', key: 'status', render: (row) => <AdminBadge status={row.status === 'active' ? 'success' : row.status === 'paused' ? 'warning' : 'danger'} label={String(row.status || '').toUpperCase()} /> },
    { header: 'Copy Mode', key: 'copy_mode', render: (row) => <AdminBadge status={row.copy_mode === 'mirror' ? 'info' : 'warning'} label={String(row.copy_mode || '').toUpperCase()} /> },
    { header: 'Risk Mode', key: 'risk_mode' },
    { header: 'Last Equity', key: 'last_equity', isMono: true, render: (row) => formatNumber(row.last_equity) },
    { header: 'Last Snapshot', key: 'last_snapshot_at', render: (row) => formatDateTime(row.last_snapshot_at) }
  ]

  const mappingsColumns = [
    { header: 'ID', key: 'id', isMono: true },
    { header: 'Master', key: 'master_label', render: (row) => `${row.master_label || 'Master'} (#${row.master_id})` },
    { header: 'Follower', key: 'follower_display_name', render: (row) => `${row.follower_display_name || 'Follower'} (#${row.follower_id})` },
    { header: 'Mode Override', key: 'copy_mode_override', render: (row) => row.copy_mode_override ? <AdminBadge status="warning" label={row.copy_mode_override.toUpperCase()} /> : 'Default' },
    { header: 'Allowed Types', key: 'allowed_master_account_types', render: (row) => (row.allowed_master_account_types || []).join(', ') || 'All' },
    { header: 'Status', key: 'is_enabled', render: (row) => <AdminBadge status={row.is_enabled ? 'success' : 'danger'} label={row.is_enabled ? 'ENABLED' : 'DISABLED'} /> }
  ]

  const symbolColumns = [
    { header: 'ID', key: 'id', isMono: true },
    { header: 'Follower', key: 'follower_display_name' },
    { header: 'Master Symbol', key: 'master_symbol', isMono: true },
    { header: 'Follower Symbol', key: 'follower_symbol', isMono: true },
    { header: 'Status', key: 'is_enabled', render: (row) => <AdminBadge status={row.is_enabled ? 'success' : 'danger'} label={row.is_enabled ? 'ENABLED' : 'DISABLED'} /> }
  ]

  const jobsColumns = [
    { header: 'Job', key: 'id', isMono: true },
    { header: 'State', key: 'state', render: (row) => <AdminBadge status={row.state === 'acknowledged' ? 'success' : row.state === 'dead' ? 'danger' : row.state === 'retry' ? 'warning' : 'info'} label={String(row.state || '').toUpperCase()} /> },
    { header: 'Event', key: 'event_type' },
    { header: 'Master Trade', key: 'master_trade_id', isMono: true },
    { header: 'Follower', key: 'follower_display_name' },
    { header: 'Attempts', key: 'attempts_count', isMono: true },
    { header: 'Updated', key: 'updated_at', render: (row) => formatDateTime(row.updated_at) },
    { header: 'Error', key: 'last_error', render: (row) => row.last_error || 'N/A' }
  ]

  const reconciliationColumns = [
    { header: 'Type', key: 'type', render: (row) => <AdminBadge status={row.type?.includes('missing') || row.type?.includes('orphan') ? 'danger' : 'warning'} label={String(row.type || '').toUpperCase()} /> },
    { header: 'Follower', key: 'follower_display_name' },
    { header: 'Master Trade', key: 'master_trade_id', isMono: true, render: (row) => row.master_trade_id || 'N/A' },
    { header: 'Detail', key: 'detail' }
  ]

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '24px', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h1 className="admin-h1">Trade Copier v2</h1>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px', maxWidth: '860px' }}>
            Tenant-scoped multi-master and multi-follower copier with outbox events, per-follower routing, health metrics, dead letters, and reconciliation tools.
          </p>
        </div>
        <div style={{ minWidth: '220px' }}>
          <Field label="Tenant Scope">
            <input
              className="admin-input"
              placeholder="Blank = current tenant"
              value={tenantScope}
              onChange={(event) => setTenantScope(event.target.value)}
            />
          </Field>
          <button className="admin-btn admin-btn-ghost" onClick={fetchAll}>Refresh</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '24px' }}>
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={`admin-btn ${activeTab === key ? 'admin-btn-primary' : 'admin-btn-ghost'}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '24px' }}>
            <AdminStatCard icon="copier" label="Worker" value={runtime.running ? 'ONLINE' : 'OFFLINE'} trendDirection={runtime.running ? 'up' : 'down'} />
            <AdminStatCard icon="activity" label="Bridge" value={runtime.socket_ready ? 'CONNECTED' : 'DISCONNECTED'} trendDirection={runtime.socket_ready ? 'up' : 'down'} />
            <AdminStatCard icon="repeat" label="Queue Depth" value={String(runtime.queue_depth || 0)} />
            <AdminStatCard icon="history" label="Dead Letters" value={String(totals.dead_letter_count || 0)} />
            <AdminStatCard icon="approve" label="Ack P50" value={runtime.ack_p50_ms ? `${runtime.ack_p50_ms}ms` : 'N/A'} />
            <AdminStatCard icon="approve" label="Ack P95" value={runtime.ack_p95_ms ? `${runtime.ack_p95_ms}ms` : 'N/A'} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '20px', marginBottom: '24px' }}>
            <AdminStatCard icon="trade" label="Followers" value={String(totals.follower_count || 0)} />
            <AdminStatCard icon="approve" label="Active Followers" value={String(totals.active_followers || 0)} />
            <AdminStatCard icon="warning" label="Paused Followers" value={String(totals.paused_followers || 0)} />
            <AdminStatCard icon="reject" label="Breached Followers" value={String(totals.breached_followers || 0)} />
            <AdminStatCard icon="approve" label="Acks Last Hour" value={String(totals.acknowledged_last_hour || 0)} />
            <AdminStatCard icon="warning" label="Retries Last Hour" value={String(totals.retry_last_hour || 0)} />
          </div>

          {runtime.last_error && (
            <SectionCard title="Last Runtime Error">
              <div style={{ color: 'var(--admin-danger)', fontSize: '13px' }}>{runtime.last_error}</div>
            </SectionCard>
          )}

          <SectionCard title="Per-Follower Success / Failure">
            <AdminDataTable
              loading={loading}
              data={Array.isArray(health.per_follower) ? health.per_follower : []}
              columns={[
                { header: 'Follower', key: 'display_name' },
                { header: 'Success', key: 'success_count', isMono: true },
                { header: 'Failures', key: 'failure_count', isMono: true }
              ]}
              emptyMessage="No follower metrics yet"
            />
          </SectionCard>

          <SectionCard title="Per-Tenant Copier Status">
            <AdminDataTable
              loading={loading}
              data={Array.isArray(health.per_tenant) ? health.per_tenant : []}
              columns={[
                { header: 'Tenant', key: 'tenant_id', isMono: true },
                { header: 'Followers', key: 'follower_count', isMono: true },
                { header: 'Active', key: 'active_followers', isMono: true },
                { header: 'Latest Heartbeat', key: 'latest_follower_heartbeat', render: (row) => formatDateTime(row.latest_follower_heartbeat) }
              ]}
              emptyMessage="No tenant copier status available"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'masters' && (
        <>
          <SectionCard title="Add Copier Master">
            <FormGrid>
              <Field label="Account ID">
                <input className="admin-input" value={masterForm.account_id} onChange={(e) => setMasterForm((current) => ({ ...current, account_id: e.target.value }))} />
              </Field>
              <Field label="Label">
                <input className="admin-input" value={masterForm.label} onChange={(e) => setMasterForm((current) => ({ ...current, label: e.target.value }))} />
              </Field>
            </FormGrid>
            <button
              className="admin-btn admin-btn-primary"
              style={{ marginTop: '12px' }}
              disabled={saving}
              onClick={() => runAction(
                () => adminAxios.post('/api/admin/copier/masters', withTenantBody(masterForm)),
                'Copier master saved'
              )}
            >
              Save Master
            </button>
          </SectionCard>

          <SectionCard title={`Masters (${data.masters.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.masters}
              columns={mastersColumns}
              rowActions={(row) => [
                {
                  label: row.is_enabled ? 'Disable' : 'Enable',
                  onClick: () => runAction(
                    () => adminAxios.patch(`/api/admin/copier/masters/${row.id}`, withTenantBody({ is_enabled: !row.is_enabled })),
                    `Master ${row.is_enabled ? 'disabled' : 'enabled'}`
                  )
                }
              ]}
              emptyMessage="No copier masters configured"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'activeAccounts' && (
        <SectionCard title={`Active Platform Accounts (${data.activeAccounts.length})`}>
          <p style={{ color: 'var(--admin-text-muted)', fontSize: '13px', marginTop: 0 }}>
            Tenant-scoped active Phase 1, Phase 2, and Funded accounts available for copier planning and master selection.
          </p>
          <AdminDataTable
            loading={loading}
            data={data.activeAccounts}
            columns={activeAccountColumns}
            emptyMessage="No active platform accounts found"
          />
        </SectionCard>
      )}

      {activeTab === 'followers' && (
        <>
          <SectionCard title="Add Follower">
            <FormGrid>
              <Field label="Display Name"><input className="admin-input" value={followerForm.display_name} onChange={(e) => setFollowerForm((current) => ({ ...current, display_name: e.target.value }))} /></Field>
              <Field label="Bridge Target Key"><input className="admin-input" value={followerForm.bridge_target_key} onChange={(e) => setFollowerForm((current) => ({ ...current, bridge_target_key: e.target.value }))} /></Field>
              <Field label="Status">
                <select className="admin-select" value={followerForm.status} onChange={(e) => setFollowerForm((current) => ({ ...current, status: e.target.value }))}>
                  <option value="active">ACTIVE</option>
                  <option value="paused">PAUSED</option>
                  <option value="stopped">STOPPED</option>
                  <option value="breached">BREACHED</option>
                </select>
              </Field>
              <Field label="Copy Mode">
                <select className="admin-select" value={followerForm.copy_mode} onChange={(e) => setFollowerForm((current) => ({ ...current, copy_mode: e.target.value }))}>
                  {COPY_MODE_OPTIONS.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
                </select>
              </Field>
              <Field label="Risk Mode">
                <select className="admin-select" value={followerForm.risk_mode} onChange={(e) => setFollowerForm((current) => ({ ...current, risk_mode: e.target.value }))}>
                  {RISK_MODE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </Field>
              <Field label="Fixed Lots"><input className="admin-input" value={followerForm.fixed_lots} onChange={(e) => setFollowerForm((current) => ({ ...current, fixed_lots: e.target.value }))} /></Field>
              <Field label="Ratio Multiplier"><input className="admin-input" value={followerForm.ratio_multiplier} onChange={(e) => setFollowerForm((current) => ({ ...current, ratio_multiplier: e.target.value }))} /></Field>
              <Field label="Risk %"><input className="admin-input" value={followerForm.risk_percent} onChange={(e) => setFollowerForm((current) => ({ ...current, risk_percent: e.target.value }))} /></Field>
              <Field label="Symbol Allowlist"><input className="admin-input" placeholder="EURUSD,XAUUSD" value={followerForm.symbol_allowlist} onChange={(e) => setFollowerForm((current) => ({ ...current, symbol_allowlist: e.target.value }))} /></Field>
              <Field label="Max Slippage Points"><input className="admin-input" value={followerForm.max_slippage_points} onChange={(e) => setFollowerForm((current) => ({ ...current, max_slippage_points: e.target.value }))} /></Field>
              <Field label="Max Spread Points"><input className="admin-input" value={followerForm.max_spread_points} onChange={(e) => setFollowerForm((current) => ({ ...current, max_spread_points: e.target.value }))} /></Field>
            </FormGrid>
            <button
              className="admin-btn admin-btn-primary"
              style={{ marginTop: '12px' }}
              disabled={saving}
              onClick={() => runAction(
                () => adminAxios.post('/api/admin/copier/followers', withTenantBody({
                  ...followerForm,
                  symbol_allowlist: parseCsv(followerForm.symbol_allowlist)
                })),
                'Follower saved'
              )}
            >
              Save Follower
            </button>
          </SectionCard>

          <SectionCard title={`Followers (${data.followers.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.followers}
              columns={followersColumns}
              rowActions={(row) => [
                {
                  label: row.status === 'paused' ? 'Resume' : 'Pause',
                  onClick: () => runAction(
                    () => adminAxios.post(`/api/admin/copier/followers/${row.id}/${row.status === 'paused' ? 'resume' : 'pause'}`, withTenantBody({})),
                    `Follower ${row.status === 'paused' ? 'resumed' : 'paused'}`
                  )
                }
              ]}
              emptyMessage="No followers configured"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'mappings' && (
        <>
          <SectionCard title="Add Master → Follower Mapping">
            <FormGrid>
              <Field label="Master ID"><input className="admin-input" value={mappingForm.master_id} onChange={(e) => setMappingForm((current) => ({ ...current, master_id: e.target.value }))} /></Field>
              <Field label="Follower ID"><input className="admin-input" value={mappingForm.follower_id} onChange={(e) => setMappingForm((current) => ({ ...current, follower_id: e.target.value }))} /></Field>
              <Field label="Copy Mode Override">
                <select className="admin-select" value={mappingForm.copy_mode_override} onChange={(e) => setMappingForm((current) => ({ ...current, copy_mode_override: e.target.value }))}>
                  <option value="">Default</option>
                  {COPY_MODE_OPTIONS.map((option) => <option key={option} value={option}>{option.toUpperCase()}</option>)}
                </select>
              </Field>
              <Field label="Allowed Master Types"><input className="admin-input" value={mappingForm.allowed_master_account_types} onChange={(e) => setMappingForm((current) => ({ ...current, allowed_master_account_types: e.target.value }))} /></Field>
              <Field label="Symbol Allowlist"><input className="admin-input" value={mappingForm.symbol_allowlist} onChange={(e) => setMappingForm((current) => ({ ...current, symbol_allowlist: e.target.value }))} /></Field>
            </FormGrid>
            <button
              className="admin-btn admin-btn-primary"
              style={{ marginTop: '12px' }}
              disabled={saving}
              onClick={() => runAction(
                () => adminAxios.post('/api/admin/copier/mappings', withTenantBody({
                  ...mappingForm,
                  allowed_master_account_types: parseCsv(mappingForm.allowed_master_account_types).filter((item) => MASTER_TYPE_OPTIONS.includes(item)),
                  symbol_allowlist: parseCsv(mappingForm.symbol_allowlist)
                })),
                'Mapping saved'
              )}
            >
              Save Mapping
            </button>
          </SectionCard>

          <SectionCard title={`Mappings (${data.mappings.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.mappings}
              columns={mappingsColumns}
              rowActions={(row) => [
                {
                  label: row.is_enabled ? 'Disable' : 'Enable',
                  onClick: () => runAction(
                    () => adminAxios.patch(`/api/admin/copier/mappings/${row.id}`, withTenantBody({ is_enabled: !row.is_enabled })),
                    `Mapping ${row.is_enabled ? 'disabled' : 'enabled'}`
                  )
                }
              ]}
              emptyMessage="No mappings configured"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'symbols' && (
        <>
          <SectionCard title="Add Symbol Mapping">
            <FormGrid>
              <Field label="Follower ID"><input className="admin-input" value={symbolForm.follower_id} onChange={(e) => setSymbolForm((current) => ({ ...current, follower_id: e.target.value }))} /></Field>
              <Field label="Master Symbol"><input className="admin-input" value={symbolForm.master_symbol} onChange={(e) => setSymbolForm((current) => ({ ...current, master_symbol: e.target.value.toUpperCase() }))} /></Field>
              <Field label="Follower Symbol"><input className="admin-input" value={symbolForm.follower_symbol} onChange={(e) => setSymbolForm((current) => ({ ...current, follower_symbol: e.target.value.toUpperCase() }))} /></Field>
            </FormGrid>
            <button
              className="admin-btn admin-btn-primary"
              style={{ marginTop: '12px' }}
              disabled={saving}
              onClick={() => runAction(
                () => adminAxios.post('/api/admin/copier/symbol-mappings', withTenantBody(symbolForm)),
                'Symbol mapping saved'
              )}
            >
              Save Symbol Mapping
            </button>
          </SectionCard>

          <SectionCard title={`Symbol Mappings (${data.symbolMappings.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.symbolMappings}
              columns={symbolColumns}
              rowActions={(row) => [
                {
                  label: row.is_enabled ? 'Disable' : 'Enable',
                  onClick: () => runAction(
                    () => adminAxios.patch(`/api/admin/copier/symbol-mappings/${row.id}`, withTenantBody({ is_enabled: !row.is_enabled })),
                    `Symbol mapping ${row.is_enabled ? 'disabled' : 'enabled'}`
                  )
                }
              ]}
              emptyMessage="No symbol mappings configured"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'queue' && (
        <>
          <SectionCard title={`Active Queue (${data.jobs.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.jobs}
              columns={jobsColumns}
              rowActions={(row) => row.state === 'dead' ? [{
                label: 'Retry',
                onClick: () => runAction(
                  () => adminAxios.post(`/api/admin/copier/jobs/${row.id}/retry`, withTenantBody({})),
                  'Job requeued'
                )
              }] : []}
              emptyMessage="No queued copier jobs"
            />
          </SectionCard>

          <SectionCard title={`Dead Letters (${data.deadLetters.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.deadLetters}
              columns={jobsColumns}
              rowActions={(row) => [{
                label: 'Retry',
                onClick: () => runAction(
                  () => adminAxios.post(`/api/admin/copier/jobs/${row.id}/retry`, withTenantBody({})),
                  'Dead-letter job requeued'
                )
              }]}
              emptyMessage="No dead-letter copier jobs"
            />
          </SectionCard>
        </>
      )}

      {activeTab === 'reconciliation' && (
        <>
          <SectionCard title="Manual Resync">
            <FormGrid>
              <Field label="Follower ID"><input className="admin-input" value={resyncForm.follower_id} onChange={(e) => setResyncForm((current) => ({ ...current, follower_id: e.target.value }))} /></Field>
              <Field label="Master Trade ID"><input className="admin-input" value={resyncForm.master_trade_id} onChange={(e) => setResyncForm((current) => ({ ...current, master_trade_id: e.target.value }))} /></Field>
              <Field label="Action">
                <select className="admin-select" value={resyncForm.action} onChange={(e) => setResyncForm((current) => ({ ...current, action: e.target.value }))}>
                  {RESYNC_ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                </select>
              </Field>
              <Field label="External Ticket"><input className="admin-input" value={resyncForm.external_ticket} onChange={(e) => setResyncForm((current) => ({ ...current, external_ticket: e.target.value }))} /></Field>
              <Field label="Instrument"><input className="admin-input" value={resyncForm.instrument} onChange={(e) => setResyncForm((current) => ({ ...current, instrument: e.target.value.toUpperCase() }))} /></Field>
            </FormGrid>
            <button
              className="admin-btn admin-btn-primary"
              style={{ marginTop: '12px' }}
              disabled={saving}
              onClick={() => runAction(
                () => adminAxios.post('/api/admin/copier/reconciliation/resync', withTenantBody(resyncForm)),
                'Resync action queued'
              )}
            >
              Queue Resync
            </button>
          </SectionCard>

          <SectionCard title={`Reconciliation Diffs (${data.reconciliation.length})`}>
            <AdminDataTable
              loading={loading}
              data={data.reconciliation}
              columns={reconciliationColumns}
              rowActions={(row) => [
                {
                  label: 'Use For Resync',
                  onClick: () => setResyncForm((current) => ({
                    ...current,
                    follower_id: String(row.follower_id || ''),
                    master_trade_id: String(row.master_trade_id || ''),
                    instrument: String(row.instrument || current.instrument || '').toUpperCase()
                  }))
                }
              ]}
              emptyMessage="No copier reconciliation diffs"
            />
          </SectionCard>
        </>
      )}
    </>
  )
}
