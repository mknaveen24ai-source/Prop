import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useBranding } from '../BrandingContext'
import { authAPI } from '../services/api'
import AuthMasthead from '../components/auth/AuthMasthead'
import EyeIcon from '../components/common/EyeIcon'
import OtpInput from '../components/common/OtpInput'

// Cosmetic/local-only "remember me" — pre-fills the email field on return
// visits. authAPI.login() has no session-duration param, so this doesn't
// extend the actual server session, just spares a retype.
const REMEMBER_EMAIL_KEY = 'propfirm:remembered-email'

// ── Same password strength checker as Register.js ─────────────────────────────
function getPasswordStrength(password) {
  if (!password) return { score: 0, label: '', color: 'transparent', checks: [] }
  const checks = [
    { label: '8+ characters',    pass: password.length >= 8 },
    { label: 'Uppercase letter', pass: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', pass: /[a-z]/.test(password) },
    { label: 'Number',           pass: /[0-9]/.test(password) },
    { label: 'Special character',pass: /[^A-Za-z0-9]/.test(password) },
  ]
  const score  = checks.filter(c => c.pass).length
  const label  = score <= 2 ? 'Weak' : score <= 3 ? 'Fair' : score === 4 ? 'Good' : 'Strong'
  const color  = score <= 2 ? 'var(--loss)' : score <= 3 ? 'var(--warn)' : score === 4 ? 'var(--warn)' : 'var(--gain)'
  return { score, label, color, checks }
}

// ── 6-digit TOTP verification screen ──────────────────────────────────────────
function TotpInput({ onSubmit, onBack, loading, error }) {
  const [code, setCode] = useState('')

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: 'var(--space-6)' }}>
        <div style={{
          width: '48px', height: '48px', margin: '0 auto var(--space-4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--glass-2)', border: '1px solid var(--rule-soft)',
          backdropFilter: 'blur(16px) saturate(140%)', WebkitBackdropFilter: 'blur(16px) saturate(140%)',
        }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="5" y="10" width="14" height="10" rx="1.5" stroke="var(--accent)" strokeWidth="1.6" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </div>
        <h2 style={{ color: 'var(--text)', fontSize: 'var(--fs-2xl)', margin: '0 0 var(--space-1-5)' }}>
          Two-Factor Authentication
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', lineHeight: '1.5' }}>
          Enter the 6-digit code from your authenticator app.<br />
          Or paste a backup code.
        </p>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: 'var(--space-4)' }}>{error}</div>
      )}

      <OtpInput idPrefix="totp-digit" onChange={setCode} onComplete={onSubmit} disabled={loading} />

      <button
        id="totp-verify-btn"
        className="btn btn-accent"
        onClick={() => onSubmit(code)}
        disabled={loading || code.length < 6}
        style={{ width: '100%', marginBottom: 'var(--space-3)', marginTop: 'var(--space-2)', opacity: (loading || code.length < 6) ? 0.5 : 1 }}
      >
        {loading ? 'Verifying…' : 'Verify Code'}
      </button>

      <button
        type="button"
        onClick={onBack}
        style={{
          width: '100%', background: 'transparent',
          border: '1px solid var(--navy-border)', color: 'var(--text-muted)',
          padding: 'var(--space-2-5)', cursor: 'pointer',
          fontSize: 'var(--fs-base)', fontFamily: 'var(--font-ui)'
        }}
      >
        ← Back to login
      </button>
    </div>
  )
}

