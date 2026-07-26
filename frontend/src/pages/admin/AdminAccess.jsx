import React, { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import AdminBadge from '../../components/admin/AdminBadge'
import { useToast } from '../../components/admin/AdminToast'

function AccessCard({ title, value, helper, status = 'neutral' }) {
  const accent = status === 'danger'
    ? 'var(--admin-danger)'
    : status === 'warning'
      ? 'var(--admin-warning)'
      : status === 'success'
        ? 'var(--admin-success)'
        : 'var(--admin-accent)'

  return (
    <div className="admin-card" style={{ marginBottom: 0 }}>
      <div style={{ fontSize: '12px', color: 'var(--admin-text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>
        {title}
      </div>
      <div style={{ fontSize: '28px', fontWeight: 700, color: accent, marginBottom: '8px' }}>
        {value}
      </div>
      <div style={{ fontSize: '12px', color: 'var(--admin-text-muted)' }}>{helper}</div>
    </div>
  )
}

function SecurityFlag({ label, healthy, detail }) {
  return (
    <div className="admin-card" style={{ marginBottom: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '8px' }}>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <AdminBadge status={healthy ? 'success' : 'danger'} label={healthy ? 'OK' : 'Needs Action'} />
      </div>
      <div style={{ fontSize: '12px', color: 'var(--admin-text-muted)' }}>{detail}</div>
    </div>
  )
}

function formatDate(value) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString()
}

function formatAuthSource(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'platform_admin') return 'DB Platform Admin'
  if (normalized === 'env_fallback') return 'Legacy Env Bootstrap'
  return normalized || '-'
}

function createEmptyAdminForm() {
  return {
    email: '',
    full_name: '',
    password: ''
  }
}

export default function AdminAccess() {
  const { adminAxios, session } = useOutletContext()
  const toast = useToast()
  const isSuperAdmin = session?.role === 'super_admin'

  const [loading, setLoading] = useState(true)
  const [twoFaStatus, setTwoFaStatus] = useState(null)
  const [securityStatus, setSecurityStatus] = useState(null)
  const [accessData, setAccessData] = useState({ platform_admins: [], summary: null })
  const [setupPayload, setSetupPayload] = useState(null)
  const [setupCode, setSetupCode] = useState('')
  const [backupCodes, setBackupCodes] = useState([])
  const [disableCode, setDisableCode] = useState('')
  const [adminForm, setAdminForm] = useState(createEmptyAdminForm())
  const [busyKey, setBusyKey] = useState('')

  const loadAccess = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    try {
      const requests = [
        adminAxios.get('/api/admin/2fa/status'),
        adminAxios.get('/api/admin/security/status')
      ]
      if (isSuperAdmin) {
        requests.push(adminAxios.get('/api/admin/admin-users'))
      }

      const [twoFaRes, securityRes, accessRes] = await Promise.all(requests)
      setTwoFaStatus(twoFaRes.data || null)
      setSecurityStatus(securityRes.data || null)
      if (accessRes?.data) {
        setAccessData({
          platform_admins: Array.isArray(accessRes.data.platform_admins) ? accessRes.data.platform_admins : [],
          summary: accessRes.data.summary || null
        })
      } else {
        setAccessData({ platform_admins: [], summary: null })
      }
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not load admin access state')
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    loadAccess()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin])

  const handleStartSetup = async () => {
    setBusyKey('2fa-setup')
    try {
      const response = await adminAxios.post('/api/admin/2fa/setup')
      setSetupPayload(response.data || null)
      setBackupCodes([])
      setSetupCode('')
      toast.success('Scan the QR code and enter the first verification code')
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not start 2FA setup')
    } finally {
      setBusyKey('')
    }
  }

  const handleVerifySetup = async () => {
    if (!setupCode.trim()) return
    setBusyKey('2fa-verify')
    try {
      const response = await adminAxios.post('/api/admin/2fa/verify-setup', { token: setupCode.trim() })
      setBackupCodes(Array.isArray(response.data?.backup_codes) ? response.data.backup_codes : [])
      setSetupPayload(null)
      setSetupCode('')
      toast.success(response.data?.message || '2FA enabled successfully')
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not verify setup code')
    } finally {
      setBusyKey('')
    }
  }

  const handleDisable2fa = async () => {
    if (!disableCode.trim()) return
    setBusyKey('2fa-disable')
    try {
      const response = await adminAxios.post('/api/admin/2fa/disable', { token: disableCode.trim() })
      setDisableCode('')
      setBackupCodes([])
      toast.success(response.data?.message || '2FA disabled')
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not disable 2FA')
    } finally {
      setBusyKey('')
    }
  }

  const handleCreatePlatformAdmin = async (event) => {
    event.preventDefault()
    setBusyKey('create-admin')
    try {
      const response = await adminAxios.post('/api/admin/admin-users', adminForm)
      toast.success(response.data?.message || 'Platform admin created')
      setAdminForm(createEmptyAdminForm())
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not create platform admin')
    } finally {
      setBusyKey('')
    }
  }

  const patchPlatformAdmin = async (adminId, patch, successMessage) => {
    setBusyKey(`patch-${adminId}`)
    try {
      const response = await adminAxios.patch(`/api/admin/admin-users/${adminId}`, patch)
      toast.success(response.data?.message || successMessage)
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not update platform admin')
    } finally {
      setBusyKey('')
    }
  }

  const revokeAdminSessions = async (adminId) => {
    setBusyKey(`revoke-${adminId}`)
    try {
      const response = await adminAxios.post(`/api/admin/admin-users/${adminId}/revoke-sessions`)
      toast.success(response.data?.message || 'Sessions revoked')
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not revoke sessions')
    } finally {
      setBusyKey('')
    }
  }

  const disablePlatformAdmin = async (adminId) => {
    setBusyKey(`disable-${adminId}`)
    try {
      const response = await adminAxios.post(`/api/admin/admin-users/${adminId}/disable`)
      toast.success(response.data?.message || 'Platform admin disabled')
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not disable platform admin')
    } finally {
      setBusyKey('')
    }
  }

  const resetPlatformAdminPassword = async (adminId) => {
    const nextPassword = window.prompt('Set a new password for this platform admin (minimum 10 characters).')
    if (!nextPassword) return
    setBusyKey(`reset-${adminId}`)
    try {
      const response = await adminAxios.post(`/api/admin/admin-users/${adminId}/reset-password`, {
        password: nextPassword
      })
      toast.success(response.data?.message || 'Password reset successfully')
      await loadAccess({ silent: true })
    } catch (err) {
      toast.error(err?.response?.data?.error || 'Could not reset password')
    } finally {
      setBusyKey('')
    }
  }

  const currentAdminCards = useMemo(() => {
    const role = session?.role === 'super_admin' ? 'Super Admin' : 'Unknown'
    return [
      {
        title: 'Current Role',
        value: role,
        helper: session?.email || 'Not signed in',
        status: session?.role === 'super_admin' ? 'success' : 'warning'
      },
      {
        title: 'Auth Source',
        value: formatAuthSource(session?.auth_source),
        helper: session?.auth_source === 'env_fallback'
          ? 'Bootstrap-only access path'
          : 'DB-backed admin authentication',
        status: session?.auth_source === 'env_fallback' ? 'warning' : 'success'
      },
      {
        title: '2FA',
        value: twoFaStatus?.totp_enabled ? 'Enabled' : 'Disabled',
        helper: twoFaStatus?.legacy_env_fallback
          ? 'Enable after migrating to a DB-backed admin account'
          : 'Authenticator app + backup codes',
        status: twoFaStatus?.totp_enabled ? 'success' : 'danger'
      }
    ]
  }, [session, twoFaStatus])

  if (loading) {
    return <div className="admin-card">Loading admin access controls...</div>
  }

  return (
    <div style={{ display: 'grid', gap: '24px' }}>
      <div>
        <h1 className="admin-h1">Access & Security</h1>
        <p style={{ color: 'var(--admin-text-muted)', maxWidth: '920px', margin: 0 }}>
          Manage DB-backed platform admins and enroll account-based admin 2FA.
          Legacy `.env` admin login is treated as bootstrap-only and should be retired once a real platform admin exists.
        </p>
      </div>

      <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
        {currentAdminCards.map((card) => (
          <AccessCard
            key={card.title}
            title={card.title}
            value={card.value}
            helper={card.helper}
            status={card.status}
          />
        ))}
      </div>

      <div className="admin-card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '18px' }}>
          <div>
            <h2 className="admin-h2" style={{ marginBottom: '6px' }}>Admin 2FA</h2>
            <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
              Each DB-backed admin account has its own authenticator secret and backup codes.
            </div>
          </div>
          {twoFaStatus && (
            <AdminBadge
              status={twoFaStatus.totp_enabled ? 'success' : 'warning'}
              label={twoFaStatus.totp_enabled ? 'Enabled' : 'Not Enrolled'}
            />
          )}
        </div>

        {twoFaStatus?.legacy_env_fallback ? (
          <div style={{ padding: '16px', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.25)', background: 'rgba(245, 158, 11, 0.08)', color: 'var(--admin-text)' }}>
            This session is using the legacy `.env` bootstrap path. Create your first DB-backed platform admin, sign in with that account, and then enroll 2FA.
          </div>
        ) : setupPayload ? (
          <div style={{ display: 'grid', gap: '20px', gridTemplateColumns: 'minmax(240px, 320px) minmax(280px, 1fr)' }}>
            <div className="admin-card" style={{ marginBottom: 0, background: 'var(--admin-bg)' }}>
              <div style={{ fontWeight: 600, marginBottom: '10px' }}>Scan QR Code</div>
              <img src={setupPayload.qr} alt="Admin 2FA QR" style={{ width: '100%', maxWidth: '240px', borderRadius: '10px', background: 'var(--paper)', padding: '10px' }} />
            </div>
            <div className="admin-card" style={{ marginBottom: 0, background: 'var(--admin-bg)' }}>
              <div style={{ fontWeight: 600, marginBottom: '10px' }}>Verify Setup</div>
              <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '12px' }}>
                Manual secret: <span className="admin-font-mono" style={{ color: 'var(--admin-text)' }}>{setupPayload.secret}</span>
              </div>
              <div className="admin-form-group">
                <label className="admin-label">Authenticator code</label>
                <input
                  className="admin-input"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                  placeholder="Enter 6-digit code"
                />
              </div>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                <button className="admin-btn admin-btn-primary" onClick={handleVerifySetup} disabled={busyKey === '2fa-verify' || !setupCode.trim()}>
                  {busyKey === '2fa-verify' ? 'Verifying...' : 'Enable 2FA'}
                </button>
                <button className="admin-btn admin-btn-ghost" onClick={() => { setSetupPayload(null); setSetupCode('') }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
            <div className="admin-card" style={{ marginBottom: 0, background: 'var(--admin-bg)' }}>
              <div style={{ fontWeight: 600, marginBottom: '10px' }}>Enrollment</div>
              <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '16px' }}>
                {twoFaStatus?.totp_enabled
                  ? 'This admin account already requires TOTP during login.'
                  : 'Enroll this admin account with an authenticator app and one-time backup codes.'}
              </div>
              {!twoFaStatus?.totp_enabled && (
                <button className="admin-btn admin-btn-primary" onClick={handleStartSetup} disabled={busyKey === '2fa-setup' || !twoFaStatus?.totp_setup_available}>
                  {busyKey === '2fa-setup' ? 'Preparing...' : 'Begin 2FA Setup'}
                </button>
              )}
            </div>

            {twoFaStatus?.totp_enabled && (
              <div className="admin-card" style={{ marginBottom: 0, background: 'var(--admin-bg)' }}>
                <div style={{ fontWeight: 600, marginBottom: '10px' }}>Disable 2FA</div>
                <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '12px' }}>
                  Enter an authenticator code or a remaining backup code to remove 2FA from this admin account.
                </div>
                <div className="admin-form-group">
                  <label className="admin-label">Authenticator or backup code</label>
                  <input
                    className="admin-input"
                    value={disableCode}
                    onChange={(event) => setDisableCode(event.target.value)}
                    placeholder="Enter verification code"
                  />
                </div>
                <button className="admin-btn admin-btn-danger" onClick={handleDisable2fa} disabled={busyKey === '2fa-disable' || !disableCode.trim()}>
                  {busyKey === '2fa-disable' ? 'Disabling...' : 'Disable 2FA'}
                </button>
              </div>
            )}
          </div>
        )}

        {backupCodes.length > 0 && (
          <div className="admin-card" style={{ marginTop: '20px', marginBottom: 0, background: 'var(--admin-bg)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ fontWeight: 600 }}>Backup Codes</div>
              <AdminBadge status="warning" label="Shown Once" />
            </div>
            <div style={{ fontSize: '13px', color: 'var(--admin-text-muted)', marginBottom: '12px' }}>
              Save these codes securely. Each code can be used only once if your authenticator app is unavailable.
            </div>
            <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
              {backupCodes.map((code) => (
                <div key={code} className="admin-font-mono" style={{ padding: '12px', borderRadius: '8px', border: '1px solid var(--admin-border)', background: 'var(--admin-surface)' }}>
                  {code}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {isSuperAdmin && (
        <>
          <div>
            <h2 className="admin-h2" style={{ marginBottom: '12px' }}>Security Checklist</h2>
            <div style={{ display: 'grid', gap: '16px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <SecurityFlag
                label="DB-backed Admin Migration"
                healthy={securityStatus?.migration?.platform_admin_bootstrap_complete === true}
                detail={securityStatus?.migration?.platform_admin_bootstrap_complete
                  ? `${securityStatus?.migration?.active_platform_admin_count || 0} active platform admins are present.`
                  : 'No active DB-backed platform admin exists yet.'}
              />
              <SecurityFlag
                label="Legacy Env Fallback"
                healthy={securityStatus?.migration?.env_fallback_enabled === false}
                detail={securityStatus?.migration?.env_fallback_enabled
                  ? 'Legacy env bootstrap login is still enabled.'
                  : 'Legacy env bootstrap login is effectively retired.'}
              />
              <SecurityFlag
                label="Admin TOTP Coverage"
                healthy={(securityStatus?.totp?.platform_admins_total || 0) > 0 && (securityStatus?.totp?.platform_admins_enabled || 0) >= (securityStatus?.totp?.platform_admins_total || 0)}
                detail={`${securityStatus?.totp?.platform_admins_enabled || 0}/${securityStatus?.totp?.platform_admins_total || 0} active platform admins have 2FA enabled.`}
              />
              <SecurityFlag
                label="Secret Hygiene"
                healthy={!securityStatus?.secrets?.jwt_secret_needs_rotation && !securityStatus?.secrets?.admin_jwt_secret_needs_rotation && !securityStatus?.secrets?.admin_password_needs_rotation}
                detail={securityStatus?.secrets?.node_env === 'production'
                  ? 'JWT and bootstrap secret rotation should be completed before launch.'
                  : 'Default or bootstrap secrets are still flagged and should be rotated.'}
              />
            </div>
          </div>

          <div className="admin-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '18px' }}>
              <div>
                <h2 className="admin-h2" style={{ marginBottom: '6px' }}>Create Platform Admin</h2>
                <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
                  Create DB-backed super-admin accounts so you no longer rely on a single `.env` password.
                </div>
              </div>
              <AdminBadge status="info" label={`${accessData.platform_admins.length} total`} />
            </div>
            <form onSubmit={handleCreatePlatformAdmin} style={{ display: 'grid', gap: '14px', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <div className="admin-form-group" style={{ marginBottom: 0 }}>
                <label className="admin-label">Email</label>
                <input className="admin-input" type="email" value={adminForm.email} onChange={(event) => setAdminForm((current) => ({ ...current, email: event.target.value }))} required />
              </div>
              <div className="admin-form-group" style={{ marginBottom: 0 }}>
                <label className="admin-label">Full Name</label>
                <input className="admin-input" value={adminForm.full_name} onChange={(event) => setAdminForm((current) => ({ ...current, full_name: event.target.value }))} />
              </div>
              <div className="admin-form-group" style={{ marginBottom: 0 }}>
                <label className="admin-label">Password</label>
                <input className="admin-input" type="password" value={adminForm.password} onChange={(event) => setAdminForm((current) => ({ ...current, password: event.target.value }))} required />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="admin-btn admin-btn-primary" type="submit" disabled={busyKey === 'create-admin'}>
                  {busyKey === 'create-admin' ? 'Creating...' : 'Create Platform Admin'}
                </button>
              </div>
            </form>
          </div>

          <div className="admin-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h2 className="admin-h2" style={{ marginBottom: '6px' }}>Platform Admin Accounts</h2>
                <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>
                  Manage DB-backed platform admins, revoke their sessions, and disable old accounts.
                </div>
              </div>
            </div>
            <div className="admin-table-wrapper">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th className="admin-th">Admin</th>
                    <th className="admin-th">Status</th>
                    <th className="admin-th">2FA</th>
                    <th className="admin-th">Last Login</th>
                    <th className="admin-th">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {accessData.platform_admins.map((adminUser) => (
                    <tr key={adminUser.id}>
                      <td className="admin-td">
                        <div style={{ fontWeight: 600 }}>{adminUser.full_name || adminUser.email}</div>
                        <div style={{ color: 'var(--admin-text-muted)', fontSize: '12px' }}>{adminUser.email}</div>
                      </td>
                      <td className="admin-td"><AdminBadge status={adminUser.status === 'active' ? 'success' : 'danger'} label={adminUser.status} /></td>
                      <td className="admin-td"><AdminBadge status={adminUser.totp_enabled ? 'success' : 'warning'} label={adminUser.totp_enabled ? 'Enabled' : 'Disabled'} /></td>
                      <td className="admin-td">{formatDate(adminUser.last_login_at)}</td>
                      <td className="admin-td">
                        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                          <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={() => revokeAdminSessions(adminUser.id)} disabled={busyKey === `revoke-${adminUser.id}`}>
                            Revoke Sessions
                          </button>
                          <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={() => resetPlatformAdminPassword(adminUser.id)} disabled={busyKey === `reset-${adminUser.id}`}>
                            Reset Password
                          </button>
                          {adminUser.status === 'active' ? (
                            <button className="admin-btn admin-btn-danger admin-btn-sm" onClick={() => disablePlatformAdmin(adminUser.id)} disabled={busyKey === `disable-${adminUser.id}`}>
                              Disable
                            </button>
                          ) : (
                            <button className="admin-btn admin-btn-primary admin-btn-sm" onClick={() => patchPlatformAdmin(adminUser.id, { status: 'active' }, 'Platform admin re-enabled')} disabled={busyKey === `patch-${adminUser.id}`}>
                              Re-enable
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {accessData.platform_admins.length === 0 && (
                    <tr>
                      <td className="admin-td" colSpan={5}>No DB-backed platform admins created yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </>
      )}
    </div>
  )
}
