import React, { useState, useEffect, useCallback, useMemo } from 'react'
import api, { accountsAPI, affiliateAPI } from '../services/api'
import toast from 'react-hot-toast'
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../utils/instruments'
import { renderIcon } from '../utils/iconMap'

function Pill({ children, color = 'var(--accent)' }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 'var(--radius-pill)',
      fontSize: 'var(--fs-xs)', fontWeight: 700, letterSpacing: '0.06em',
      color, border: `1px solid ${color}`,
      background: `color-mix(in srgb, ${color} 15%, transparent)`
    }}>{children}</span>
  )
}

export default function GetChallenge({ onCreateAccount, kycStatus, setActivePage }) {
  const [models, setModels]             = useState([])
  const [loading, setLoading]           = useState(true)
  const [selectedModel, setSelectedModel] = useState(null) // slug
  const [confirmSize, setConfirmSize]   = useState(null)
  const [creating, setCreating]         = useState(false)
  const [error, setError]               = useState('')
  const [successMsg, setSuccessMsg]     = useState('')
  const [discountEligibility, setDiscountEligibility] = useState(null)
  const [showCouponField, setShowCouponField] = useState(false)
  const [couponCode, setCouponCode]     = useState('')
  const [couponResult, setCouponResult] = useState(null)
  const [couponError, setCouponError]   = useState('')
  const [validatingCoupon, setValidatingCoupon] = useState(false)
  const [purchaseLimit, setPurchaseLimit] = useState(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const modelsRes = await api.get('/api/accounts/step-models').catch(() => ({ data: { models: [] } }))
      setModels(modelsRes.data?.models || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    // Preview only — the server independently (and authoritatively) re-checks
    // eligibility when the order is actually created.
    affiliateAPI.getMyDiscountEligibility()
      .then(res => setDiscountEligibility(res.data))
      .catch(() => setDiscountEligibility(null))
  }, [])

  useEffect(() => {
    accountsAPI.getPurchaseLimit()
      .then(res => setPurchaseLimit(res.data))
      .catch(() => setPurchaseLimit(null))
  }, [])

  // Reset any applied coupon whenever the confirm target changes (new size
  // picked, or the modal is closed) — a coupon validated for one size/model
  // shouldn't silently carry over to another.
  useEffect(() => {
    setShowCouponField(false)
    setCouponCode('')
    setCouponResult(null)
    setCouponError('')
  }, [confirmSize])

  const model = useMemo(
    () => models.find((m) => m.slug === selectedModel) || null,
    [models, selectedModel]
  )

  const kycBlocked = kycStatus !== 'approved'

  function priceRange(m) {
    const prices = (m.pricing || []).filter((p) => p.is_active).map((p) => p.price)
    if (prices.length === 0) return null
    const min = Math.min(...prices)
    const max = Math.max(...prices)
    return min === max ? `$${min}` : `$${min} – $${max}`
  }

  function priceForSize(m, size) {
    const row = (m?.pricing || []).find((p) => p.account_size === size)
    return row && row.is_active ? row.price : null
  }

  async function handleApplyCoupon() {
    if (!couponCode.trim() || !model || !confirmSize || validatingCoupon) return
    setValidatingCoupon(true)
    setCouponError('')
    setCouponResult(null)
    const basePrice = priceForSize(model, confirmSize)
    const baseAmount = discountEligibility?.eligible
      ? basePrice * (1 - discountEligibility.discount_pct / 100)
      : basePrice
    try {
      const res = await accountsAPI.validateCoupon(couponCode.trim().toUpperCase(), {
        account_size: confirmSize,
        step_model: model.slug,
        base_amount: baseAmount
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

  async function handleConfirm() {
    if (!confirmSize || !model || creating) return
    if (kycBlocked) {
      setError('Complete KYC verification first before starting a challenge.')
      setConfirmSize(null)
      if (typeof setActivePage === 'function') setActivePage('kyc')
      return
    }
    setCreating(true)
    setError('')
    try {
      const orderRes = await api.post(
        '/api/accounts/orders',
        {
          account_size: confirmSize,
          step_model: model.slug,
          ...(couponResult?.valid ? { coupon_code: couponResult.code } : {})
        },
        { skipAuthRedirect: true }
      )
      const orderId = orderRes?.data?.order?.id
      if (orderRes?.data?.requires_payment === false && orderId) {
        // A referral discount and/or coupon covered the full price — the
        // order is already paid, nothing to send to Stripe. Full navigation
        // (not react-router) so Dashboard.jsx's own checkout=success handler
        // picks it up and creates the account, same as the Stripe redirect path.
        window.location.href = `/dashboard?checkout=success&order_id=${orderId}`
        return
      }
      const checkoutUrl = orderRes?.data?.checkout_url
      if (checkoutUrl) {
        window.location.href = checkoutUrl
        return
      }
      const paymentConfigured = !!orderRes?.data?.payment_configured
      setError(paymentConfigured
        ? 'Checkout was created, but no checkout URL was returned by the provider. Please try again or contact support.'
        : 'Payment is not configured yet for this platform. Please contact support to start a challenge.')
      setConfirmSize(null)
    } catch (err) {
      const data = err?.response?.data
      const message = data?.error || 'Could not start checkout. Please try again.'
      setError(message)
      toast.error(message)
      setConfirmSize(null)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div style={{ maxWidth: '1100px' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: 'var(--space-7)' }}>
        <h2 style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: 'var(--space-1-5)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {renderIcon('trade', { size: 22, color: 'var(--accent)' })}
            <span>Choose Your Challenge</span>
          </span>
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
          {model
            ? 'Select an account size, complete checkout, and begin your evaluation.'
            : 'Pick a 1-step, 2-step, or 3-step evaluation model to get started.'}
        </p>
      </div>

      {/* ── KYC Gate ── */}
      {kycBlocked && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
          padding: '18px 22px', borderRadius: '0', marginBottom: '28px',
          background: 'var(--warning-bg)',
          border: '1px solid var(--warn)',
        }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon('kyc', { size: 28, color: 'var(--warn)' })}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--warn)', marginBottom: 'var(--space-1)' }}>KYC Required</div>
            <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-muted)' }}>
              Complete identity verification before starting a challenge.
            </div>
          </div>
          <button
            onClick={() => setActivePage('kyc')}
            style={{
              padding: '9px 20px', borderRadius: '0', border: '1px solid var(--warn)',
              background: 'var(--warning-bg)', color: 'var(--warn)',
              fontSize: 'var(--fs-base)', fontWeight: 600, cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
              <span>Complete KYC</span>
              {renderIcon('arrow', { size: 14, color: 'currentColor' })}
            </span>
          </button>
        </div>
      )}

      {/* ── Purchase Quota ── */}
      {purchaseLimit?.limited && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
          padding: '14px 22px', borderRadius: '0', marginBottom: '28px',
          background: purchaseLimit.used >= purchaseLimit.max ? 'var(--warning-bg)' : 'var(--bg-surface)',
          border: `1px solid ${purchaseLimit.used >= purchaseLimit.max ? 'var(--warn)' : 'var(--border)'}`,
        }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon('info', { size: 20, color: purchaseLimit.used >= purchaseLimit.max ? 'var(--warn)' : 'var(--text-muted)' })}
          </span>
          <div style={{ flex: 1, fontSize: 'var(--fs-base)', color: purchaseLimit.used >= purchaseLimit.max ? 'var(--warn)' : 'var(--text-secondary)' }}>
            {purchaseLimit.used >= purchaseLimit.max
              ? `You've used all ${purchaseLimit.max} challenge purchase${purchaseLimit.max === 1 ? '' : 's'} allowed in this ${purchaseLimit.period_days}-day period.`
              : `You've used ${purchaseLimit.used} of ${purchaseLimit.max} challenge purchases allowed in this ${purchaseLimit.period_days}-day period.`}
            {purchaseLimit.resets_at && ` Resets ${new Date(purchaseLimit.resets_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.`}
          </div>
        </div>
      )}

      {/* ── Success / Error banners ── */}
      {successMsg && (
        <div style={{ padding: 'var(--space-3-5) var(--space-4-5)', borderRadius: '0', marginBottom: 'var(--space-5)', background: 'var(--success-bg)', border: '1px solid var(--green)', color: 'var(--green)', fontSize: 'var(--fs-md)', fontWeight: 600 }}>
          {successMsg}
        </div>
      )}
      {error && (
        <div style={{ padding: 'var(--space-3-5) var(--space-4-5)', borderRadius: '0', marginBottom: 'var(--space-5)', background: 'var(--danger-bg)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 'var(--fs-md)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 'var(--space-4-5)' }}>
          {Array(3).fill(0).map((_, i) => (
            <div key={i} style={{ height: '220px', borderRadius: '0', background: 'var(--bg-elevated)', border: '1px solid var(--border)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      ) : !model ? (
        /* ── Step 1: model picker ── */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 'var(--space-4-5)' }}>
          {models.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: 'var(--space-7)', textAlign: 'center', color: 'var(--text-muted)' }}>
              No challenge models are available right now. Please check back soon.
            </div>
          )}
          {models.map((m) => {
            const range = priceRange(m)
            const phase1 = {
              target: Array.isArray(m.profit_targets_pct) ? m.profit_targets_pct[0] : null,
              days: Array.isArray(m.time_limits_days) ? m.time_limits_days[0] : null
            }
            return (
              <button
                key={m.slug}
                onClick={() => { setError(''); setSelectedModel(m.slug) }}
                style={{
                  textAlign: 'left', cursor: 'pointer', border: '1px solid var(--border)',
                  background: 'var(--bg-elevated)', borderRadius: '0', padding: 'var(--space-6)',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--space-2-5)' }}>
                  <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 800, color: 'var(--text-primary)' }}>{m.name}</div>
                  <Pill color="var(--accent)">{m.steps === 1 ? '1 PHASE' : `${m.steps} PHASES`}</Pill>
                </div>
                <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text-muted)', marginBottom: 'var(--space-4-5)', minHeight: '36px' }}>{m.description}</p>
                <div style={{ display: 'flex', gap: 'var(--space-3-5)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('target', { size: 12, color: 'var(--accent)' })}<span>{phase1.target}% target</span>
                  </span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('floating_down', { size: 12, color: 'var(--accent-red)' })}<span>{parseFloat(m.max_drawdown_pct)}% DD</span>
                  </span>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('calendar', { size: 12, color: 'var(--text-secondary)' })}<span>{phase1.days}d</span>
                  </span>
                </div>
                <div style={{ fontSize: 'var(--fs-3xl)', fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                  {range || 'Contact support'}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 'var(--space-1)' }}>starting price</div>
              </button>
            )
          })}
        </div>
      ) : (
        /* ── Step 2: size picker for the chosen model ── */
        <>
          <button
            onClick={() => { setSelectedModel(null); setError('') }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)', marginBottom: 'var(--space-5)',
              background: 'transparent', border: 'none', color: 'var(--text-muted)',
              fontSize: 'var(--fs-base)', cursor: 'pointer', padding: 0
            }}
          >
            {renderIcon('arrow', { size: 14, color: 'currentColor', style: { transform: 'rotate(180deg)' } })}
            <span>Choose a different model</span>
          </button>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 'var(--space-3-5)', marginBottom: 'var(--space-7)'
          }}>
            {[
              { icon: 'target', label: `Phase 1 Target`, value: `${model.profit_targets_pct[0]}%` },
              { icon: 'floating_down', label: 'Max Drawdown', value: `${parseFloat(model.max_drawdown_pct)}%` },
              { icon: 'calendar', label: 'Challenge Days', value: `${model.time_limits_days[0]} days` },
              { icon: 'trade', label: 'Instruments', value: TRADABLE_INSTRUMENTS_SUMMARY, small: true },
            ].map(({ icon, label, value, small }) => (
              <div key={label} style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: '0', padding: 'var(--space-4) var(--space-5)',
              }}>
                <div style={{ marginBottom: 'var(--space-2)', display: 'inline-flex' }}>
                  {renderIcon(icon, { size: 20, color: 'var(--accent)' })}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 'var(--space-1)' }}>{label}</div>
                <div style={{ fontSize: small ? '13px' : '20px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: small ? 'inherit' : 'var(--font-mono)', lineHeight: 1.2 }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 'var(--space-4-5)', marginBottom: 'var(--space-8)' }}>
            {model.pricing.map((p) => {
              const size = p.account_size
              const locked = p.locked
              const remaining = p.remaining
              const isUnlimited = p.is_unlimited
              const price = p.is_active ? p.price : null
              const isLocked = locked || kycBlocked || price == null
              const almostFull = !isUnlimited && remaining !== null && remaining <= 5
              const reason = locked ? (p.is_active ? 'No slots available' : 'Not offered at this size') : null

              return (
                <button
                  key={size}
                  disabled={isLocked}
                  onClick={() => { setError(''); setSuccessMsg(''); setConfirmSize(size) }}
                  style={{
                    position: 'relative', border: 'none', textAlign: 'left', cursor: isLocked ? 'not-allowed' : 'pointer',
                    background: isLocked ? 'var(--bg-surface)' : 'var(--bg-elevated)',
                    borderRadius: '0', padding: '22px',
                    outline: confirmSize === size ? '2px solid var(--accent)' : `1px solid ${almostFull ? 'color-mix(in srgb, var(--warn) 50%, transparent)' : 'var(--border)'}`,
                    opacity: isLocked ? 0.52 : 1,
                    transition: 'all 0.2s ease',
                  }}
                >
                  <div style={{ position: 'absolute', top: '14px', right: '14px' }}>
                    {locked ? (
                      <Pill color="var(--text-muted)">FULL</Pill>
                    ) : price == null ? (
                      <Pill color="var(--text-muted)">UNAVAILABLE</Pill>
                    ) : almostFull ? (
                      <Pill color="var(--warn)">LOW</Pill>
                    ) : (
                      <Pill color="var(--green)">OPEN</Pill>
                    )}
                  </div>

                  <div style={{ fontSize: 'var(--fs-5xl)', fontWeight: 800, color: isLocked ? 'var(--text-muted)' : 'var(--accent)', fontFamily: 'var(--font-mono)', marginBottom: 'var(--space-1-5)', letterSpacing: '-0.02em' }}>
                    ${size.toLocaleString('en-US')}
                  </div>

                  <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 'var(--space-2-5)' }}>
                    {price != null ? `$${price}` : '—'}
                  </div>

                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
                    {locked
                      ? (reason || 'No slots available')
                      : isUnlimited
                        ? 'Unlimited slots'
                        : remaining !== null
                          ? `${remaining} slot${remaining !== 1 ? 's' : ''} remaining`
                          : 'Available'}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}

      {/* ── Confirm Modal ── */}
      {confirmSize && model && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 'var(--space-6)'
        }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmSize(null) }}
        >
          <div style={{
            background: 'var(--glass-2)', border: '1px solid var(--rule-soft)', borderTop: '3px double var(--ink)',
            padding: 'var(--space-7)', maxWidth: '440px', width: '100%',
            backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)',
            boxShadow: 'inset 0 1px 0 var(--glass-hi)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-3)' }}>
              {renderIcon('trade', { size: 40, color: 'var(--accent)' })}
            </div>
            <h3 style={{ fontSize: 'var(--fs-3xl)', fontWeight: 800, marginBottom: 'var(--space-2)', color: 'var(--text-primary)', textAlign: 'center' }}>
              Start ${confirmSize.toLocaleString()} {model.name} Challenge?
            </h3>
            {(() => {
              const basePrice = priceForSize(model, confirmSize)
              const priceAfterReferral = discountEligibility?.eligible
                ? basePrice * (1 - discountEligibility.discount_pct / 100)
                : basePrice
              const finalPrice = couponResult?.valid ? couponResult.final_amount : priceAfterReferral
              const hasDiscount = finalPrice < basePrice
              return (
                <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-md)', marginBottom: (discountEligibility?.eligible || couponResult?.valid) ? '8px' : '24px', lineHeight: 1.6, textAlign: 'center' }}>
                  You'll receive a simulated <strong style={{ color: 'var(--accent)' }}>${confirmSize.toLocaleString()}</strong> account and must hit a <strong>{model.profit_targets_pct[0]}%</strong> profit target within <strong>{model.time_limits_days[0]} days</strong> while staying within a <strong>{parseFloat(model.max_drawdown_pct)}%</strong> max drawdown. This challenge costs{' '}
                  {hasDiscount ? (
                    <>
                      <span style={{ textDecoration: 'line-through', color: 'var(--text-dim)' }}>${basePrice}</span>{' '}
                      <strong style={{ color: 'var(--gain)' }}>${finalPrice.toFixed(2)}</strong>
                    </>
                  ) : (
                    <strong style={{ color: 'var(--accent)' }}>${basePrice}</strong>
                  )}, paid securely via checkout.
                </p>
              )
            })()}
            {discountEligibility?.eligible && (
              <p style={{ color: 'var(--gain)', fontSize: 'var(--fs-sm)', marginBottom: couponResult?.valid ? '4px' : '24px', textAlign: 'center' }}>
                ✓ {discountEligibility.discount_pct}% referral discount applied (first challenge only)
              </p>
            )}
            {couponResult?.valid && (
              <p style={{ color: 'var(--gain)', fontSize: 'var(--fs-sm)', marginBottom: 'var(--space-6)', textAlign: 'center' }}>
                ✓ Coupon {couponResult.code} applied ({couponResult.discount_type === 'percent' ? `${couponResult.discount_value}% off` : `$${couponResult.discount_value} off`})
              </p>
            )}

            <div style={{ marginBottom: 'var(--space-5)', fontSize: 'var(--fs-base)' }}>
              {!showCouponField ? (
                <button
                  type="button"
                  onClick={() => setShowCouponField(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 'var(--fs-base)', cursor: 'pointer', padding: 0, display: 'block', margin: '0 auto' }}
                >
                  Have a coupon code?
                </button>
              ) : couponResult?.valid ? (
                <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 'var(--space-2-5)' }}>
                  <span style={{ color: 'var(--gain)' }}>✓ Coupon {couponResult.code} applied</span>
                  <button
                    type="button"
                    onClick={() => { setCouponResult(null); setCouponCode(''); setCouponError('') }}
                    style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', cursor: 'pointer', padding: 0 }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                    <input
                      type="text"
                      value={couponCode}
                      onChange={(e) => { setCouponCode(e.target.value); setCouponError('') }}
                      placeholder="e.g. SAVE20"
                      style={{
                        flex: 1, padding: '9px 10px', textTransform: 'uppercase',
                        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                        color: 'var(--text-primary)', fontSize: 'var(--fs-base)'
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleApplyCoupon}
                      disabled={!couponCode.trim() || validatingCoupon}
                      style={{
                        padding: '9px 16px', background: 'var(--accent)', color: 'var(--paper)',
                        border: 'none', fontSize: 'var(--fs-base)', fontWeight: 700,
                        cursor: (!couponCode.trim() || validatingCoupon) ? 'not-allowed' : 'pointer',
                        opacity: (!couponCode.trim() || validatingCoupon) ? 0.6 : 1
                      }}
                    >
                      {validatingCoupon ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {couponError && (
                    <div style={{ marginTop: 'var(--space-2)', color: 'var(--red)', fontSize: 'var(--fs-sm)' }}>{couponError}</div>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2-5)' }}>
              <button
                onClick={handleConfirm}
                disabled={creating}
                style={{
                  flex: 1, padding: '13px', borderRadius: '0',
                  background: 'var(--accent)', color: 'var(--paper)',
                  border: 'none', fontSize: 'var(--fs-md)', fontWeight: 700,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  opacity: creating ? 0.7 : 1, transition: 'opacity 0.2s'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1-5)' }}>
                  {creating
                    ? renderIcon('timer', { size: 14, color: 'currentColor' })
                    : renderIcon('approve', { size: 14, color: 'currentColor' })}
                  <span>{creating ? 'Redirecting...' : 'Continue to Payment'}</span>
                </span>
              </button>
              <button
                onClick={() => { setConfirmSize(null); setError('') }}
                disabled={creating}
                style={{
                  padding: '13px 20px', borderRadius: '0',
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontSize: 'var(--fs-md)', fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
            {error && (
              <div style={{ marginTop: 'var(--space-3-5)', padding: 'var(--space-2-5) var(--space-3-5)', borderRadius: '0', background: 'var(--danger-bg)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: 'var(--fs-base)' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── How it works ── */}
      {!model && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-7)', marginTop: 'var(--space-2)' }}>
          <h3 style={{ fontSize: 'var(--fs-lg)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 'var(--space-5)' }}>How it works</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)' }}>
            {[
              { step: '01', title: 'Pick a model', desc: '1-step, 2-step, or 3-step — fewer phases means a higher price, more phases means a lower price' },
              { step: '02', title: 'Pass the evaluation', desc: 'Hit each phase’s profit target within the time limit, staying within the drawdown rules' },
              { step: '03', title: 'Get funded', desc: 'Receive a live-simulated funded account with profit withdrawals enabled' },
            ].map(s => (
              <div key={s.step} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '0', padding: 'var(--space-4-5) var(--space-5)' }}>
                <div style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700, marginBottom: 'var(--space-2)', letterSpacing: '0.1em' }}>STEP {s.step}</div>
                <div style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 'var(--space-1-5)' }}>{s.title}</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
