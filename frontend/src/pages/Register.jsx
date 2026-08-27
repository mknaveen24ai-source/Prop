import React, { useState, useEffect } from 'react'
import axios from 'axios'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useBranding } from '../BrandingContext'
import AuthMasthead from '../components/auth/AuthMasthead'
import EyeIcon from '../components/common/EyeIcon'
import { API_BASE_URL as API_URL } from '../config/apiBase'


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
  const color = score <= 2 ? 'var(--loss)' : score <= 3 ? 'var(--warn)' : score === 4 ? 'color-mix(in srgb, var(--warn) 50%, var(--gain))' : 'var(--gain)'
  return { score, label, color, checks }
}

// ── Registration is a single step ─────────────────────────────────────────────
//
// This page used to POST to /api/auth/phone-otp/send as step 1 of a two-step
// phone-OTP flow, then to /api/auth/phone-otp/verify, and only then to
// /api/auth/register. NEITHER OTP ENDPOINT HAS EVER EXISTED in the backend —
// routes/auth.js registers /register, /login, /me, /forgot-password,
// /reset-password, /logout, /logout-all, /profile/:userId and the five 2FA
// routes, and nothing else. Every signup therefore 404'd on the first submit
// and no account could be created through the UI at all.
//
// The form now posts straight to /api/auth/register, which was always correct
// and always unreachable. Identity assurance moved to email verification
// (see the verification token issued by that route) plus the KYC review that
// gates funded trading.

