import React, { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useBranding } from '../BrandingContext'
import { authAPI } from '../services/api'

function EyeIcon({ hidden }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {hidden && <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  )
}

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

// ── 6-digit TOTP input component ──────────────────────────────────────────────
function TotpInput({ onSubmit, onBack, loading, error }) {
  const [digits, setDigits] = useState(['', '', '', '', '', ''])
  const refs = [useRef(), useRef(), useRef(), useRef(), useRef(), useRef()]

  useEffect(() => {
    refs[0].current?.focus()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleDigit(index, value) {
    const d = value.replace(/\D/g, '').slice(0, 1)
    const next = [...digits]
    next[index] = d
    setDigits(next)
    if (d && index < 5) {
      refs[index + 1].current?.focus()
    }
    // Auto-submit when all 6 filled
    if (d && index === 5) {
      const code = [...next.slice(0, 5), d].join('')
      if (code.length === 6) onSubmit(code)
    }
  }

  function handleKeyDown(index, e) {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      refs[index - 1].current?.focus()
    }
    if (e.key === 'Enter') {
      const code = digits.join('')
      if (code.length === 6) onSubmit(code)
    }
  }

  function handlePaste(e) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (pasted.length === 6) {
      setDigits(pasted.split(''))
      onSubmit(pasted)
    }
  }

  const code = digits.join('')

  return (
    <div>
      <div style={{ textAlign: 'center', marginBottom: '24px' }}>
        <div style={{ fontSize: '32px', marginBottom: '8px' }}>🔐</div>
        <h2 style={{ color: 'var(--text)', fontSize: '20px', margin: '0 0 6px' }}>
          Two-Factor Authentication
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '13px', lineHeight: '1.5' }}>
          Enter the 6-digit code from your authenticator app.<br />
          Or paste a backup code.
        </p>
      </div>

      {error && (
        <div className="error" style={{ marginBottom: '16px' }}>{error}</div>
      )}

      {/* 6-box digit input */}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', marginBottom: '20px' }}
           onPaste={handlePaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={refs[i]}
            id={`totp-digit-${i}`}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={d}
            onChange={e => handleDigit(i, e.target.value)}
            onKeyDown={e => handleKeyDown(i, e)}
            style={{
              width: '44px',
              height: '52px',
              textAlign: 'center',
              fontSize: '22px',
              fontFamily: 'monospace',
              fontWeight: 700,
              background: 'var(--navy-hover)',
              border: `2px solid ${d ? 'var(--accent)' : 'var(--navy-border)'}`,
              color: 'var(--text)',
              outline: 'none',
              transition: 'border-color 0.2s',
            }}
          />
        ))}
      </div>

      <button
        id="totp-verify-btn"
        className="btn btn-accent"
        onClick={() => onSubmit(code)}
        disabled={loading || code.length < 6}
        style={{ width: '100%', marginBottom: '12px', opacity: (loading || code.length < 6) ? 0.5 : 1 }}
      >
        {loading ? 'Verifying…' : 'Verify Code'}
      </button>

      <button
        type="button"
        onClick={onBack}
        style={{
          width: '100%', background: 'transparent',
          border: '1px solid var(--navy-border)', color: 'var(--text-muted)',
          padding: '10px', cursor: 'pointer',
          fontSize: '13px', fontFamily: 'var(--font-ui)'
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
  const [email, setEmail]       = useState('')
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

  return (
    <div className="auth-shell mode-public" style={{ 
      minHeight: '100vh', 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <Link
        to="/"
        className="auth-secondary-button"
        style={{ position: 'absolute', top: '24px', left: '24px', width: 'auto', display: 'inline-block', textDecoration: 'none', zIndex: 20 }}
      >
        ← Back to Home
      </Link>

      {/* Ambient background glows */}
      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      <div className="card auth-glass-card" style={{ width: '420px', zIndex: 10, animation: 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)' }}>

        {/* ── HEADER ── */}
        {mode !== 'totp' && (
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <div className="auth-logo-mark">
                ⚡
              </div>
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: '8px' }}>
              Sign in to {tenant?.name || 'your portal'}.
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
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
              <label className="input-label">EMAIL</label>
              <input
                type="email"
                className="input-field"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
              />
            </div>

            <div className="input-group">
              <label className="input-label">PASSWORD</label>
              <div className="password-field-shell">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="input-field password-input-field"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
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

            <div style={{ textAlign: 'right', marginBottom: '16px', marginTop: '-4px' }}>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(''); setSuccess('') }}
                className="auth-text-link"
                style={{
                  border: 'none', fontSize: '12px',
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
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px', lineHeight: '1.6' }}>
              Enter the email address associated with your account and we'll send you a reset link.
            </p>
            <div className="input-group">
              <label className="input-label">EMAIL</label>
              <input
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
              style={{ width: '100%', marginTop: '8px' }}
              disabled={loading || !!success}
            >
              {loading ? 'Sending...' : 'Send Reset Link'}
            </button>
            <button
              type="button"
              onClick={() => { setMode('login'); setError(''); setSuccess('') }}
              className="auth-secondary-button"
              style={{
                width: '100%', marginTop: '10px'
              }}
            >
              ← Back to Login
            </button>
          </form>
        )}

        {/* ── RESET PASSWORD FORM ── */}
        {mode === 'reset' && (
          <form onSubmit={handleReset}>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '20px', lineHeight: '1.6' }}>
              Enter the reset code from your email, then set a new password.
            </p>

            {/* FIX (CRITICAL #2): Manual token input field */}
            {!resetToken && (
              <div className="input-group">
                <label className="input-label">RESET CODE</label>
                <input
                  type="text"
                  className="input-field"
                  value={manualToken}
                  onChange={e => setManualToken(e.target.value)}
                  placeholder="Paste the code from your email"
                  required
                />
              </div>
            )}

            <div className="input-group" style={{ marginBottom: '8px' }}>
              <label className="input-label">NEW PASSWORD</label>
              <div className="password-field-shell">
              <input
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
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex: 1, height: '3px', 
                      background: i <= resetStrength.score ? resetStrength.color : 'var(--navy-border)',
                      transition: 'background 0.2s'
                    }} />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Password strength</span>
                  <span style={{ fontSize: '11px', fontWeight: '600', color: resetStrength.color }}>
                    {resetStrength.label}
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
                  {resetStrength.checks.map(c => (
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ fontSize: '10px', color: c.pass ? 'var(--muted)' : 'var(--text-dim)' }}>
                        {c.pass ? '✓' : '○'}
                      </span>
                      <span style={{ fontSize: '11px', color: c.pass ? 'var(--text-muted)' : 'var(--text-dim)' }}>
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
              style={{ width: '100%', marginTop: '8px', opacity: (!resetValid || loading) ? 0.6 : 1 }}
              disabled={loading || !!success || !resetValid}
            >
              {loading ? 'Resetting...' : 'Reset Password'}
            </button>
          </form>
        )}

        {mode === 'login' && (
          <p style={{ textAlign: 'center', marginTop: '24px', color: 'var(--text-muted)', fontSize: '14px' }}>
            No account?{' '}
            <Link to="/register" style={{ color: 'var(--accent)' }}>Register here</Link>
          </p>
        )}
      </div>
    </div>
  )
}

export default Login
