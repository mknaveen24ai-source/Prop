import React, { useState } from 'react'
import axios from 'axios'
import { useBranding } from '../BrandingContext'
import { buildTenantPath, getTenantHeaders } from '../utils/tenant'

function EyeIcon({ hidden }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      {hidden && <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
    </svg>
  )
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

// ── Password strength checker ─────────────────────────────────────────────────
function getPasswordStrength(password) {
  if (!password) return { score: 0, label: '', color: 'transparent', checks: [] }
  const checks = [
    { label: '8+ characters',    pass: password.length >= 8 },
    { label: 'Uppercase letter', pass: /[A-Z]/.test(password) },
    { label: 'Lowercase letter', pass: /[a-z]/.test(password) },
    { label: 'Number',           pass: /[0-9]/.test(password) },
    { label: 'Special character',pass: /[^A-Za-z0-9]/.test(password) },
  ]
  const score = checks.filter(c => c.pass).length
  const label = score <= 2 ? 'Weak' : score <= 3 ? 'Fair' : score === 4 ? 'Good' : 'Strong'
  const color = score <= 2 ? '#ef4444' : score <= 3 ? '#f59e0b' : score === 4 ? '#84cc16' : '#22c55e'
  return { score, label, color, checks }
}

// ── Constants ──────────────────────────────────────────────────────────────────
// STEP 1 = fill form
// STEP 2 = enter OTP
// STEP 3 = creating account (brief loading transition)
const STEP_FORM  = 'form'
const STEP_OTP   = 'otp'

function Register({ onLogin }) {
  const { tenant } = useBranding()

  const [step, setStep] = useState(STEP_FORM)

  // Form data
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    country: '',
    phone: '',
    referred_by: ''
  })
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  // OTP step
  const [otpCode, setOtpCode] = useState('')
  const [phoneVerifiedToken, setPhoneVerifiedToken] = useState(null)
  const [otpSent, setOtpSent] = useState(false)
  const [otpCooldown, setOtpCooldown] = useState(0) // seconds until resend allowed

  // UI state
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const strength = getPasswordStrength(form.password)
  const passwordValid = strength.score === 5

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
    setError('')
  }

  // ── Step 1 → 2: validate form then send OTP ─────────────────────────────────
  async function handleSendOtp(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!termsAccepted) {
      return setError('You must agree to the Terms of Service and Privacy Policy to continue.')
    }
    if (!passwordValid) {
      return setError('Please meet all password requirements before continuing.')
    }

    const phone = form.phone.trim()
    if (!phone) return setError('Please enter your phone number.')

    setLoading(true)
    try {
      await axios.post(
        `${API_URL}/api/auth/phone-otp/send`,
        { phone },
        { headers: getTenantHeaders() }
      )
      setOtpSent(true)
      setStep(STEP_OTP)
      setSuccess('A 6-digit verification code has been sent to your phone.')
      // Start 60-second cooldown for resend
      startCooldown(60)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send verification code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Resend OTP ──────────────────────────────────────────────────────────────
  async function handleResendOtp() {
    if (otpCooldown > 0) return
    setError('')
    setSuccess('')
    setOtpCode('')
    setLoading(true)
    try {
      await axios.post(
        `${API_URL}/api/auth/phone-otp/send`,
        { phone: form.phone.trim() },
        { headers: getTenantHeaders() }
      )
      setSuccess('A new code has been sent.')
      startCooldown(60)
    } catch (err) {
      setError(err.response?.data?.error || 'Could not resend code.')
    } finally {
      setLoading(false)
    }
  }

  function startCooldown(seconds) {
    setOtpCooldown(seconds)
    const interval = setInterval(() => {
      setOtpCooldown(prev => {
        if (prev <= 1) { clearInterval(interval); return 0 }
        return prev - 1
      })
    }, 1000)
  }

  // ── Step 2: verify OTP code ─────────────────────────────────────────────────
  async function handleVerifyOtp(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!otpCode || otpCode.length !== 6) {
      return setError('Please enter the 6-digit code sent to your phone.')
    }

    setLoading(true)
    try {
      const res = await axios.post(
        `${API_URL}/api/auth/phone-otp/verify`,
        { phone: form.phone.trim(), code: otpCode },
        { headers: getTenantHeaders() }
      )
      const token = res.data.phone_verified_token
      setPhoneVerifiedToken(token)
      setSuccess('Phone verified! Creating your account…')
      // Immediately proceed to registration
      await handleRegister(token)
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid code. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // ── Final step: create the account ─────────────────────────────────────────
  async function handleRegister(token) {
    try {
      const response = await axios.post(
        `${API_URL}/api/auth/register`,
        { ...form, phone_verified_token: token },
        { headers: getTenantHeaders() }
      )
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.')
      // Go back to form step so user can retry
      setStep(STEP_FORM)
      setPhoneVerifiedToken(null)
    }
  }

  // ── Shared card header ──────────────────────────────────────────────────────
  const cardHeader = (
    <div style={{ textAlign: 'center', marginBottom: '32px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
        <div className="auth-logo-mark">⚡</div>
      </div>
      <h1 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: '8px' }}>
        {step === STEP_OTP ? 'Verify your phone' : `Create your ${tenant?.name || 'trading'} account.`}
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
        {step === STEP_OTP
          ? `Enter the 6-digit code sent to ${form.phone}`
          : tenant?.brand?.tagline || 'Join the premium prop firm today'}
      </p>
    </div>
  )

  return (
    <div className="auth-shell mode-public" style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      <div className="card auth-glass-card" style={{ width: '460px', zIndex: 10, animation: 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)', padding: '40px 32px' }}>

        {cardHeader}

        {/* ── Step indicator ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '28px' }}>
          {['Details', 'Verify Phone'].map((label, i) => {
            const active = (i === 0 && step === STEP_FORM) || (i === 1 && step === STEP_OTP)
            const done   = (i === 0 && step === STEP_OTP)
            return (
              <React.Fragment key={label}>
                {i > 0 && <div style={{ flex: 1, height: '1px', background: done || step === STEP_OTP ? 'var(--accent)' : 'var(--border)' }} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{
                    width: '22px', height: '22px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '11px', fontWeight: 700,
                    background: done ? 'var(--accent)' : active ? 'var(--accent)' : 'var(--bg-hover)',
                    color: done || active ? '#fff' : 'var(--text-muted)',
                    border: `1.5px solid ${done || active ? 'var(--accent)' : 'var(--border)'}`,
                    transition: 'all 0.3s'
                  }}>
                    {done ? '✓' : i + 1}
                  </div>
                  <span style={{ fontSize: '12px', fontWeight: active ? 600 : 400, color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{label}</span>
                </div>
              </React.Fragment>
            )
          })}
        </div>

        {error  && <div className="error"  style={{ marginBottom: '16px' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: '16px' }}>{success}</div>}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {/* STEP 1 — Registration form                                 */}
        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {step === STEP_FORM && (
          <form onSubmit={handleSendOtp}>
            <div className="input-group">
              <label className="input-label">FULL NAME</label>
              <input type="text" name="full_name" className="input-field" value={form.full_name} onChange={handleChange} placeholder="John Smith" required />
            </div>

            <div className="input-group">
              <label className="input-label">EMAIL</label>
              <input type="email" name="email" className="input-field" value={form.email} onChange={handleChange} placeholder="your@email.com" required />
            </div>

            <div className="input-group">
              <label className="input-label">PASSWORD</label>
              <div className="password-field-shell">
                <input
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  className="input-field password-input-field"
                  value={form.password}
                  onChange={handleChange}
                  placeholder="Min 8 chars, uppercase, number, special"
                  required
                />
                <button type="button" onClick={() => setShowPassword(p => !p)} className="password-visibility-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  <EyeIcon hidden={!showPassword} />
                </button>
              </div>
            </div>

            {/* Password strength indicator */}
            {form.password.length > 0 && (
              <div style={{ marginTop: '8px', marginBottom: '4px' }}>
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
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px' }}>
                  {strength.checks.map(c => (
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ fontSize: '10px', color: c.pass ? strength.color : 'var(--text-dim)' }}>{c.pass ? '✓' : '○'}</span>
                      <span style={{ fontSize: '11px', color: c.pass ? 'var(--text-muted)' : 'var(--text-dim)' }}>{c.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="input-group">
              <label className="input-label" style={{ marginTop: '12px' }}>COUNTRY</label>
              <select name="country" className="select-field" value={form.country} onChange={handleChange} required>
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
            </div>

            {/* Phone — shown with a lock icon since it will be OTP-verified */}
            <div className="input-group">
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                PHONE / WHATSAPP
                <span style={{
                  fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '99px',
                  background: 'rgba(99,102,241,0.12)', color: 'var(--accent)', border: '1px solid rgba(99,102,241,0.3)'
                }}>OTP REQUIRED</span>
              </label>
              <input
                type="text"
                name="phone"
                className="input-field"
                value={form.phone}
                onChange={handleChange}
                placeholder="+91 9999999999 (with country code)"
                required
              />
              <p style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '5px', marginBottom: 0 }}>
                📱 We will send a verification code to this number. Your account will only be created after verification.
              </p>
            </div>

            <div className="input-group">
              <label className="input-label">REFERRAL CODE (optional)</label>
              <input type="text" name="referred_by" className="input-field" value={form.referred_by} onChange={handleChange} placeholder="Enter referral code if you have one" />
            </div>

            {/* Terms checkbox */}
            <div className="auth-consent-panel" style={{
              display: 'flex', alignItems: 'flex-start', gap: '10px',
              margin: '20px 0 16px', padding: '14px',
              borderColor: termsAccepted ? 'var(--accent)' : undefined,
              transition: 'border-color 0.2s ease'
            }}>
              <input type="checkbox" id="terms" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)}
                style={{ marginTop: '2px', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
              <label htmlFor="terms" style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: '1.6', cursor: 'pointer' }}>
                I have read and agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Terms of Service</a>
                {' '}and{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Privacy Policy</a>.
                {' '}I confirm I am not a resident of the United States, Canada, or any sanctioned jurisdiction.
              </label>
            </div>

            <button
              id="register-send-otp-btn"
              className="btn btn-primary"
              type="submit"
              style={{ width: '100%', marginTop: '8px', opacity: (!termsAccepted || loading || !passwordValid) ? 0.6 : 1, transition: 'opacity 0.2s' }}
              disabled={loading || !termsAccepted || !passwordValid}
            >
              {loading ? 'Sending code…' : 'Send Verification Code →'}
            </button>

            <p style={{ textAlign: 'center', marginTop: '24px', color: 'var(--text-muted)', fontSize: '14px' }}>
              Already have an account?{' '}
              <a href={buildTenantPath('/login')} style={{ color: 'var(--accent)' }}>Sign in here</a>
            </p>
          </form>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {/* STEP 2 — Enter OTP code                                    */}
        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {step === STEP_OTP && (
          <form onSubmit={handleVerifyOtp}>
            {/* OTP digit input */}
            <div className="input-group" style={{ marginBottom: '8px' }}>
              <label className="input-label">6-DIGIT VERIFICATION CODE</label>
              <input
                id="otp-code-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                className="input-field"
                value={otpCode}
                onChange={e => { setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setError('') }}
                placeholder="• • • • • •"
                autoFocus
                style={{ letterSpacing: '0.5em', fontSize: '24px', textAlign: 'center', fontWeight: 700 }}
                required
              />
            </div>

            {/* Resend + change number */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={otpCooldown > 0 || loading}
                style={{
                  background: 'none', border: 'none', cursor: otpCooldown > 0 ? 'default' : 'pointer',
                  color: otpCooldown > 0 ? 'var(--text-dim)' : 'var(--accent)',
                  fontSize: '13px', padding: 0
                }}
              >
                {otpCooldown > 0 ? `Resend in ${otpCooldown}s` : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => { setStep(STEP_FORM); setError(''); setSuccess(''); setOtpCode('') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px', padding: 0 }}
              >
                ← Change number
              </button>
            </div>

            <button
              id="register-verify-otp-btn"
              className="btn btn-primary"
              type="submit"
              style={{ width: '100%', opacity: (loading || otpCode.length !== 6) ? 0.6 : 1, transition: 'opacity 0.2s' }}
              disabled={loading || otpCode.length !== 6}
            >
              {loading ? 'Verifying…' : 'Verify & Create Account'}
            </button>

            <p style={{ textAlign: 'center', marginTop: '20px', fontSize: '12px', color: 'var(--text-dim)', lineHeight: 1.6 }}>
              The code is valid for <strong>5 minutes</strong>.<br/>
              Didn&apos;t receive it? Check that your number includes the country code (e.g. +91…).
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

export default Register