function Register({ onLogin }) {
  const { tenant } = useBranding()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const giftCode = (searchParams.get('gift') || '').trim().toUpperCase()
  const [giftPreview, setGiftPreview] = useState(null)

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

  // UI state
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  // Prefill referral code from a ?ref= link (e.g. shared from the affiliate dashboard).
  useEffect(() => {
    const ref = searchParams.get('ref')
    if (ref) setForm(f => ({ ...f, referred_by: ref.toUpperCase() }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ?gift=CODE from a gift-a-challenge email — just a display preview here;
  // the actual redemption happens automatically right after registration
  // succeeds (see handleRegister), reusing the same voucher_code endpoint
  // Checkout.jsx's "have a code" field uses.
  useEffect(() => {
    if (!giftCode) return
    axios.get(`${API_URL}/api/accounts/gift-vouchers/${encodeURIComponent(giftCode)}/preview`)
      .then(res => setGiftPreview(res.data))
      .catch(() => setGiftPreview({ valid: false }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Non-blocking referral code validation — just a hint, the server remains
  // authoritative on whether the code is actually applied at signup.
  const [referralCheck, setReferralCheck] = useState(null)
  const [checkingReferral, setCheckingReferral] = useState(false)
  useEffect(() => {
    const code = form.referred_by.trim()
    if (!code) { setReferralCheck(null); return undefined }
    setCheckingReferral(true)
    const timeout = setTimeout(() => {
      axios.get(`${API_URL}/api/affiliates/validate-code/${encodeURIComponent(code)}`)
        .then(res => setReferralCheck(res.data))
        .catch(() => setReferralCheck({ valid: false }))
        .finally(() => setCheckingReferral(false))
    }, 500)
    return () => clearTimeout(timeout)
  }, [form.referred_by])

  const strength = getPasswordStrength(form.password)
  const passwordValid = strength.score === 5

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
    setError('')
  }

  // ── Submit: validate, then create the account ───────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSuccess('')

    if (!termsAccepted) {
      return setError('You must agree to the Terms of Service and Privacy Policy to continue.')
    }
    if (!passwordValid) {
      return setError('Please meet all password requirements before continuing.')
    }
    if (!form.phone.trim()) {
      return setError('Please enter your phone number.')
    }

    setLoading(true)
    try {
      await handleRegister()
    } finally {
      setLoading(false)
    }
  }

  // ── Final step: create the account ─────────────────────────────────────────
  async function handleRegister() {
    try {
      const response = await axios.post(
        `${API_URL}/api/auth/register`,
        { ...form, terms_accepted: termsAccepted, signup_source: sessionStorage.getItem('signup_source') || 'direct' }
      )
      // The register response already set the auth cookie (setAuthCookie in
      // auth.js), so this authenticated call works before onLogin() even
      // updates the parent's user state.
      if (giftCode) {
        try {
          const orderRes = await axios.post(`${API_URL}/api/accounts/orders`, { voucher_code: giftCode })
          const orderId = orderRes?.data?.order?.id
          if (orderId) {
            onLogin(response.data.user)
            navigate(`/dashboard?checkout=success&order_id=${orderId}`)
            return
          }
        } catch (_) {
          // Redemption failed (wrong email on the gift, expired, etc.) —
          // still log them in; Checkout's own "have a code" field can retry
          // the same code (it tries gift vouchers too, see accounts.js).
          onLogin(response.data.user)
          navigate(`/checkout?voucher=${encodeURIComponent(giftCode)}`)
          return
        }
      }
      onLogin(response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.')
    }
  }

  // ── Shared card header ──────────────────────────────────────────────────────
  const cardHeader = (
    <div style={{ textAlign: 'center', marginBottom: 'var(--space-7)' }}>
      <span className="auth-eyebrow" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
        New Account
      </span>
      <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
        {`Create your ${tenant?.name || 'trading'} account.`}
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-md)' }}>
        {tenant?.brand?.tagline || 'Join the premium prop firm today'}
      </p>
      {giftCode && giftPreview?.valid && (
        <div style={{ marginTop: 'var(--space-4)', padding: 'var(--space-2-5) var(--space-4)', border: '1px solid var(--accent)', borderRadius: '6px', fontSize: 'var(--fs-base)', color: 'var(--accent)' }}>
          🎁 You've been sent a free ${Number(giftPreview.account_size).toLocaleString()} challenge account — sign up to claim it.
        </div>
      )}
    </div>
  )

  return (
    <div className="auth-shell mode-public" style={{
      minHeight: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      // Not `center`: this card (email, password, confirm, country, consent,
      // 5-row strength meter) is taller than a 667px iPhone SE viewport, and a
      // flex child that overflows a centred container has its top clipped with
      // no way to scroll back to it.
      justifyContent: 'flex-start',
      padding: 'var(--space-6)',
      position: 'relative'
    }}>
      <Link
        to="/"
        className="auth-secondary-button auth-back-link"
        style={{ width: 'auto', textDecoration: 'none' }}
      >
        ← Back to Home
      </Link>

      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      <AuthMasthead eyebrow="Section B · New Members" maxWidth={460} />

      <div className="lx-card auth-glass-card" style={{ width: 'min(100%, 460px)', zIndex: 10, animation: 'fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1)', padding: 'var(--space-8) var(--space-7)' }}>

        {cardHeader}

        {error  && <div className="error"  style={{ marginBottom: 'var(--space-4)' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: 'var(--space-4)' }}>{success}</div>}

        <form onSubmit={handleSubmit}>
            <div className="input-group">
              <label className="input-label" htmlFor="register-full-name">FULL NAME</label>
              <input id="register-full-name" type="text" name="full_name" className="input-field" value={form.full_name} onChange={handleChange} placeholder="John Smith" required />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="register-email">EMAIL</label>
              <input id="register-email" type="email" name="email" className="input-field" value={form.email} onChange={handleChange} placeholder="your@email.com" required autoComplete="email" />
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="register-password">PASSWORD</label>
              <div className="password-field-shell">
                <input
                  type={showPassword ? 'text' : 'password'}
                  id="register-password"
                name="password"
                  className="input-field password-input-field"
                  value={form.password}
                  onChange={handleChange}
                  placeholder="Min 8 chars, uppercase, number, special"
                  required
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowPassword(p => !p)} className="password-visibility-toggle" aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  <EyeIcon hidden={!showPassword} />
                </button>
              </div>
            </div>

            {/* Password strength indicator */}
            {form.password.length > 0 && (
              <div style={{ marginTop: 'var(--space-2)', marginBottom: 'var(--space-1)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-1)', marginBottom: 'var(--space-1-5)' }}>
                  {[1,2,3,4,5].map(i => (
                    <div key={i} style={{
                      flex: 1, height: '3px',
                      background: i <= strength.score ? strength.color : 'var(--navy-border)',
                      transition: 'background 0.2s'
                    }} />
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--space-2)' }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Password strength</span>
                  <span style={{ fontSize: 'var(--fs-xs)', fontWeight: '600', color: strength.color }}>{strength.label}</span>
                </div>
                <div className="ui-cols ui-cols--keep-2" style={{ '--cols-gap': '3px' }}>
                  {strength.checks.map(c => (
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                      <span style={{ fontSize: 'var(--fs-2xs)', color: c.pass ? strength.color : 'var(--text-dim)' }}>{c.pass ? '✓' : '○'}</span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: c.pass ? 'var(--text-muted)' : 'var(--text-dim)' }}>{c.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="input-group">
              <label className="input-label" htmlFor="register-country" style={{ marginTop: 'var(--space-3)' }}>COUNTRY</label>
              <select id="register-country" name="country" className="select-field" value={form.country} onChange={handleChange} required>
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
              <label className="input-label" htmlFor="register-phone" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                PHONE / WHATSAPP
              </label>
              <input
                type="text"
                id="register-phone"
                name="phone"
                className="input-field"
                value={form.phone}
                onChange={handleChange}
                placeholder="+91 9999999999 (with country code)"
                required
              />
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1-5)', marginBottom: 0 }}>
                📱 We will send a verification code to this number. Your account will only be created after verification.
              </p>
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="register-referral">REFERRAL CODE (optional)</label>
              <input id="register-referral" type="text" name="referred_by" className="input-field" value={form.referred_by} onChange={handleChange} placeholder="Enter referral code if you have one" />
              {form.referred_by.trim() && !checkingReferral && referralCheck && (
                referralCheck.valid ? (
                  <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gain)', marginTop: 'var(--space-1-5)', marginBottom: 0 }}>
                    ✓ Valid code — you'll get {referralCheck.discount_pct}% off your first challenge
                  </p>
                ) : (
                  <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1-5)', marginBottom: 0 }}>
                    Code not recognized — you can still register without it
                  </p>
                )
              )}
            </div>

            {/* Terms checkbox */}
            <div className="auth-consent-panel" style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2-5)',
              margin: 'var(--space-5) 0 var(--space-4)', padding: 'var(--space-3-5)',
              borderColor: termsAccepted ? 'var(--accent)' : undefined,
              transition: 'border-color 0.2s ease'
            }}>
              <input type="checkbox" id="terms" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)}
                style={{ marginTop: 'var(--space-1)', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
              <label htmlFor="terms" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: '1.6', cursor: 'pointer' }}>
                I have read and agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Terms of Service</a>,{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Privacy Policy</a>, and{' '}
                {/* Refund terms must be disclosed before purchase, not after —
                    linking them at the point of consent is what makes the
                    withdrawal-right waiver in the refund policy enforceable. */}
                <a href="/refund-policy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>Refund Policy</a>.
                {' '}I confirm I am not a resident of the United States, Canada, or any sanctioned jurisdiction.
              </label>
            </div>

            <button
              id="register-send-otp-btn"
              className="btn btn-primary"
              type="submit"
              style={{ width: '100%', marginTop: 'var(--space-2)', opacity: (!termsAccepted || loading || !passwordValid) ? 0.6 : 1, transition: 'opacity 0.2s' }}
              disabled={loading || !termsAccepted || !passwordValid}
            >
              {loading ? 'Creating your account…' : 'Create Account →'}
            </button>

            <p style={{ textAlign: 'center', marginTop: 'var(--space-6)', color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
              Already have an account?{' '}
              <Link to="/login" style={{ color: 'var(--accent)' }}>Sign in here</Link>
            </p>
        </form>
      </div>
    </div>
  )
}

export default Register
