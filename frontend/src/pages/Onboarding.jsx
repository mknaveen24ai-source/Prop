import React, { useState } from 'react'
import { getMemoryItem, setMemoryItem } from '../utils/memoryStore'
import { TRADABLE_INSTRUMENTS_SUMMARY } from '../utils/instruments'
import { useBranding } from '../BrandingContext'

// ── Onboarding steps ──────────────────────────────────────────────────────────
const STEPS = [
  {
    icon: '👋',
    title: 'Welcome to Prop Firm!',
    body: `This platform runs paid trader evaluations. Choose a 1-step, 2-step, or 3-step challenge, prove your trading skill, and earn a funded account — with real capital on the line.`,
    highlight: null
  },
  {
    icon: '📈',
    title: 'Step 1 — Choose a Challenge',
    body: `Pick a 1-step, 2-step, or 3-step model and an account size from the New Challenge tab, then complete checkout. Your challenge begins as soon as payment clears — there is nothing to wait for. Hit each phase's profit target within its time limit without breaching the drawdown limit.`,
    highlight: 'dashboard'
  },
  {
    icon: '🪪',
    title: 'Step 2 — Verify Before You Get Funded',
    body: `You can trade an evaluation straight away. Identity verification is only required once you pass and your funded account is issued — and before any payout. Upload your government-issued ID and a selfie in the KYC tab whenever you like; doing it early means nothing to wait for at the finish line. Admin reviews within 24 hours.`,
    highlight: 'kyc'
  },
  {
    icon: '⚖️',
    title: 'Trading Rules',
    body: (
      <div>
        <div className="ui-cols ui-cols--keep-2" style={{ marginTop: 'var(--space-2)', '--cols-gap': '8px' }}>
          {[
            ['Profit Target',    'Set by your model'],
            ['Max Drawdown',     'Set by your model'],
            ['Time Limit',       'Set by your model'],
            ['Min Trading Days', '5 days'],
            ['Consistency Rule', '15% max/day'],
            ['Min Trade Time',   '60 seconds'],
            ['Leverage',         'Unlimited'],
            ['Position Cap',     'None'],
            ['Min Lot Size',     '0.01'],
            ['Instruments',      TRADABLE_INSTRUMENTS_SUMMARY],
          ].map(([label, val]) => (
            <div key={label} style={{
              background: 'color-mix(in srgb, var(--muted) 6%, transparent)',
              border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
              padding: 'var(--space-2) var(--space-2-5)'
            }}>
              <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginBottom: 'var(--space-1)' }}>{label}</div>
            <div style={{ fontSize: 'var(--fs-base)', color: 'var(--accent)', fontWeight: '600', fontFamily: 'var(--font-mono)' }}>{val}</div>
            </div>
          ))}
        </div>
      </div>
    ),
    highlight: null
  },
  {
    icon: '🏆',
    title: 'Step 3 — Pass Your Challenge',
    body: `Pass each phase of your chosen model and the next one activates automatically, with the same rules applying throughout. Complete the final phase and you become a Funded Trader with a real broker account. No profit target once funded — just the drawdown limit.`,
    highlight: null
  },
  {
    icon: '💰',
    title: 'Step 4 — Request Payouts',
    body: `Once funded, request a payout weekly. Minimum $50. You keep 100% of profits. Your first payout needs 10 qualifying trading days and 6% net profit — no lock-up after that. Processed within 7 business days via USDT or your chosen method.`,
    highlight: 'payouts'
  },
  {
    icon: '🚀',
    title: "You're Ready!",
    body: `Pick your challenge and start trading — verification can wait until you pass. Good luck, and trade well.`,
    highlight: null
  }
]

// ── Storage key ───────────────────────────────────────────────────────────────
const STORAGE_KEY = 'onboarding_completed'

export function shouldShowOnboarding() {
  try {
    return !getMemoryItem(STORAGE_KEY)
  } catch {
    return false
  }
}