function Login({ onLogin, initialMode = 'login' }) {
  const { tenant } = useBranding()
  const [mode, setMode]         = useState(initialMode === 'reset' ? 'reset' : 'login')  // 'login' | 'totp' | 'forgot' | 'reset'
  const [email, setEmail]       = useState(() => {
    try { return localStorage.getItem(REMEMBER_EMAIL_KEY) || '' } catch { return '' }
  })
  const [rememberMe, setRememberMe] = useState(true)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [resetToken, setResetToken]   = useState('')
  const [manualToken, setManualToken] = useState('') // FIX (CRITICAL #2): For manual token entry
  const [newPassword, setNewPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [error, setError]   = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)
  const [pre2faToken, setPre2faToken] = useState('')  // short-lived token from server

  const resetStrength = getPasswordStrength(newPassword)
  const resetValid    = resetStrength.score === 5

  // On mount — check if arriving from a reset link (?token=...&email=...)
  // FIX (CRITICAL #2): Also support arriving without token in URL (user enters it manually)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token  = params.get('token')
    const em     = params.get('email')
    if (token && em) {
      setMode('reset')
      setResetToken(token)
      setManualToken(token) // Pre-fill if token is in URL (legacy support)
      setEmail(em)
    } else if (initialMode === 'reset') {
      setMode('reset')
    }
  }, [initialMode])

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const response = await authAPI.login(email, password)

      try {
        if (rememberMe) localStorage.setItem(REMEMBER_EMAIL_KEY, email)
        else localStorage.removeItem(REMEMBER_EMAIL_KEY)
      } catch { /* ignore storage errors (private browsing, etc.) */ }

      if (response.data.requires2FA) {
        // Password accepted — go to 2FA step
        setPre2faToken(response.data.pre2faToken)
        setMode('totp')
      } else {
        onLogin(response.data.user)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed')
    }
    setLoading(false)
  }

  async function handleTotpVerify(code) {
    setError('')
    setLoading(true)
    try {
      const response = await authAPI.validateTwoFactor(pre2faToken, code)
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid code. Please try again.')
    }
    setLoading(false)
  }

  async function handleForgot(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setLoading(true)
    try {
      const res = await authAPI.forgotPassword(email)
      setSuccess(res.data.message)
      if (res.data.dev_reset_link) {
        setSuccess(`${res.data.message}\n\n[DEV] Reset link: ${res.data.dev_reset_link}`)
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Request failed')
    }
    setLoading(false)
  }

  async function handleReset(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    if (!resetValid) {
      return setError('Please meet all password requirements before submitting.')
    }
    // FIX (CRITICAL #2): Use manualToken if resetToken is not set (legacy URL support)
    const tokenToUse = resetToken || manualToken
    if (!tokenToUse) {
      return setError('Reset code is required.')
    }
    setLoading(true)
    try {
      const res = await authAPI.resetPassword(email, tokenToUse, newPassword)
      setSuccess(res.data.message)
      setTimeout(() => {
        window.history.replaceState({}, '', '/login')
        setMode('login')
        setResetToken('')
        setManualToken('')
        setNewPassword('')
        setSuccess('')
      }, 2000)
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed')
    }
    setLoading(false)
  }

  const modeEyebrow = mode === 'forgot' ? 'Password Recovery'
    : mode === 'reset'  ? 'Password Reset'
    : 'Member Sign-In'

  return (
    <div className="auth-shell mode-public" style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      // Not `center`: a flex child taller than the container overflows in both
      // directions and the top becomes unreachable. Auto margins on the card
      // centre it when it fits and let it scroll when it does not.
      justifyContent: 'flex-start',
      position: 'relative'
    }}>
      <Link
        to="/"
        className="auth-secondary-button auth-back-link"
        style={{ width: 'auto', textDecoration: 'none' }}
      >
        ← Back to Home
      </Link>

      {/* Ambient background glows */}
      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      {mode !== 'totp' && <AuthMasthead eyebrow="Section A · Members" maxWidth={420} />}

      <div className="lx-card auth-glass-card" style={{ width: 'min(100%, 420px)', zIndex: 10, animation: 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}>

        {/* ── HEADER ── */}
        {mode !== 'totp' && (
          <div style={{ textAlign: 'center', marginBottom: 'var(--space-7)' }}>
            <span className="auth-eyebrow" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>{modeEyebrow}</span>
            <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
              Sign in to {tenant?.name || 'your portal'}.
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-md)' }}>
              {mode === 'login'  && (tenant?.brand?.tagline || 'Sign in to your account')}
              {mode === 'forgot' && 'Reset your password'}
              {mode === 'reset'  && 'Set new password'}
            </p>
          </div>
        )}

        {error   && mode !== 'totp' && <div className="error">{error}</div>}
        {success && (
          <div className="auth-success-message">
            {success}
          </div>
        )}

        {/* ── TOTP SCREEN ── */}
        {mode === 'totp' && (
          <TotpInput
            onSubmit={handleTotpVerify}
            onBack={() => { setMode('login'); setError(''); setPre2faToken('') }}
            loading={loading}
            error={error}
          />
        )}

        {/* ── LOGIN FORM ── */}
        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <div className="input-group">
              <label className="input-label" htmlFor="login-email">EMAIL</label>
              <input
                id="login-email"
                type="email"
                className="input-field"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="login-password">PASSWORD</label>
              <div className="password-field-shell">
                <input
                  id="login-password"
                  type={showPassword ? 'text' : 'password'}
                  className="input-field password-input-field"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                  required
                  autoComplete="current-password"
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

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-4)', marginTop: '-var(--space-1)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  style={{ accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
                Remember me
              </label>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(''); setSuccess('') }}
                className="auth-text-link"
                style={{
                  background: 'transparent', border: 'none', fontSize: 'var(--fs-sm)',
                  cursor: 'pointer', padding: 0
                }}
              >
                Forgot password?
              </button>
            </div>

            <button
              className="btn btn-primary"
              type="submit"
              style={{ width: '100%' }}
              disabled={loading}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>
        )}

        {/* ── FORGOT PASSWORD FORM ── */}
        {mode === 'forgot' && (
          <form onSubmit={handleForgot}>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-5)', lineHeight: '1.6' }}>
              Enter the email address associated with your account and we'll send you a reset link.
            </p>
            <div className="input-group">
              <label className="input-label" htmlFor="reset-email">EMAIL</label>
              <input
                id="reset-email"
                type="email"
                className="input-field"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                autoComplete="email"
              />
            </div>
            <button
              className="btn btn-accent"
              type="submit"
              style={{ width: '100%', marginTop: 'var(--space-2)' }}
              disabled={loading || !!success}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); setSuccess('') }}
              className="auth-secondary-button"
              style={{
                width: '100%', marginTop: 'var(--space-2-5)'
              }}
            >
              ← Back to Login
            </button>
          </form>
        )}

        {/* ── RESET PASSWORD FORM ── */}
        {mode === 'reset' && (
          <form onSubmit={handleReset}>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', marginBottom: 'var(--space-5)', lineHeight: '1.6' }}>
              Enter the reset code from your email, then set a new password.
            </p>

            {/* FIX (CRITICAL #2): Manual token input field */}
            {!resetToken && (
              <div className="input-group">
                <label className="input-label" htmlFor="reset-code">RESET CODE</label>
                <input
                  id="reset-code"
                  type="text"
                  className="input-field"
                  value={manualToken}
                  onChange={e => setManualToken(e.target.value)}
                  placeholder="Paste the code from your email"
                  required
                />
              </div>
            )}

            <div className="input-group" style={{ marginBottom: 'var(--space-2)' }}>
              <label className="input-label" htmlFor="reset-new-password">NEW PASSWORD</label>
              <div className="password-field-shell">
              <input
                id="reset-new-password"
                type={showNewPassword ? 'text' : 'password'}
                className="input-field password-input-field"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min 8 chars, uppercase, number, special"
                required
              />
              <button
                type="button"
                className="password-visibility-toggle"
                onClick={() => setShowNewPassword(current => !current)}
                aria-label={showNewPassword ? 'Hide new password' : 'Show new password'}
                title={showNewPassword ? 'Hide new password' : 'Show new password'}
              >
                <EyeIcon hidden={!showNewPassword} />
              </button>
            </div>

            {/* ── Live strength indicator ── */}
            </div>

            {newPassword.length > 0 && (
              <div style={{ marginBottom: 'var(--space-5)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-1-5)' }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex: 1, height: '3px', 
                      background: i <= resetStrength.score ? resetStrength.color : 'var(--navy-border)',
                      transition: 'background 0.2s'
                    }} />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Password strength</span>
                  <span style={{ fontSize: 'var(--fs-xs)', fontWeight: '600', color: resetStrength.color }}>
                    {resetStrength.label}
                  </span>
                </div>
                <div className="ui-cols ui-cols--keep-2" style={{ '--cols-gap': '3px' }}>
                  {resetStrength.checks.map(c => (
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                      <span style={{ fontSize: 'var(--fs-2xs)', color: c.pass ? 'var(--muted)' : 'var(--text-dim)' }}>
                        {c.pass ? '✓' : '○'}
                      </span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: c.pass ? 'var(--text-muted)' : 'var(--text-dim)' }}>
                        {c.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <button
              className="btn btn-accent"
              type="submit"
              style={{ width: '100%', marginTop: 'var(--space-2)', opacity: (!resetValid || loading) ? 0.6 : 1 }}
              disabled={loading || !!success || !resetValid}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}

        {mode === 'login' && (
          <p style={{ textAlign: 'center', marginTop: 'var(--space-6)', color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
            No account?{' '}
            <Link to="/register" style={{ color: 'var(--accent)' }}>Register here</Link>
          </p>
        )}
      </div>
    </div>
  )
}

export default Login
