import React, { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../providers/AuthProvider'
import api, { accountsAPI, affiliateAPI } from '../services/api'
import { getMemoryItem } from '../utils/memoryStore'

function sizeLabel(size) {
  if (size >= 200000) return 'Institutional'
  if (size >= 100000) return 'Enterprise'
  if (size >= 50000)  return 'Elite'
  if (size >= 25000)  return 'Pro'
  if (size >= 10000)  return 'Standard'
  if (size >= 5000)   return 'Advanced'
  return 'Starter'
}

export default function Checkout() {
  const { user, authChecked } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const voucherFromUrl = searchParams.get('voucher') || ''
  const [pending, setPending] = useState(undefined) // undefined = not checked yet, null = nothing stashed
  const [model, setModel] = useState(null)
  const [dataLoaded, setDataLoaded] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [discountEligibility, setDiscountEligibility] = useState(null)
  const [showVoucherField, setShowVoucherField] = useState(!!voucherFromUrl)
  const [voucherCode, setVoucherCode] = useState(voucherFromUrl)
  const [redeemingVoucher, setRedeemingVoucher] = useState(false)
  const [showCouponField, setShowCouponField] = useState(false)
  const [couponCode, setCouponCode] = useState('')
  const [couponResult, setCouponResult] = useState(null)
  const [couponError, setCouponError] = useState('')
  const [validatingCoupon, setValidatingCoupon] = useState(false)

  useEffect(() => {
    if (!user) return
    // Preview only — the server independently (and authoritatively) re-checks
    // eligibility when the order is actually created.
    affiliateAPI.getMyDiscountEligibility()
      .then(res => setDiscountEligibility(res.data))
      .catch(() => setDiscountEligibility(null))
  }, [user])

  useEffect(() => {
    const raw = getMemoryItem('pendingChallenge')
    if (!raw) {
      setPending(null)
      return
    }
    try {
      const parsed = JSON.parse(raw)
      setPending(parsed?.accountSize ? parsed : null)
    } catch {
      setPending(null)
    }
  }, [])

  useEffect(() => {
    if (pending === undefined) return
    if (pending === null) {
      setDataLoaded(true)
      return
    }
    let cancelled = false
    async function load() {
      try {
        const modelsRes = await accountsAPI.getPublicStepModels()
        if (cancelled) return
        const models = Array.isArray(modelsRes.data?.models) ? modelsRes.data.models : []
        const chosen = pending.stepModel
          ? models.find((m) => m.slug === pending.stepModel)
          : models[0]
        setModel(chosen || null)
      } catch {
        setModel(null)
      } finally {
        if (!cancelled) setDataLoaded(true)
      }
    }
    load()
    return () => { cancelled = true }
  }, [pending])

  const availability = model
    ? (model.pricing || []).find((p) => p.account_size === Number(pending?.accountSize))
    : null
  const price = availability?.is_active ? availability.price : null
  const priceAfterReferral = price != null && discountEligibility?.eligible
    ? price * (1 - discountEligibility.discount_pct / 100)
    : price
  const finalPrice = price != null
    ? (couponResult?.valid ? couponResult.final_amount : priceAfterReferral)
    : null
  const isLocked = availability ? (availability.locked || !availability.is_active) : false
  const targets = Array.isArray(model?.profit_targets_pct) ? model.profit_targets_pct : []
  const days = Array.isArray(model?.time_limits_days) ? model.time_limits_days[0] : null

  async function handleApplyCoupon() {
    if (!couponCode.trim() || !model || price == null || validatingCoupon) return
    setValidatingCoupon(true)
    setCouponError('')
    setCouponResult(null)
    try {
      const res = await accountsAPI.validateCoupon(couponCode.trim().toUpperCase(), {
        account_size: pending.accountSize,
        step_model: model.slug,
        base_amount: priceAfterReferral
      })
      if (res?.data?.valid) {
        setCouponResult(res.data)
      } else {
        setCouponError(res?.data?.error || 'This coupon code is not valid')
      }
    } catch (err) {
      setCouponError(err?.response?.data?.error || 'Could not validate this coupon code')
    } finally {
      setValidatingCoupon(false)
    }
  }

  async function handlePay() {
    if (!model || !pending || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const res = await api.post(
        '/api/accounts/orders',
        {
          account_size: pending.accountSize,
          step_model: model.slug,
          ...(couponResult?.valid ? { coupon_code: couponResult.code } : {})
        },
        { skipAuthRedirect: true }
      )
      const orderId = res?.data?.order?.id
      if (res?.data?.requires_payment === false && orderId) {
        // A referral discount and/or coupon covered the full price — the
        // order is already paid, nothing to send to Stripe. Same post-checkout
        // flow the voucher redemption below uses.
        navigate(`/dashboard?checkout=success&order_id=${orderId}`)
        return
      }
      const checkoutUrl = res?.data?.checkout_url
      if (checkoutUrl) {
        window.location.href = checkoutUrl
        return
      }
      const paymentConfigured = !!res?.data?.payment_configured
      setError(paymentConfigured
        ? 'Checkout was created, but no payment URL was returned. Please try again or contact support.'
        : 'Payments are not configured yet for this platform. Please contact support to start a challenge.')
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not start checkout. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleRedeemVoucher() {
    if (!voucherCode.trim() || redeemingVoucher) return
    setRedeemingVoucher(true)
    setError('')
    try {
      const res = await api.post(
        '/api/accounts/orders',
        { voucher_code: voucherCode.trim().toUpperCase() },
        { skipAuthRedirect: true }
      )
      const orderId = res?.data?.order?.id
      if (!orderId) {
        setError('Voucher redeemed, but no order was returned. Please contact support.')
        return
      }
      // Reuses the exact same post-checkout flow Stripe redirects use — the
      // order is already status='paid', so Dashboard.jsx's poll succeeds on
      // its first attempt and creates the account immediately.
      navigate(`/dashboard?checkout=success&order_id=${orderId}`)
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not redeem this voucher. Please check the code and try again.')
    } finally {
      setRedeemingVoucher(false)
    }
  }

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
      <Link
        to="/"
        className="auth-secondary-button"
        style={{ position: 'absolute', top: '24px', left: '24px', width: 'auto', display: 'inline-block', textDecoration: 'none', zIndex: 20 }}
      >
        ← Back to Home
      </Link>

      <div className="auth-ambient auth-ambient-primary" />
      <div className="auth-ambient auth-ambient-secondary" />

      <div className="lx-card auth-glass-card" style={{ width: 'min(100%, 520px)', zIndex: 10, padding: '40px 32px' }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div className="auth-logo-mark" style={{ margin: '0 auto 16px' }}>⚡</div>
          <h1 style={{ fontSize: '24px', fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--text-primary)', marginBottom: '8px' }}>
            Review Your Challenge
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
            Confirm your plan, then continue to secure payment.
          </p>
        </div>

        {authChecked && user && (
          <div style={{ border: '1px solid var(--rule)', padding: '16px 20px', marginBottom: '20px' }}>
            {!showVoucherField ? (
              <button
                onClick={() => setShowVoucherField(true)}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '13px', cursor: 'pointer', padding: 0 }}
              >
                Have a prize voucher code?
              </button>
            ) : (
              <>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                  Redeem a competition prize voucher for a free challenge account — no payment required.
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <input
                    type="text"
                    value={voucherCode}
                    onChange={(e) => setVoucherCode(e.target.value)}
                    placeholder="e.g. WIN-9F3A2B1C0D"
                    className="input"
                    style={{ flex: 1, textTransform: 'uppercase' }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ width: 'auto', padding: '0 20px' }}
                    disabled={!voucherCode.trim() || redeemingVoucher}
                    onClick={handleRedeemVoucher}
                  >
                    {redeemingVoucher ? 'Redeeming…' : 'Redeem'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {authChecked && user && dataLoaded && pending && model && (
          <div style={{ border: '1px solid var(--rule)', padding: '16px 20px', marginBottom: '20px' }}>
            {!showCouponField ? (
              <button
                onClick={() => setShowCouponField(true)}
                style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '13px', cursor: 'pointer', padding: 0 }}
              >
                Have a coupon code?
              </button>
            ) : couponResult?.valid ? (
              <div style={{ fontSize: '13px', color: 'var(--gain)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>✓ Coupon {couponResult.code} applied</span>
                <button
                  onClick={() => { setCouponResult(null); setCouponCode(''); setCouponError('') }}
                  style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '12px', cursor: 'pointer', padding: 0 }}
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '10px' }}>
                  Enter a coupon code to get a discount on this challenge.
                </div>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <input
                    type="text"
                    value={couponCode}
                    onChange={(e) => { setCouponCode(e.target.value); setCouponError('') }}
                    placeholder="e.g. SAVE20"
                    className="input"
                    style={{ flex: 1, textTransform: 'uppercase' }}
                  />
                  <button
                    className="btn btn-primary"
                    style={{ width: 'auto', padding: '0 20px' }}
                    disabled={!couponCode.trim() || validatingCoupon}
                    onClick={handleApplyCoupon}
                  >
                    {validatingCoupon ? 'Checking…' : 'Apply'}
                  </button>
                </div>
                {couponError && <div className="error" style={{ marginTop: '10px', fontSize: '12px' }}>{couponError}</div>}
              </>
            )}
          </div>
        )}

        {error && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}

        {!dataLoaded && (
          <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
            Loading your selection…
          </div>
        )}

        {dataLoaded && pending === null && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
              You haven't picked a challenge yet.
            </p>
            <Link to="/#mp-accounts" className="btn btn-primary" style={{ textDecoration: 'none' }}>
              Choose Your Challenge
            </Link>
          </div>
        )}

        {dataLoaded && pending && !model && (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '20px' }}>
              We couldn't load this challenge model. It may no longer be available.
            </p>
            <Link to="/#mp-accounts" className="btn btn-primary" style={{ textDecoration: 'none' }}>
              Choose a Different Challenge
            </Link>
          </div>
        )}

        {dataLoaded && pending && model && (
          <>
            <div style={{ border: '1px solid var(--rule)', padding: '20px', marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '4px' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  {model.name}
                </span>
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: '22px', fontWeight: 800, color: 'var(--accent)' }}>
                  {price != null ? (
                    finalPrice != null && finalPrice < price ? (
                      <>
                        <span style={{ textDecoration: 'line-through', color: 'var(--text-dim)', fontSize: '15px', marginRight: '8px' }}>${price}</span>
                        <span style={{ color: 'var(--gain)' }}>${finalPrice.toFixed(2)}</span>
                      </>
                    ) : `$${price}`
                  ) : '—'}
                </span>
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: discountEligibility?.eligible || couponResult?.valid ? '4px' : '16px' }}>
                ${Number(pending.accountSize).toLocaleString('en-US')} account · {sizeLabel(pending.accountSize)}
              </div>
              {discountEligibility?.eligible && (
                <div style={{ fontSize: '12px', color: 'var(--gain)', marginBottom: couponResult?.valid ? '4px' : '16px' }}>
                  ✓ {discountEligibility.discount_pct}% referral discount applied (first challenge only)
                </div>
              )}
              {couponResult?.valid && (
                <div style={{ fontSize: '12px', color: 'var(--gain)', marginBottom: '16px' }}>
                  ✓ Coupon {couponResult.code} applied ({couponResult.discount_type === 'percent' ? `${couponResult.discount_value}% off` : `$${couponResult.discount_value} off`})
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '12px' }}>
                {targets.map((t, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Phase {i + 1} Target</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{t}%</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Max Drawdown</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{model.max_drawdown_pct}%</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Daily Drawdown</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{model.daily_drawdown_pct}%</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Min Trading Days</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{model.min_trading_days}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Time Limit</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{days ? `${days}d` : '—'}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Split</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{model.profit_split_pct}% Weekly</span>
                </div>
              </div>
            </div>

            {isLocked && (
              <div className="error" style={{ marginBottom: '16px' }}>
                This account size just filled up. Please pick a different size.
              </div>
            )}

            {!authChecked && (
              <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
                Checking your session…
              </div>
            )}

            {authChecked && !user && (
              <div style={{ display: 'flex', gap: '12px' }}>
                <Link to="/register" className="btn btn-primary" style={{ flex: 1, textDecoration: 'none', textAlign: 'center' }}>
                  Create Account
                </Link>
                <Link to="/login" className="btn btn-secondary" style={{ flex: 1, textDecoration: 'none', textAlign: 'center' }}>
                  Log In
                </Link>
              </div>
            )}

            {authChecked && user && (
              <button
                className="btn btn-primary"
                style={{ width: '100%' }}
                disabled={submitting || isLocked}
                onClick={handlePay}
              >
                {submitting ? 'Redirecting to payment…' : 'Proceed to Payment'}
              </button>
            )}

            <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', marginTop: '16px' }}>
              You'll complete secure payment on our payment provider's page, then return here automatically.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