export function markOnboardingComplete() {
  try {
    setMemoryItem(STORAGE_KEY, '1')
  } catch {}
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Onboarding({ onComplete, onNavigate }) {
  const { tenant } = useBranding()
  const [step, setStep] = useState(0)
  const tenantName = tenant?.name || 'Prop Firm'
  const effectiveSteps = STEPS.map((stepItem) => {
    if (stepItem.title === 'Welcome to Prop Firm!') {
      return {
        ...stepItem,
        title: `Welcome to ${tenantName}!`
      }
    }
    return stepItem
  })
  const current = effectiveSteps[step]
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
      zIndex: 9999, padding: 'var(--space-5)',
      backdropFilter: 'blur(4px)'
    }}>
      <div style={{
        background: 'var(--glass-2)',
        border: '1px solid var(--rule-soft)',
        borderTop: '3px double var(--ink)',
        padding: 'var(--space-8) var(--space-7)',
        width: '100%',
        maxWidth: '480px',
        backdropFilter: 'blur(20px) saturate(140%)',
        WebkitBackdropFilter: 'blur(20px) saturate(140%)',
        position: 'relative'
      }}>

        {/* Skip button */}
        <button
          onClick={skip}
          style={{
            position: 'absolute', top: '16px', right: '16px',
            background: 'transparent', border: 'none',
            color: 'var(--text-dim)', fontSize: 'var(--fs-sm)',
            cursor: 'pointer', padding: 'var(--space-1) var(--space-2)'
          }}
        >
          Skip tour
        </button>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 'var(--space-1-5)', marginBottom: 'var(--space-7)' }}>
          {effectiveSteps.map((_, i) => (
            <button
              key={i}
              onClick={() => goToStep(i)}
              style={{
                width: i === step ? '20px' : '8px',
                height: '8px',
                background: i === step ? 'var(--accent)' : i < step ? 'var(--accent-dim)' : 'var(--navy-border)',
                border: 'none', cursor: 'pointer',
                transition: 'all 0.25s ease',
                padding: 0
              }}
            />
          ))}
        </div>

        {/* Icon */}
        <div style={{ fontSize: 'var(--fs-7xl)', marginBottom: 'var(--space-4)', lineHeight: 1 }}>
          {current.icon}
        </div>

        {/* Title */}
        <h2 style={{
            fontFamily: 'var(--font-display)',
          color: 'var(--accent)',
          fontSize: 'var(--fs-2xl)',
          marginBottom: 'var(--space-3-5)',
          fontWeight: '700'
        }}>
          {current.title}
        </h2>

        {/* Body */}
        <div style={{
          color: 'var(--text-muted)',
          fontSize: 'var(--fs-md)',
          lineHeight: '1.7',
          marginBottom: 'var(--space-7)',
          minHeight: '80px'
        }}>
          {typeof current.body === 'string' ? current.body : current.body}
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 'var(--space-2-5)', alignItems: 'center' }}>
          {!isFirst && (
            <button
              onClick={() => setStep(s => s - 1)}
              style={{
                background: 'transparent',
                border: '1px solid var(--navy-border)',
                color: 'var(--text-muted)',
                padding: 'var(--space-2-5) var(--space-5)',
                fontSize: 'var(--fs-base)',
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
                padding: 'var(--space-2-5) var(--space-4-5)',
                fontSize: 'var(--fs-base)',
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
              padding: 'var(--space-3) var(--space-7)',
              fontSize: 'var(--fs-md)',
              fontWeight: '700',
              cursor: 'pointer',
                fontFamily: 'var(--font-ui)'
            }}
          >
            {isLast ? "Let's Go! 🚀" : 'Next →'}
          </button>
        </div>

        {/* Step counter */}
        <div style={{
          textAlign: 'center',
          marginTop: 'var(--space-4)',
          fontSize: 'var(--fs-xs)',
          color: 'var(--text-dim)'
        }}>
          {step + 1} of {STEPS.length}
        </div>
      </div>
    </div>
  )
}
