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
    heroBadge: 'live funding · real payouts · no hidden rules',
    heroTitleLead: 'Stop Risking',
    heroTitleHighlight: 'Your Own Capital.',
    heroSubtitle: 'Pass one evaluation — 1, 2, or 3 steps, your choice — and trade up to $400,000 of our capital. Keep 75% of every payout, paid weekly.',
    heroPrimaryCta: 'Start From $4',
    heroStatsLead: '3',
    heroStatsLeadSuffix: 'Challenge Models',
    featuresHeadline: 'Institutional Grade. Challenge Ready.',
    featuresSubtitle: 'Run a transparent prop challenge with live quota controls, clear progression, and funded scaling once you pass.',
    faqLead: 'Every real objection, answered up front — not buried in a support queue.',
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
    footerHeadline: 'The Capital Is Ready. Are You?',
    footerSubtitle: 'Every account size updates in real time. Pick the model that fits your trading style before this month\'s batch fills.',
    footerButton: 'Get Started',
    footerBrand: 'Prop trading challenges with transparent rules, per-size monthly quota enforcement, and funded progression once you pass.'
  }
}
