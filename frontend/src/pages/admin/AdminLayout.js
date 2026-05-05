import React, { useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router-dom'
import './admin.css'
import { AdminToastProvider, useToast } from '../../components/admin/AdminToast'
import AdminSidebar from '../../components/admin/AdminSidebar'
import AdminTopBar from '../../components/admin/AdminTopBar'
import { useAdminSession } from '../../providers/AdminSessionProvider'

function formatViolationLabel(value) {
  return String(value || 'critical violation')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
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

function AdminLoginScreen({ onLoginSuccess }) {
  const { adminAxios } = useAdminSession()
  const [step, setStep] = useState('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pre2faToken, setPre2faToken] = useState('')
  const [totpDigits, setTotpDigits] = useState(['', '', '', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const tr0 = useRef(null)
  const tr1 = useRef(null)
  const tr2 = useRef(null)
  const tr3 = useRef(null)
  const tr4 = useRef(null)
  const tr5 = useRef(null)
  const totpRefs = [tr0, tr1, tr2, tr3, tr4, tr5]

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
        setTimeout(() => totpRefs[0]?.current?.focus(), 50)
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

  const handleTotpInput = (index, value) => {
    const digit = value.replace(/\D/g, '').slice(0, 1)
    const next = [...totpDigits]
    next[index] = digit
    setTotpDigits(next)

    if (digit && index < 5) totpRefs[index + 1].current?.focus()
    if (digit && index === 5) {
      const code = [...next.slice(0, 5), digit].join('')
      if (code.length === 6) handleTotpVerify(code)
    }
  }

  const handleTotpKeyDown = (index, event) => {
    if (event.key === 'Backspace' && !totpDigits[index] && index > 0) {
      totpRefs[index - 1].current?.focus()
    }
    if (event.key === 'Enter') {
      const code = totpDigits.join('')
      if (code.length === 6) handleTotpVerify(code)
    }
  }

  return (
    <div className="mode-operator admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="admin-card ui-surface ui-auth-card" style={{ position: 'relative', zIndex: 10 }}>
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'var(--admin-accent-bg)', color: 'var(--admin-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: '24px' }}>
            {step === 'totp' ? '🔐' : '⚡'}
          </div>
          <h1 className="admin-h1">Admin Portal</h1>
          <p style={{ color: 'var(--admin-text-muted)' }}>
            {step === 'totp' ? 'Enter your authenticator code' : 'DB-backed platform and tenant admin access'}
          </p>
        </div>

        {errorMsg && (
          <div style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: 'var(--admin-danger)', padding: '10px', borderRadius: '6px', marginBottom: '16px', fontSize: '13px', textAlign: 'center' }}>
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
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--admin-text-muted)' }}>
                Required for DB-backed platform admins and tenant admins. Leave blank only for one-time legacy bootstrap access before the first platform admin exists.
              </div>
            </div>
            <div className="admin-form-group">
              <label className="admin-label">Admin Password</label>
              <input
                type="password"
                className="admin-input"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <button type="submit" className="admin-btn admin-btn-primary" style={{ width: '100%', marginTop: '8px' }} disabled={loading}>
              {loading ? 'Authenticating...' : 'Secure Login'}
            </button>
          </form>
        )}

        {step === 'totp' && (
          <div>
            <div
              style={{ display: 'flex', gap: '8px', justifyContent: 'center', margin: '24px 0' }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
                if (pasted.length === 6) {
                  setTotpDigits(pasted.split(''))
                  handleTotpVerify(pasted)
                }
              }}
            >
              {totpDigits.map((digit, index) => (
                <input
                  key={index}
                  ref={totpRefs[index]}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  onChange={(event) => handleTotpInput(index, event.target.value)}
                  onKeyDown={(event) => handleTotpKeyDown(index, event)}
                  style={{
                    width: '44px',
                    height: '52px',
                    textAlign: 'center',
                    fontSize: '24px',
                    fontFamily: 'var(--admin-font-mono)',
                    fontWeight: 700,
                    background: 'var(--admin-bg)',
                    border: `1px solid ${digit ? 'var(--admin-accent)' : 'var(--admin-border)'}`,
                    borderRadius: '8px',
                    color: 'var(--admin-text)',
                    outline: 'none'
                  }}
                />
              ))}
            </div>
            <button
              className="admin-btn admin-btn-primary"
              onClick={() => handleTotpVerify(totpDigits.join(''))}
              disabled={loading || totpDigits.join('').length < 6}
              style={{ width: '100%' }}
            >
              {loading ? 'Verifying...' : 'Verify Code'}
            </button>
            <button
              onClick={() => setStep('password')}
              className="admin-btn admin-btn-ghost"
              style={{ width: '100%', marginTop: '12px' }}
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

  if (checking) {
    return <div className="mode-operator admin-layout" style={{ justifyContent: 'center', alignItems: 'center' }}>Connecting secure tunnel...</div>
  }

  if (!isAuthenticated) {
    return <AdminLoginScreen onLoginSuccess={refreshSession} />
  }

  return (
    <AdminToastProvider>
      <AdminRealtimeAlerts socket={socket} />
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
            session={session}
            onLogout={logout}
            onMobileMenuClick={() => setMobileMenuOpen(true)}
          />
          <main className="admin-content" id="admin-scroll-container">
            <Outlet context={{ adminAxios, socket, session }} />
          </main>
        </div>
      </div>
    </AdminToastProvider>
  )
}
