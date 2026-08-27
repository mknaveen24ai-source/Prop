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
    heroBadge: 'live funding · 100% profit split · published rules',
    heroTitleLead: 'Stop Risking',
    heroTitleHighlight: 'Your Own Capital.',
    heroSubtitle: 'Pass one evaluation — 1, 2, or 3 steps, your choice — and trade our capital, scaling to $30,000,000. Keep 100% of every payout. We make our money on the entry fee, not your profits.',
    heroPrimaryCta: 'Get Funded — From $4',
    heroStatsLead: '3',
    heroStatsLeadSuffix: 'Challenge Models',
    featuresHeadline: 'Institutional Grade. Challenge Ready.',
    featuresSubtitle: 'Every rule published before you pay, every payout kept in full, and funded scaling once you pass.',
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
        a: 'Most sizes are open continuously. Where a size has a capacity limit, the counter on the pricing table shows the remaining places live.'
      }
    ],
    footerHeadline: 'The Capital Is Ready. Are You?',
    footerSubtitle: 'Every account size updates in real time. Pick the model that fits how you actually trade.',
    footerButton: 'Get Started',
    footerBrand: 'Prop trading challenges with published rules, a 100% trader profit split, and funded progression once you pass.'
  }
}
