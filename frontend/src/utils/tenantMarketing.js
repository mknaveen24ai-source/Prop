import branding from '../config/branding'

// Every business on this platform is paid-only now — 1-step, 2-step, and
// 3-step challenges, priced per account size. Kept as functions (rather than
// inlining `true` everywhere) so existing call sites don't need to change.
export function isPaidTenant() {
  return true
}

export function getChallengeFeeDisplay() {
  const label = String(branding?.settings?.challenge_fee_label || '').trim()
  if (label) return label
  return 'From $4'
}

export function getTenantLandingCopy() {
  return {
    heroBadge: 'prop trading challenges - firm-backed capital access',
    heroTitleLead: 'Get Funded with',
    heroTitleHighlight: 'Firm-Backed Capital.',
    heroSubtitle: 'Choose a 1-step, 2-step, or 3-step challenge, trade under transparent rules, and progress into funded deployment.',
    heroPrimaryCta: 'Start Challenge',
    heroStatsLead: '3',
    heroStatsLeadSuffix: 'Challenge Models',
    calculatorLead: 'Choose a 1, 2, or 3-step evaluation. Pricing scales with account size — fewer phases costs more, more phases costs less.',
    calculatorBadgeOpen: 'OPEN',
    calculatorLocked: 'FULL',
    calculatorFeeLabel: 'From $4',
    calculatorFooter: 'Complete checkout to activate this challenge.',
    featuresHeadline: 'Institutional Grade. Challenge Ready.',
    featuresSubtitle: 'Run a transparent prop challenge with live quota controls, clear progression, and funded scaling once you pass.',
    faqLead: 'Everything you need to know about this prop trading challenge program.',
    faqItems: [
      {
        category: 'General',
        q: 'How do I start a challenge?',
        a: 'Choose a 1-step, 2-step, or 3-step model, select an account size, complete checkout, and your challenge account is issued as soon as payment clears.'
      },
      {
        category: 'General',
        q: 'Are account tiers always available?',
        a: 'Each account size has its own monthly allocation. Once that size is filled, it reopens automatically at the start of the next month.'
      }
    ],
    footerHeadline: 'Start Your Challenge',
    footerSubtitle: 'Per-size monthly availability updates in real time. Pick the model that fits your trading style.',
    footerButton: 'Get Started',
    footerBrand: 'Prop trading challenges with transparent rules, per-size monthly quota enforcement, and funded progression once you pass.'
  }
}
