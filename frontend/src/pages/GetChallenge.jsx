import React, { useState, useEffect, useCallback, useMemo } from 'react'
import api from '../services/api'
import toast from 'react-hot-toast'
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../utils/instruments'
import { renderIcon } from '../utils/iconMap'

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
  const [models, setModels]             = useState([])
  const [sizes, setSizes]               = useState([])
  const [loading, setLoading]           = useState(true)
  const [selectedModel, setSelectedModel] = useState(null) // slug
  const [confirmSize, setConfirmSize]   = useState(null)
  const [creating, setCreating]         = useState(false)
  const [error, setError]               = useState('')
  const [successMsg, setSuccessMsg]     = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [modelsRes, sizesRes] = await Promise.all([
        api.get('/api/accounts/step-models').catch(() => ({ data: { models: [] } })),
        api.get('/api/accounts/available-sizes').catch(() => ({ data: [] })),
      ])
      setModels(modelsRes.data?.models || [])
      setSizes(sizesRes.data || [])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

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
        { account_size: confirmSize, step_model: model.slug },
        { skipAuthRedirect: true }
      )
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
      <div style={{ marginBottom: '32px' }}>
        <h2 style={{ fontSize: '26px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
            {renderIcon('trade', { size: 22, color: 'var(--accent)' })}
            <span>Choose Your Challenge</span>
          </span>
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          {model
            ? 'Select an account size, complete checkout, and begin your evaluation.'
            : 'Pick a 1-step, 2-step, or 3-step evaluation model to get started.'}
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
            {renderIcon('kyc', { size: 28, color: 'var(--warn)' })}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--warn)', marginBottom: '4px' }}>KYC Required</div>
            <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
              Complete identity verification before starting a challenge.
            </div>
          </div>
          <button
            onClick={() => setActivePage('kyc')}
            style={{
              padding: '9px 20px', borderRadius: '10px', border: '1px solid var(--warn)',
              background: 'rgba(245,158,11,0.12)', color: 'var(--warn)',
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

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '18px' }}>
          {Array(3).fill(0).map((_, i) => (
            <div key={i} style={{ height: '220px', borderRadius: '16px', background: 'var(--bg-elevated)', border: '1px solid var(--border)', animation: 'pulse 1.5s ease-in-out infinite' }} />
          ))}
        </div>
      ) : !model ? (
        /* ── Step 1: model picker ── */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '18px' }}>
          {models.length === 0 && (
            <div style={{ gridColumn: '1 / -1', padding: '32px', textAlign: 'center', color: 'var(--text-muted)' }}>
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
                  background: 'var(--bg-elevated)', borderRadius: '16px', padding: '24px',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.borderColor = 'var(--accent)' }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                  <div style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)' }}>{m.name}</div>
                  <Pill color="var(--accent)">{m.steps === 1 ? '1 PHASE' : `${m.steps} PHASES`}</Pill>
                </div>
                <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginBottom: '18px', minHeight: '36px' }}>{m.description}</p>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '16px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('target', { size: 12, color: 'var(--accent)' })}<span>{phase1.target}% target</span>
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('floating_down', { size: 12, color: 'var(--accent-red)' })}<span>{parseFloat(m.max_drawdown_pct)}% DD</span>
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('calendar', { size: 12, color: 'var(--text-secondary)' })}<span>{phase1.days}d</span>
                  </span>
                </div>
                <div style={{ fontSize: '22px', fontWeight: 800, color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                  {range || 'Contact support'}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>starting price</div>
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
              display: 'inline-flex', alignItems: 'center', gap: '6px', marginBottom: '20px',
              background: 'transparent', border: 'none', color: 'var(--text-muted)',
              fontSize: '13px', cursor: 'pointer', padding: 0
            }}
          >
            {renderIcon('arrow', { size: 14, color: 'currentColor', style: { transform: 'rotate(180deg)' } })}
            <span>Choose a different model</span>
          </button>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '14px', marginBottom: '32px'
          }}>
            {[
              { icon: 'target', label: `Phase 1 Target`, value: `${model.profit_targets_pct[0]}%` },
              { icon: 'floating_down', label: 'Max Drawdown', value: `${parseFloat(model.max_drawdown_pct)}%` },
              { icon: 'calendar', label: 'Challenge Days', value: `${model.time_limits_days[0]} days` },
              { icon: 'trade', label: 'Instruments', value: TRADABLE_INSTRUMENTS_SUMMARY, small: true },
            ].map(({ icon, label, value, small }) => (
              <div key={label} style={{
                background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                borderRadius: '14px', padding: '16px 20px',
              }}>
                <div style={{ marginBottom: '8px', display: 'inline-flex' }}>
                  {renderIcon(icon, { size: 20, color: 'var(--accent)' })}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '4px' }}>{label}</div>
                <div style={{ fontSize: small ? '13px' : '20px', fontWeight: 700, color: 'var(--text-primary)', fontFamily: small ? 'inherit' : 'var(--font-mono)', lineHeight: 1.2 }}>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '18px', marginBottom: '40px' }}>
            {sizes.map(({ size, locked, remaining, quota, reason }) => {
              const price = priceForSize(model, size)
              const isLocked = locked || kycBlocked || price == null
              const isUnlimited = quota === null || (quota >= 999999)
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

                  <div style={{ fontSize: '28px', fontWeight: 800, color: isLocked ? 'var(--text-muted)' : 'var(--accent)', fontFamily: 'var(--font-mono)', marginBottom: '6px', letterSpacing: '-0.02em' }}>
                    ${size.toLocaleString('en-US')}
                  </div>

                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '10px' }}>
                    {price != null ? `$${price}` : '—'}
                  </div>

                  <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
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
            <h3 style={{ fontSize: '22px', fontWeight: 800, marginBottom: '8px', color: 'var(--text-primary)', textAlign: 'center' }}>
              Start ${confirmSize.toLocaleString()} {model.name} Challenge?
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginBottom: '24px', lineHeight: 1.6, textAlign: 'center' }}>
              You'll receive a simulated <strong style={{ color: 'var(--accent)' }}>${confirmSize.toLocaleString()}</strong> account and must hit a <strong>{model.profit_targets_pct[0]}%</strong> profit target within <strong>{model.time_limits_days[0]} days</strong> while staying within a <strong>{parseFloat(model.max_drawdown_pct)}%</strong> max drawdown. This challenge costs <strong style={{ color: 'var(--accent)' }}>${priceForSize(model, confirmSize)}</strong>, paid securely via checkout.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={handleConfirm}
                disabled={creating}
                style={{
                  flex: 1, padding: '13px', borderRadius: '12px',
                  background: 'var(--accent)', color: 'var(--paper)',
                  border: 'none', fontSize: '14px', fontWeight: 700,
                  cursor: creating ? 'not-allowed' : 'pointer',
                  opacity: creating ? 0.7 : 1, transition: 'opacity 0.2s'
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
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
      {!model && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '32px', marginTop: '8px' }}>
          <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '20px' }}>How it works</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px' }}>
            {[
              { step: '01', title: 'Pick a model', desc: '1-step, 2-step, or 3-step — fewer phases means a higher price, more phases means a lower price' },
              { step: '02', title: 'Pass the evaluation', desc: 'Hit each phase’s profit target within the time limit, staying within the drawdown rules' },
              { step: '03', title: 'Get funded', desc: 'Receive a live-simulated funded account with profit withdrawals enabled' },
            ].map(s => (
              <div key={s.step} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: '14px', padding: '18px 20px' }}>
                <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--accent)', fontWeight: 700, marginBottom: '8px', letterSpacing: '0.1em' }}>STEP {s.step}</div>
                <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>{s.title}</div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{s.desc}</div>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
