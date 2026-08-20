import React, { useEffect, useRef, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom'
import './admin.css'
import { AdminToastProvider, useToast } from '../../components/admin/AdminToast'
import AdminSidebar from '../../components/admin/AdminSidebar'
import CommandPalette from '../../components/CommandPalette'
import { buildAdminNavResults } from '../../components/admin/adminNavResults'
import AdminTopBar from '../../components/admin/AdminTopBar'
import { useAdminSession } from '../../providers/AdminSessionProvider'
import ErrorBoundary from '../../ErrorBoundary'
import ThemeToggle from '../../components/ThemeToggle'
import EyeIcon from '../../components/common/EyeIcon'
import OtpInput from '../../components/common/OtpInput'

function formatViolationLabel(value) {
  return String(value || 'critical violation')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function AdminShieldIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 12l2 2 4-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function AdminLockIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

function AdminRealtimeAlerts({ socket }) {
  const toast = useToast()
  const seenViolationKeys = useRef(new Set())

  useEffect(() => {
    if (!socket) return undefined

    const handleViolation = (violation) => {
      if (!violation) return
      if (String(violation.status || '').toLowerCase() !== 'open') return
      if (String(violation.severity || '').toLowerCase() !== 'critical') return
      if (Number(violation.hit_count || 1) > 1) return

      const dedupeKey = `${violation.id}:${violation.last_detected_at || ''}`
      if (seenViolationKeys.current.has(dedupeKey)) return
      seenViolationKeys.current.add(dedupeKey)

      const accountPart = violation.account_id ? `Account ${violation.account_id}` : 'Platform'
      const instrumentPart = violation.instrument ? ` • ${violation.instrument}` : ''
      const message = violation.message || `${accountPart}${instrumentPart} triggered ${formatViolationLabel(violation.violation_type)}.`

      toast.error(message, `Critical: ${formatViolationLabel(violation.violation_type)}`)
    }

    socket.on('admin_violation_updated', handleViolation)
    return () => socket.off('admin_violation_updated', handleViolation)
  }, [socket, toast])

  return null
}

export function AdminLoginScreen({ onLoginSuccess }) {
  const { adminAxios } = useAdminSession()
  const [step, setStep] = useState('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [pre2faToken, setPre2faToken] = useState('')
  const [totpCode, setTotpCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handlePasswordSubmit = async (event) => {
    event.preventDefault()
    setLoading(true)
    setErrorMsg('')

    try {
      const payload = email.trim()
        ? { email: email.trim(), password }
        : { password }
      const response = await adminAxios.post('/api/admin/login', payload)

      if (response.data.requires2FA) {
        setPre2faToken(response.data.pre2faToken)
        setStep('totp')
      } else {
        await onLoginSuccess()
      }
    } catch (error) {
      setErrorMsg(error?.response?.data?.error || 'Could not log in')
    } finally {
      setLoading(false)
    }
  }

  const handleTotpVerify = async (code) => {
    setLoading(true)
    setErrorMsg('')

    try {
      await adminAxios.post(
        '/api/admin/2fa/validate',
        { token: code },
        { headers: { Authorization: `Bearer ${pre2faToken}` } }
      )
      await onLoginSuccess()
    } catch (error) {
      setErrorMsg(error?.response?.data?.error || 'Invalid code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mode-operator admin-layout auth-shell" style={{ justifyContent: 'center', alignItems: 'center', position: 'relative', overflow: 'hidden' }}>
      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      <Link
        to="/"
        className="auth-secondary-button"
        style={{ position: 'absolute', top: '24px', left: '24px', width: 'auto', display: 'inline-block', textDecoration: 'none', zIndex: 20 }}
      >
        ← Return to main site
      </Link>

      <div style={{ position: 'absolute', top: '24px', right: '24px', zIndex: 20 }}>
        <ThemeToggle />
      </div>
      <div className="lx-card ui-surface ui-auth-card auth-glass-card" style={{ position: 'relative', zIndex: 10, width: 'min(100%, 420px)' }}>
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-6)' }}>
          <div style={{
            width: '48px', height: '48px', background: 'var(--admin-accent-bg)', color: 'var(--admin-accent)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
            border: '1px solid var(--rule-soft)',
          }}>
            {step === 'totp' ? <AdminLockIcon /> : <AdminShieldIcon />}
          </div>
          <h1 className="admin-h1">Admin Portal</h1>
          <p style={{ color: 'var(--admin-text-muted)' }}>
            {step === 'totp' ? 'Enter your authenticator code' : 'DB-backed platform admin access'}
          </p>
        </div>

        {errorMsg && (
          <div style={{ background: 'color-mix(in srgb, var(--admin-danger) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--admin-danger) 20%, transparent)', color: 'var(--admin-danger)', padding: 'var(--space-2-5)', marginBottom: 'var(--space-4)', fontSize: 'var(--fs-base)', textAlign: 'center' }}>
            {errorMsg}
          </div>
        )}

        {step === 'password' && (
          <form onSubmit={handlePasswordSubmit}>
            <div className="admin-form-group">
              <label className="admin-label">Admin Email</label>
              <input
                type="email"
                className="admin-input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@yourfirm.com"
              />
              <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-sm)', color: 'var(--admin-text-muted)' }}>
                Required for DB-backed platform admins. Leave blank only for one-time legacy bootstrap access before the first platform admin exists.
              </div>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Admin Password</label>
              <div className="password-field-shell">
              <input
                type={showPassword ? 'text' : 'password'}
                className="admin-input password-input-field"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
              <button
                type="button"
                className="password-visibility-toggle"
                onClick={() => setShowPassword(current => !current)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
              >
                <EyeIcon hidden={!showPassword} />
              </button>
              </div>
            </div>
            <button type="submit" className="admin-btn admin-btn-primary" style={{ width: '100%', marginTop: 'var(--space-2)' }} disabled={loading}>
              {loading ? 'Authenticating...' : 'Secure Login'}
            </button>
          </form>
        )}

        {step === 'totp' && (
          <div>
            <OtpInput idPrefix="admin-totp-digit" onChange={setTotpCode} onComplete={handleTotpVerify} disabled={loading} />
            <button
              className="admin-btn admin-btn-primary"
              onClick={() => handleTotpVerify(totpCode)}
              disabled={loading || totpCode.length < 6}
              style={{ width: '100%' }}
            >
              {loading ? 'Verifying...' : 'Verify Code'}
            </button>
            <button
              onClick={() => setStep('password')}
              className="admin-btn admin-btn-ghost"
              style={{ width: '100%', marginTop: 'var(--space-3)' }}
            >
              ← Back to password
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function AdminLayout() {
  const { adminAxios, checking, isAuthenticated, session, socket, refreshSession, logout } = useAdminSession()
  const [isSidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [isMobileMenuOpen, setMobileMenuOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  if (checking) {
    return <div className="mode-operator admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>Connecting secure tunnel...</div>
  }

  if (!isAuthenticated) {
    return <AdminLoginScreen onLoginSuccess={refreshSession} />
  }

  return (
    <AdminToastProvider>
      <AdminRealtimeAlerts socket={socket} />
      <CommandPalette
        results={buildAdminNavResults({ isSuperAdmin: session?.role === 'super_admin', navigate })}
      />
      <div className="mode-operator admin-layout">
        <AdminSidebar
          adminAxios={adminAxios}
          session={session}
          isCollapsed={isSidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!isSidebarCollapsed)}
          isMobileOpen={isMobileMenuOpen}
          onMobileClose={() => setMobileMenuOpen(false)}
          socket={socket}
        />

        <div className="admin-main-wrapper">
          <AdminTopBar
            adminAxios={adminAxios}
            session={session}
            onLogout={logout}
            onMobileMenuClick={() => setMobileMenuOpen(true)}
          />
          <main className="admin-content" id="admin-scroll-container">
            <ErrorBoundary variant="section" label="This admin page" key={location.pathname}>
              <Outlet context={{ adminAxios, socket, session }} />
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </AdminToastProvider>
  )
}
