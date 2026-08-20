import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useBranding } from '../BrandingContext'
import AuthMasthead from '../components/auth/AuthMasthead'
import EyeIcon from '../components/common/EyeIcon'
import OtpInput from '../components/common/OtpInput'
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

// ── Constants ──────────────────────────────────────────────────────────────────
// STEP 1 = fill form
// STEP 2 = enter OTP
// STEP 3 = creating account (brief loading transition)
const STEP_FORM  = 'form'
const STEP_OTP   = 'otp'

function Register({ onLogin }) {
  const { tenant } = useBranding()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const giftCode = (searchParams.get('gift') || '').trim().toUpperCase()
  const [giftPreview, setGiftPreview] = useState(null)

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
  const [otpResetKey, setOtpResetKey] = useState(0)
  const [phoneVerifiedToken, setPhoneVerifiedToken] = useState(null)
  const [otpSent, setOtpSent] = useState(false)
  const [otpCooldown, setOtpCooldown] = useState(0) // seconds until resend allowed

  // UI state
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const cooldownIntervalRef = useRef(null)
  useEffect(() => () => clearInterval(cooldownIntervalRef.current), [])

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
        { phone }
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
    setOtpResetKey(k => k + 1)
    setLoading(true)
    try {
      await axios.post(
        `${API_URL}/api/auth/phone-otp/send`,
        { phone: form.phone.trim() }
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
    clearInterval(cooldownIntervalRef.current)
    setOtpCooldown(seconds)
    cooldownIntervalRef.current = setInterval(() => {
      setOtpCooldown(prev => {
        if (prev <= 1) { clearInterval(cooldownIntervalRef.current); return 0 }
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
        { phone: form.phone.trim(), code: otpCode }
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
        { ...form, phone_verified_token: token, terms_accepted: termsAccepted, signup_source: sessionStorage.getItem('signup_source') || 'direct' }
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
      // Go back to form step so user can retry
      setStep(STEP_FORM)
      setPhoneVerifiedToken(null)
    }
  }

  // ── Shared card header ──────────────────────────────────────────────────────
  const cardHeader = (
    <div style={{ textAlign: 'center', marginBottom: 'var(--space-7)' }}>
      <span className="auth-eyebrow" style={{ display: 'block', marginBottom: 'var(--space-3)' }}>
        {step === STEP_OTP ? 'Phone Verification' : 'New Account'}
      </span>
      <h1 style={{ fontSize: 'var(--fs-4xl)', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: 'var(--space-2)' }}>
        {step === STEP_OTP ? 'Verify your phone' : `Create your ${tenant?.name || 'trading'} account.`}
      </h1>
      <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-md)' }}>
        {step === STEP_OTP
          ? `Enter the 6-digit code sent to ${form.phone}`
          : tenant?.brand?.tagline || 'Join the premium prop firm today'}
      </p>
      {step === STEP_FORM && giftCode && giftPreview?.valid && (
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

        {/* ── Step indicator ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginBottom: '28px' }}>
          {['Details', 'Verify Phone'].map((label, i) => {
            const active = (i === 0 && step === STEP_FORM) || (i === 1 && step === STEP_OTP)
            const done   = (i === 0 && step === STEP_OTP)
            return (
              <React.Fragment key={label}>
                {i > 0 && <div style={{ flex: 1, height: '1px', background: done || step === STEP_OTP ? 'var(--accent)' : 'var(--border)' }} />}
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                  <div style={{
                    width: '22px', height: '22px', borderRadius: 'var(--radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 'var(--fs-xs)', fontWeight: 700, fontFamily: 'var(--font-mono)',
                    background: done ? 'var(--accent)' : active ? 'var(--accent)' : 'var(--bg-hover)',
                    color: done || active ? 'var(--paper)' : 'var(--text-muted)',
                    border: `1.5px solid ${done || active ? 'var(--accent)' : 'var(--border)'}`,
                    transition: 'all 0.3s'
                  }}>
                    {done ? '✓' : i + 1}
                  </div>
                  <span style={{ fontSize: 'var(--fs-sm)', fontWeight: active ? 600 : 400, fontFamily: 'var(--font-mono)', letterSpacing: '0.04em', textTransform: 'uppercase', color: active ? 'var(--accent)' : 'var(--text-muted)' }}>{label}</span>
                </div>
              </React.Fragment>
            )
          })}
        </div>

        {error  && <div className="error"  style={{ marginBottom: 'var(--space-4)' }}>{error}</div>}
        {success && <div className="success" style={{ marginBottom: 'var(--space-4)' }}>{success}</div>}

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
              <input type="email" name="email" className="input-field" value={form.email} onChange={handleChange} placeholder="your@email.com" required autoComplete="email" />
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
                    <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <span style={{ fontSize: 'var(--fs-2xs)', color: c.pass ? strength.color : 'var(--text-dim)' }}>{c.pass ? '✓' : '○'}</span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: c.pass ? 'var(--text-muted)' : 'var(--text-dim)' }}>{c.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="input-group">
              <label className="input-label" style={{ marginTop: 'var(--space-3)' }}>COUNTRY</label>
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
              <label className="input-label" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                PHONE / WHATSAPP
                <span style={{
                  fontSize: 'var(--fs-2xs)', fontWeight: 600, padding: '2px 7px', borderRadius: 'var(--radius-pill)',
                  background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)'
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
              <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: '5px', marginBottom: 0 }}>
                📱 We will send a verification code to this number. Your account will only be created after verification.
              </p>
            </div>

            <div className="input-group">
              <label className="input-label">REFERRAL CODE (optional)</label>
              <input type="text" name="referred_by" className="input-field" value={form.referred_by} onChange={handleChange} placeholder="Enter referral code if you have one" />
              {form.referred_by.trim() && !checkingReferral && referralCheck && (
                referralCheck.valid ? (
                  <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--gain)', marginTop: '5px', marginBottom: 0 }}>
                    ✓ Valid code — you'll get {referralCheck.discount_pct}% off your first challenge
                  </p>
                ) : (
                  <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: '5px', marginBottom: 0 }}>
                    Code not recognized — you can still register without it
                  </p>
                )
              )}
            </div>

            {/* Terms checkbox */}
            <div className="auth-consent-panel" style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2-5)',
              margin: '20px 0 16px', padding: 'var(--space-3-5)',
              borderColor: termsAccepted ? 'var(--accent)' : undefined,
              transition: 'border-color 0.2s ease'
            }}>
              <input type="checkbox" id="terms" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)}
                style={{ marginTop: '2px', accentColor: 'var(--accent)', cursor: 'pointer', flexShrink: 0 }} />
              <label htmlFor="terms" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: '1.6', cursor: 'pointer' }}>
                I have read and agree to the{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Terms of Service</a>,{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Privacy Policy</a>, and{' '}
                {/* Refund terms must be disclosed before purchase, not after —
                    linking them at the point of consent is what makes the
                    withdrawal-right waiver in the refund policy enforceable. */}
                <a href="/refund-policy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>Refund Policy</a>.
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
              {loading ? 'Sending code…' : 'Send Verification Code →'}
            </button>

            <p style={{ textAlign: 'center', marginTop: 'var(--space-6)', color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
              Already have an account?{' '}
              <Link to="/login" style={{ color: 'var(--accent)' }}>Sign in here</Link>
            </p>
          </form>
        )}

        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {/* STEP 2 — Enter OTP code                                    */}
        {/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */}
        {step === STEP_OTP && (
          <form onSubmit={handleVerifyOtp}>
            {/* OTP digit input */}
            <div className="input-group" style={{ marginBottom: 'var(--space-2)' }}>
              <label className="input-label" style={{ textAlign: 'center', display: 'block' }}>6-DIGIT VERIFICATION CODE</label>
              <OtpInput
                idPrefix="register-otp"
                resetKey={otpResetKey}
                disabled={loading}
                onChange={(code) => { setOtpCode(code); setError('') }}
              />
            </div>

            {/* Resend + change number */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
              <button
                type="button"
                onClick={handleResendOtp}
                disabled={otpCooldown > 0 || loading}
                style={{
                  background: 'none', border: 'none', cursor: otpCooldown > 0 ? 'default' : 'pointer',
                  color: otpCooldown > 0 ? 'var(--text-dim)' : 'var(--accent)',
                  fontSize: 'var(--fs-base)', padding: 0
                }}
              >
                {otpCooldown > 0 ? `Resend in ${otpCooldown}s` : 'Resend code'}
              </button>
              <button
                type="button"
                onClick={() => { setStep(STEP_FORM); setError(''); setSuccess(''); setOtpCode('') }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 'var(--fs-base)', padding: 0 }}
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

            <p style={{ textAlign: 'center', marginTop: 'var(--space-5)', fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', lineHeight: 1.6 }}>
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
