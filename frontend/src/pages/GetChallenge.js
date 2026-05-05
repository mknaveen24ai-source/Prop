import React, { useState, useEffect, useCallback } from 'react'
import api from '../services/api'
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../utils/instruments'
import { useBranding } from '../BrandingContext'
import { renderIcon } from '../utils/iconMap'

function formatDate(iso) {
  if (!iso) return null
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) }
  catch { return null }
}

function Pill({ children, color = 'var(--accent)' }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: '99px',
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.06em',
      color, border: `1px solid ${color}`,
      background: `${color}15`
    }}>{children}</span>
  )
}

export default function GetChallenge({ onCreateAccount, kycStatus, setActivePage }) {
  const { tenant } = useBranding()
  const [sizes, setSizes]               = useState([])
  const [rules, setRules]               = useState({})
  const [purchaseLimit, setPurchaseLimit] = useState(null)
  const [loading, setLoading]           = useState(true)
  const [confirmSize, setConfirmSize]   = useState(null)   // size being confirmed
  const [creating, setCreating]         = useState(false)
  const [error, setError]               = useState('')
  const [successMsg, setSuccessMsg]     = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [sizesRes, rulesRes, limitRes] = await Promise.all([
        api.get('/api/accounts/available-sizes').catch(() => ({ data: [] })),
        api.get('/api/accounts/platform-rules').catch(() => ({ data: {} })),
        api.get('/api/accounts/my-purchase-limit').catch(() => ({ data: { limited: false } })),
      ])
      setSizes(sizesRes.data || [])
      setRules(rulesRes.data || {})
      setPurchaseLimit(limitRes.data)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  async function handleConfirm() {
    if (!confirmSize || creating) return
    setCreating(true)
    setError('')
    try {
      const orderRes = await api.post('/api/accounts/orders', { account_size: confirmSize })
      const order = orderRes?.data?.order
      const requiresPayment = !!orderRes?.data?.requires_payment
      if (requiresPayment && order?.status !== 'paid') {
        if (orderRes?.data?.checkout_url) {
          window.location.href = orderRes.data.checkout_url
          return
        }
        const paymentConfigured = !!orderRes?.data?.payment_configured
        setError(paymentConfigured
          ? 'Checkout was created, but no checkout URL was returned by the provider.'
          : 'This tenant requires payment before challenge creation, but no payment provider is configured yet.')
        setConfirmSize(null)
        return
      }
      await onCreateAccount(confirmSize, { challengeOrderId: order?.id })
      setSuccessMsg(`$${confirmSize.toLocaleString()} challenge started! Head to Trade to begin.`)
      setConfirmSize(null)
      loadAll()
    } catch (err) {
      const data = err?.response?.data
      setError(data?.error || 'Could not create account. Please try again.')
    } finally {
      setCreating(false)
    }
  }

  const profitTarget  = parseFloat(rules.phase1_profit_target_pct || 10)
  const maxDrawdown   = parseFloat(rules.phase1_max_drawdown_pct  || 10)
  const dayLimit      = parseInt(rules.phase1_day_limit           || 30)
  const requiresPayment = !!rules.requires_payment || tenant?.settings?.requires_payment === 'true'
  const challengeFeeAmount = parseFloat(rules.challenge_fee_amount || tenant?.settings?.challenge_fee_amount || 0)
  const challengeFeeCurrency = rules.challenge_fee_currency || tenant?.settings?.challenge_fee_currency || 'USD'
  const challengeFeeLabel = rules.challenge_fee_label || tenant?.settings?.challenge_fee_label || (requiresPayment ? `${challengeFeeCurrency} ${challengeFeeAmount.toFixed(2)}` : 'FREE')

  const limitReached  = purchaseLimit?.limited && purchaseLimit?.limit_reached
  const limitUsed     = purchaseLimit?.used || 0
  const limitMax      = purchaseLimit?.max || null
  const resetsAt      = purchaseLimit?.resets_at ? formatDate(purchaseLimit.resets_at) : null
  const periodDays    = purchaseLimit?.period_days || 30

  const kycBlocked = kycStatus !== 'approved'

  return (
    <div style={{ maxWidth: '1100px' }}>

      {/* ── Header ── */}
      <div style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {renderIcon('trade', { size: 22, color: 'var(--accent)' })}
            <span>Start a Challenge</span>
          </span>
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {requiresPayment
            ? 'Select an account size, complete checkout, and begin your evaluation.'
            : 'Select an account size to start your prop firm challenge.'}
        </p>
      </div>

      {/* ── KYC Gate ── */}
      {kycBlocked && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '16px',
          padding: '18px 22px', borderRadius: '14px', marginBottom: '28px',
          background: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
        }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon('kyc', { size: 28, color: '#f59e0b' })}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: '#f59e0b', marginBottom: '4px' }}>KYC Required</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Complete identity verification before starting a challenge.
            </div>
          </div>
          <button
            onClick={() => setActivePage('kyc')}
            style={{
              padding: '9px 20px', borderRadius: '10px', border: '1px solid #f59e0b',
              background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
              fontSize: '13px', fontWeight: 600, cursor: 'pointer',
              whiteSpace: 'nowrap'
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <span>Complete KYC</span>
              {renderIcon('arrow', { size: 14, color: 'currentColor' })}
            </span>
          </button>
        </div>
      )}

      {/* ── Per-user purchase limit bar ── */}
      {purchaseLimit?.limited && limitMax && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '14px',
          padding: '14px 20px', borderRadius: '12px', marginBottom: '24px',
          background: limitReached ? 'rgba(239,68,68,0.07)' : 'rgba(148,148,148,0.06)',
          border: `1px solid ${limitReached ? 'rgba(239,68,68,0.35)' : 'rgba(148,148,148,0.2)'}`,
        }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon(limitReached ? 'reject' : 'file', {
              size: 20,
              color: limitReached ? 'var(--accent-red)' : 'var(--accent)'
            })}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: limitReached ? 'var(--red)' : 'var(--text-primary)', marginBottom: '4px' }}>
              {limitReached
                ? `Purchase limit reached (${limitUsed}/${limitMax} per ${periodDays} days)`
                : `${limitUsed} of ${limitMax} challenges used this ${periodDays}-day window`}
            </div>
            {limitReached && resetsAt && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Limit resets on <strong>{resetsAt}</strong>
              </div>
            )}
            {!limitReached && (
              <div style={{ marginTop: '6px', height: '4px', borderRadius: '2px', background: 'var(--border)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '2px',
                  width: `${Math.min((limitUsed / limitMax) * 100, 100)}%`,
                  background: limitUsed >= limitMax * 0.75 ? 'var(--danger)' : 'var(--accent)',
                  transition: 'width 0.4s ease'
                }} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Success / Error banners ── */}
      {successMsg && (
        <div style={{ padding: '14px 18px', borderRadius: '10px', marginBottom: '20px', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', color: 'var(--green)', fontSize: '14px', fontWeight: 600 }}>
          {successMsg}
        </div>
      )}
      {error && (
        <div style={{ padding: '14px 18px', borderRadius: '10px', marginBottom: '20px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--red)', fontSize: '14px' }}>
          {error}
        </div>
      )}

      {/* ── Challenge Rules Overview ── */}
      {!loading && (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '14px', marginBottom: '32px'
        }}>
          {[
            { icon: 'target', label: 'Phase 1 Target',  value: `${profitTarget}%` },
            { icon: 'floating_down', label: 'Max Drawdown', value: `${maxDrawdown}%` },
            { icon: 'calendar', label: 'Challenge Days', value: `${dayLimit} days` },
            { icon: 'payouts', label: 'Challenge Fee', value: requiresPayment ? `${challengeFeeCurrency} ${challengeFeeAmount.toFixed(2)}` : challengeFeeLabel, color: requiresPayment ? 'var(--accent)' : 'var(--green)' },
            { icon: 'trade', label: 'Instruments', value: TRADABLE_INSTRUMENTS_SUMMARY, small: true },
          ].map(({ icon, label, value, color, small }) => (
            <div key={label} style={{
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: '14px', padding: '16px 20px',
            }}>
              <div style={{ marginBottom: '8px', display: 'inline-flex' }}>
                {renderIcon(icon, { size: 20, color: color || 'var(--accent)' })}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
              <div style={{ fontSize: small ? '13px' : '20px', fontWeight: 700, color: color || 'var(--text-primary)', fontFamily: small ? 'inherit' : 'var(--font-mono)', lineHeight: 1.2 }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Account Size Grid ── */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '18px' }}>
          {Array(6).fill(0).map((_, i) => (
            <div key={i} style={{ height: '180px', borderRadius: '16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '18px', marginBottom: '40px' }}>
          {sizes.map(({ size, locked, remaining, quota, reason }) => {
            const isLocked   = locked || limitReached || kycBlocked
            const isUnlimited = quota === null || (quota >= 999999)
            const fillPct    = (!isUnlimited && quota > 0) ? Math.min(((quota - (remaining ?? 0)) / quota) * 100, 100) : 0
            const almostFull = !isUnlimited && remaining !== null && remaining <= 5

            return (
              <button
                key={size}
                disabled={isLocked}
                onClick={() => { setError(''); setSuccessMsg(''); setConfirmSize(size) }}
                style={{
                  position: 'relative', border: 'none', textAlign: 'left', cursor: isLocked ? 'not-allowed' : 'pointer',
                  background: isLocked ? 'var(--bg-surface)' : 'var(--bg-elevated)',
                  borderRadius: '16px', padding: '22px',
                  outline: confirmSize === size ? '2px solid var(--accent)' : `1px solid ${almostFull ? 'rgba(245,158,11,0.5)' : 'var(--border)'}`,
                  opacity: isLocked ? 0.52 : 1,
                  transition: 'all 0.2s ease',
                  boxShadow: !isLocked && confirmSize !== size ? 'none' : !isLocked ? '0 0 0 2px var(--accent-glow)' : 'none',
                }}
                onMouseEnter={e => { if (!isLocked) e.currentTarget.style.transform = 'translateY(-2px)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none' }}
              >
                {/* Status badge */}
                <div style={{ position: 'absolute', top: '14px', right: '14px' }}>
                  {locked ? (
                    <Pill color="var(--text-muted)">FULL</Pill>
                  ) : almostFull ? (
                    <Pill color="#f59e0b">LOW</Pill>
                  ) : isUnlimited ? (
                    <Pill color="var(--accent)">OPEN</Pill>
                  ) : (
                    <Pill color="var(--green)">OPEN</Pill>
                  )}
                </div>

                {/* Size */}
                <div style={{ fontSize: '28px', fontWeight: 800, color: isLocked ? 'var(--text-muted)' : 'var(--accent)', fontFamily: 'var(--font-mono)', marginBottom: '6px', letterSpacing: '-0.02em' }}>
                  ${size.toLocaleString('en-US')}
                </div>

                {/* Slots remaining */}
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '14px' }}>
                  {locked
                    ? (reason || 'No slots available')
                    : isUnlimited
                      ? 'Unlimited slots'
                      : remaining !== null
                        ? `${remaining} slot${remaining !== 1 ? 's' : ''} remaining`
                        : 'Available'}
                </div>

                {/* Progress bar */}
                {!isUnlimited && quota > 0 && remaining !== null && (
                  <div style={{ height: '4px', borderRadius: '2px', background: 'var(--border)', overflow: 'hidden', marginBottom: '14px' }}>
                    <div style={{
                      height: '100%', borderRadius: '2px',
                      width: `${fillPct}%`,
                      background: fillPct >= 90 ? 'var(--danger)' : fillPct >= 70 ? '#f59e0b' : 'var(--accent)',
                      transition: 'width 0.4s ease'
                    }} />
                  </div>
                )}

                {/* Mini challenge rules */}
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{renderIcon('target', { size: 12, color: 'var(--accent)' })}<span>{profitTarget}% target</span></span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{renderIcon('floating_down', { size: 12, color: 'var(--accent-red)' })}<span>{maxDrawdown}% DD</span></span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>{renderIcon('calendar', { size: 12, color: 'var(--text-secondary)' })}<span>{dayLimit}d</span></span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Confirm Modal ── */}
      {confirmSize && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(6px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px'
        }}
          onClick={e => { if (e.target === e.currentTarget) setConfirmSize(null) }}
        >
          <div style={{
            background: 'var(--bg-elevated)', border: '1px solid var(--border)',
            borderRadius: '20px', padding: '32px', maxWidth: '440px', width: '100%',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)'
          }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
              {renderIcon('trade', { size: 40, color: 'var(--accent)' })}
            </div>
            <h3 style={{ fontSize: '22px', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)' }}>
              Start ${confirmSize.toLocaleString()} Challenge?
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px', lineHeight: 1.6 }}>
              You'll receive a simulated <strong style={{ color: 'var(--accent)' }}>${confirmSize.toLocaleString()}</strong> account and must hit a <strong>{profitTarget}%</strong> profit target within <strong>{dayLimit} days</strong> while staying within a <strong>{maxDrawdown}%</strong> max drawdown. {requiresPayment ? <>This challenge requires <strong style={{ color: 'var(--accent)' }}>{challengeFeeCurrency} {challengeFeeAmount.toFixed(2)}</strong> checkout before activation.</> : <>This challenge is <strong style={{ color: 'var(--green)' }}>{challengeFeeLabel}</strong>.</>}
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleConfirm}
                disabled={creating}
                style={{
                  flex: 1, padding: '13px', borderRadius: '12px',
                  background: 'var(--accent)', color: '#fff',
                  border: 'none', fontSize: '14px', fontWeight: 700,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  opacity: creating ? 0.7 : 1, transition: 'opacity 0.2s'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  {creating
                    ? renderIcon('timer', { size: 14, color: 'currentColor' })
                    : renderIcon('approve', { size: 14, color: 'currentColor' })}
                  <span>{creating ? 'Starting...' : 'Start Challenge'}</span>
                </span>
              </button>
              <button
                onClick={() => { setConfirmSize(null); setError('') }}
                disabled={creating}
                style={{
                  padding: '13px 20px', borderRadius: '12px',
                  background: 'transparent', border: '1px solid var(--border)',
                  color: 'var(--text-muted)', fontSize: '14px', fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                Cancel
              </button>
            </div>
            {error && (
              <div style={{ marginTop: '14px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--red)', fontSize: '13px' }}>
                {error}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── How it works ── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '32px' }}>
        <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '20px' }}>How it works</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
          {[
            { step: '01', title: 'Pass Phase 1', desc: `Hit ${profitTarget}% profit within ${dayLimit} days, stay within ${maxDrawdown}% drawdown` },
            { step: '02', title: 'Pass Phase 2', desc: 'Smaller profit target, same drawdown rules — proves consistency' },
            { step: '03', title: 'Get Funded', desc: 'Receive a live-simulated funded account with profit withdrawals enabled' },
          ].map(s => (
            <div key={s.step} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px 20px' }}>
              <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700, marginBottom: '8px', letterSpacing: '0.1em' }}>STEP {s.step}</div>
              <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>{s.title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{s.desc}</div>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}
