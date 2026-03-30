import React, { useState } from 'react'

// ── Onboarding steps ──────────────────────────────────────────────────────────
const STEPS = [
  {
    icon: '👋',
    title: 'Welcome to Prop Firm!',
    body: `This is a free trader evaluation platform. Prove your trading skill across two phases and earn a funded account — with real capital on the line.`,
    highlight: null
  },
  {
    icon: '🪪',
    title: 'Step 1 — Complete KYC',
    body: `Before you can trade, verify your identity. Go to the KYC tab in the sidebar and upload your government-issued ID and a selfie. Admin reviews within 24 hours.`,
    highlight: 'kyc'
  },
  {
    icon: '📈',
    title: 'Step 2 — Start a Challenge',
    body: `Choose an account size from the Dashboard. Your Phase 1 challenge begins immediately — free, no entry fee. Hit the 10% profit target within 30 days without breaching the 10% drawdown limit.`,
    highlight: 'dashboard'
  },
  {
    icon: '⚖️',
    title: 'Trading Rules',
    body: (
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginTop: '8px' }}>
          {[
            ['Profit Target',    '10% per phase'],
            ['Max Drawdown',     '10% limit'],
            ['Time Limit',       '30 days / phase'],
            ['Min Trade Time',   '60 seconds'],
            ['Forex Leverage',   '1:30'],
            ['Gold/Silver Lev.', '1:10'],
            ['Min Lot Size',     '0.01'],
            ['Instruments',      'EURUSD, GBPUSD, XAUUSD, XAGUSD'],
          ].map(([label, val]) => (
            <div key={label} style={{
              background: 'rgba(148, 148, 148, 0.06)',
              border: '1px solid rgba(148, 148, 148, 0.15)',
              borderRadius: '6px', padding: '8px 10px'
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '2px' }}>{label}</div>
              <div style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: '600', fontFamily: 'DM Mono, monospace' }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    highlight: null
  },
  {
    icon: '🏆',
    title: 'Step 3 — Pass Both Phases',
    body: `Pass Phase 1 → Phase 2 activates automatically. Same rules apply. Pass Phase 2 → you become a Funded Trader with a real broker account. No profit target in funded — just the 5% drawdown limit.`,
    highlight: null
  },
  {
    icon: '💰',
    title: 'Step 4 — Request Payouts',
    body: `Once funded, request a payout any time. Minimum $50. You keep 80% of profits. Processed within 7 business days via USDT or your chosen method. No lock-up periods.`,
    highlight: 'payouts'
  },
  {
    icon: '🚀',
    title: "You're Ready!",
    body: `Start by completing KYC and creating your first challenge. Good luck, and trade well.`,
    highlight: null
  }
]

// ── Storage key ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'onboarding_completed'

export function shouldShowOnboarding() {
  try {
    return !localStorage.getItem(STORAGE_KEY)
  } catch {
    return false
  }
}

export function markOnboardingComplete() {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Onboarding({ onComplete, onNavigate }) {
  const [step, setStep] = useState(0)
  const current = STEPS[step]
  const isLast  = step === STEPS.length - 1
  const isFirst = step === 0

  function next() {
    if (isLast) {
      markOnboardingComplete()
      onComplete()
    } else {
      setStep(s => s + 1)
    }
  }

  function skip() {
    markOnboardingComplete()
    onComplete()
  }

  function goToStep(i) {
    setStep(i)
  }

  // Navigate to a dashboard page when highlight button is clicked
  function handleHighlight() {
    if (current.highlight && onNavigate) {
      onNavigate(current.highlight)
      markOnboardingComplete()
      onComplete()
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999, padding: '20px',
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--navy-card)',
        border: '1px solid var(--navy-border)',
        borderRadius: '16px',
        padding: '36px 32px',
        width: '100%',
        maxWidth: '480px',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        position: 'relative'
      }}>

        {/* Skip button */}
        <button
          onClick={skip}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            background: 'transparent', border: 'none',
            color: 'var(--text-dim)', fontSize: '12px',
            cursor: 'pointer', padding: '4px 8px',
            borderRadius: '4px'
          }}
        >
          Skip tour
        </button>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '28px' }}>
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => goToStep(i)}
              style={{
                width: i === step ? '20px' : '8px',
                height: '8px',
                borderRadius: '4px',
                background: i === step ? 'var(--accent)' : i < step ? 'var(--accent-dim)' : 'var(--navy-border)',
                border: 'none', cursor: 'pointer',
                transition: 'all 0.25s ease',
                padding: 0
              }}
            />
          ))}
        </div>

        {/* Icon */}
        <div style={{ fontSize: '48px', marginBottom: '16px', lineHeight: 1 }}>
          {current.icon}
        </div>

        {/* Title */}
        <h2 style={{
          fontFamily: 'Inter, serif',
          color: 'var(--accent)',
          fontSize: '20px',
          marginBottom: '14px',
          fontWeight: '700'
        }}>
          {current.title}
        </h2>

        {/* Body */}
        <div style={{
          color: 'var(--text-muted)',
          fontSize: '14px',
          lineHeight: '1.7',
          marginBottom: '28px',
          minHeight: '80px'
        }}>
          {typeof current.body === 'string' ? current.body : current.body}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {!isFirst && (
            <button
              onClick={() => setStep(s => s - 1)}
              style={{
                background: 'transparent',
                border: '1px solid var(--navy-border)',
                color: 'var(--text-muted)',
                borderRadius: '8px',
                padding: '10px 20px',
                fontSize: '13px',
                cursor: 'pointer'
              }}
            >
              ← Back
            </button>
          )}

          {current.highlight && (
            <button
              onClick={handleHighlight}
              style={{
                background: 'transparent',
                border: '1px solid var(--accent)',
                color: 'var(--accent)',
                borderRadius: '8px',
                padding: '10px 18px',
                fontSize: '13px',
                cursor: 'pointer',
                fontWeight: '600'
              }}
            >
              Go there →
            </button>
          )}

          <button
            onClick={next}
            style={{
              marginLeft: 'auto',
              background: 'var(--accent)',
              color: 'var(--navy)',
              border: 'none',
              borderRadius: '8px',
              padding: '11px 28px',
              fontSize: '14px',
              fontWeight: '700',
              cursor: 'pointer',
              fontFamily: 'DM Sans, sans-serif'
            }}
          >
            {isLast ? "Let's Go! 🚀" : 'Next →'}
          </button>
        </div>

        {/* Step counter */}
        <div style={{
          textAlign: 'center',
          marginTop: '16px',
          fontSize: '11px',
          color: 'var(--text-dim)'
        }}>
          {step + 1} of {STEPS.length}
        </div>
      </div>
    </div>
  )
}