import React, { useState } from 'react'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

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
  const color  = score <= 2 ? '#7a7a7a' : score <= 3 ? '#8b8b8b' : score === 4 ? '#797979' : '#4a4a4a'
  return { score, label, color, checks }
}

function Login({ onLogin }) {
  const [mode, setMode]         = useState('login')
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [resetToken, setResetToken]   = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [showNewPassword, setShowNewPassword] = useState(false)
  const [error, setError]   = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const resetStrength = getPasswordStrength(newPassword)
  const resetValid    = resetStrength.score === 5

  // On mount — check if arriving from a reset link (?token=...&email=...)
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const token  = params.get('token')
    const em     = params.get('email')
    if (token && em) {
      setMode('reset')
      setResetToken(token)
      setEmail(em)
    }
  }, [])

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const response = await axios.post(`${API_URL}/api/auth/login`, { email, password })
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed')
    }
    setLoading(false)
  }

  async function handleForgot(e) {
    e.preventDefault()
    setError('')
    setSuccess('')
    setLoading(true)
    try {
      const res = await axios.post(`${API_URL}/api/auth/forgot-password`, { email })
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
    setLoading(true)
    try {
      const res = await axios.post(`${API_URL}/api/auth/reset-password`, {
        email,
        token: resetToken,
        new_password: newPassword
      })
      setSuccess(res.data.message)
      setTimeout(() => {
        window.history.replaceState({}, '', '/login')
        setMode('login')
        setResetToken('')
        setNewPassword('')
        setSuccess('')
      }, 2000)
    } catch (err) {
      setError(err.response?.data?.error || 'Reset failed')
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: '400px' }}>

        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 className="accent" style={{ fontSize: '28px' }}>PROP FIRM</h1>
          <p style={{ color: 'var(--text-muted)', marginTop: '8px' }}>
            {mode === 'login'  && 'Sign in to your account'}
            {mode === 'forgot' && 'Reset your password'}
            {mode === 'reset'  && 'Set new password'}
          </p>
        </div>

        {error   && <div className="error">{error}</div>}
        {success && (
          <div style={{
            background: 'rgba(74, 74, 74, 0.1)', border: '1px solid var(--green)',
            borderRadius: '8px', padding: '12px 16px', marginBottom: '16px',
            color: 'var(--green)', fontSize: '13px', whiteSpace: 'pre-wrap', lineHeight: '1.6'
          }}>
            {success}
          </div>
        )}

        {/* ── LOGIN FORM ── */}
        {mode === 'login' && (
          <form onSubmit={handleLogin}>
            <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>EMAIL</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
            />

            <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>PASSWORD</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter password"
              required
            />

            <div style={{ textAlign: 'right', marginBottom: '16px', marginTop: '-4px' }}>
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(''); setSuccess('') }}
                style={{
                  background: 'transparent', border: 'none',
                  color: 'var(--accent)', fontSize: '12px',
                  cursor: 'pointer', padding: 0,
                  fontFamily: 'DM Sans, sans-serif',
                  textDecoration: 'underline'
                }}
              >
                Forgot password?
              </button>
            </div>

            <button
              className="btn btn-accent"
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
            <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>EMAIL</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
            />
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
              style={{
                width: '100%', marginTop: '10px', background: 'transparent',
                border: '1px solid var(--navy-border)', color: 'var(--text-muted)',
                padding: '10px', borderRadius: '6px', cursor: 'pointer',
                fontSize: '13px', fontFamily: 'DM Sans, sans-serif'
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
              Enter your new password below. Must meet all requirements.
            </p>

            <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>NEW PASSWORD</label>
            <div style={{ position: 'relative', marginBottom: '8px' }}>
              <input
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="Min 8 chars, uppercase, number, special"
                required
                style={{ width: '100%', paddingRight: '44px' }}
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(p => !p)}
                style={{
                  position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: '14px', padding: '4px'
                }}
              >
                {showNewPassword ? '🙈' : '👁️'}
              </button>
            </div>

            {/* ── Live strength indicator ── */}
            {newPassword.length > 0 && (
              <div style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex: 1, height: '3px', borderRadius: '2px',
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
                      <span style={{ fontSize: '10px', color: c.pass ? '#797979' : 'var(--text-dim)' }}>
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
            <a href="/register" style={{ color: 'var(--accent)' }}>Register here</a>
          </p>
        )}
      </div>
    </div>
  )
}

export default Login