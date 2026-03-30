import React, { useState } from 'react'
import axios from 'axios'

// FIX Step 1: Use env variable instead of hardcoded localhost:5000
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

// ── Password strength checker ─────────────────────────────────────────────────
function getPasswordStrength(password) {
  if (!password) return { score: 0, label: '', color: 'transparent', checks: [] }
  const checks = [
    { label: '8+ characters',       pass: password.length >= 8 },
    { label: 'Uppercase letter',     pass: /[A-Z]/.test(password) },
    { label: 'Lowercase letter',     pass: /[a-z]/.test(password) },
    { label: 'Number',               pass: /[0-9]/.test(password) },
    { label: 'Special character',    pass: /[^A-Za-z0-9]/.test(password) },
  ]
  const score = checks.filter(c => c.pass).length
  const label = score <= 2 ? 'Weak' : score <= 3 ? 'Fair' : score === 4 ? 'Good' : 'Strong'
  const color = score <= 2 ? '#7a7a7a' : score <= 3 ? '#8b8b8b' : score === 4 ? '#797979' : '#4a4a4a'
  return { score, label, color, checks }
}

function Register({ onLogin }) {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    country: '',
    phone: '',
    referred_by: ''
  })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  const strength = getPasswordStrength(form.password)
  const passwordValid = strength.score === 5

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (!termsAccepted) {
      setError('You must agree to the Terms of Service and Privacy Policy to continue.')
      return
    }

    if (!passwordValid) {
      setError('Please meet all password requirements before submitting.')
      return
    }

    setLoading(true)

    try {
      const response = await axios.post(`${API_URL}/api/auth/register`, form)
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed')
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div className="card" style={{ width: '450px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 className="accent" style={{ fontSize: '28px' }}>PROP FIRM</h1>
          <p style={{ color: '#888', marginTop: '8px' }}>Create your free account</p>
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: '12px', color: '#888' }}>FULL NAME</label>
          <input
            type="text"
            name="full_name"
            value={form.full_name}
            onChange={handleChange}
            placeholder="John Smith"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>EMAIL</label>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={handleChange}
            placeholder="your@email.com"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>PASSWORD</label>
          <div style={{ position: 'relative' }}>
            <input
              type={showPassword ? 'text' : 'password'}
              name="password"
              value={form.password}
              onChange={handleChange}
              placeholder="Min 8 chars, uppercase, number, special"
              required
              style={{ width: '100%', paddingRight: '44px' }}
            />
            <button
              type="button"
              onClick={() => setShowPassword(p => !p)}
              style={{
                position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-muted)', fontSize: '14px', padding: '4px'
              }}
            >
              {showPassword ? '🙈' : '👁️'}
            </button>
          </div>

          {/* ── Live password strength indicator ── */}
          {form.password.length > 0 && (
            <div style={{ marginTop: '8px', marginBottom: '4px' }}>
              {/* Strength bar */}
              <div style={{ display: 'flex', gap: '4px', marginBottom: '6px' }}>
                {[1,2,3,4,5].map(i => (
                  <div key={i} style={{
                    flex: 1, height: '3px', borderRadius: '2px',
                    background: i <= strength.score ? strength.color : 'var(--navy-border)',
                    transition: 'background 0.2s'
                  }} />
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Password strength</span>
                <span style={{ fontSize: '11px', fontWeight: '600', color: strength.color }}>{strength.label}</span>
              </div>
              {/* Requirement checklist */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
                {strength.checks.map(c => (
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

          <label style={{ fontSize: '12px', color: '#888', marginTop: '12px', display: 'block' }}>COUNTRY</label>
          <select name="country" value={form.country} onChange={handleChange} required>
            <option value="">Select your country</option>
            <option value="India">India</option>
            <option value="United Kingdom">United Kingdom</option>
            <option value="Australia">Australia</option>
            <option value="UAE">UAE</option>
            <option value="South Africa">South Africa</option>
            <option value="Nigeria">Nigeria</option>
            <option value="Malaysia">Malaysia</option>
            <option value="Singapore">Singapore</option>
            <option value="Philippines">Philippines</option>
            <option value="Kenya">Kenya</option>
            <option value="Pakistan">Pakistan</option>
            <option value="Bangladesh">Bangladesh</option>
            <option value="Other">Other</option>
          </select>

          <label style={{ fontSize: '12px', color: '#888' }}>PHONE / WHATSAPP</label>
          <input
            type="text"
            name="phone"
            value={form.phone}
            onChange={handleChange}
            placeholder="+91 9999999999"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>REFERRAL CODE (optional)</label>
          <input
            type="text"
            name="referred_by"
            value={form.referred_by}
            onChange={handleChange}
            placeholder="Enter referral code if you have one"
          />

          {/* Terms & Privacy Checkbox */}
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            margin: '20px 0 16px',
            padding: '14px',
            background: 'rgba(148, 148, 148, 0.04)',
            border: `1px solid ${termsAccepted ? 'rgba(148, 148, 148, 0.3)' : 'var(--navy-border)'}`,
            borderRadius: '8px',
            transition: 'border-color 0.2s ease'
          }}>
            <input
              type="checkbox"
              id="terms"
              checked={termsAccepted}
              onChange={e => setTermsAccepted(e.target.checked)}
              style={{ marginTop: '2px', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }}
            />
            <label htmlFor="terms" style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6', cursor: 'pointer' }}>
              I have read and agree to the{' '}
              <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                Terms of Service
              </a>
              {' '}and{' '}
              <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                Privacy Policy
              </a>
              . I confirm I am not a resident of the United States, Canada, or any sanctioned jurisdiction, and that I understand this is a simulated trading evaluation platform.
            </label>
          </div>

          <button
            className="btn btn-accent"
            type="submit"
            style={{ width: '100%', marginTop: '8px', opacity: (!termsAccepted || loading || !passwordValid) ? 0.6 : 1, transition: 'opacity 0.2s' }}
            disabled={loading || !termsAccepted || !passwordValid}
          >
            {loading ? 'Creating account...' : 'Create Free Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '24px', color: '#888', fontSize: '14px' }}>
          Already have an account?{' '}
          <a href="/login" style={{ color: '#949494' }}>Sign in here</a>
        </p>
      </div>
    </div>
  )
}

export default Register