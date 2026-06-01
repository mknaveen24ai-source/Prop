function isTruthyFlag(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true'
}

export function isPaidTenant(tenant) {
  const requiresPayment = isTruthyFlag(tenant?.settings?.requires_payment)
  const checkoutMode = String(tenant?.settings?.challenge_checkout_mode || '').trim().toLowerCase()
  const marketingMode = String(tenant?.settings?.marketing_mode || '').trim().toLowerCase()
  return requiresPayment || checkoutMode === 'paid' || marketingMode === 'paid'
}

export function getChallengeFeeDisplay(tenant) {
  const label = String(tenant?.settings?.challenge_fee_label || '').trim()
  if (label) return label

  const amount = Number(tenant?.settings?.challenge_fee_amount || 0)
  const currency = String(tenant?.settings?.challenge_fee_currency || 'USD').trim().toUpperCase()
  if (amount > 0) return `${currency} ${amount.toFixed(2)}`
  return 'FREE'
}

export function getTenantLandingCopy(tenant) {
  if (isPaidTenant(tenant)) {
    const feeLabel = getChallengeFeeDisplay(tenant)
    return {
      heroBadge: 'prop trading challenges - firm-backed capital access',
      heroTitleLead: 'Get Funded with',
      heroTitleHighlight: 'Firm-Backed Capital.',
      heroSubtitle: `Choose your challenge, trade under transparent rules, and progress into funded deployment. Challenge access starts from ${feeLabel}.`,
      heroPrimaryCta: 'Start Challenge',
      heroStatsLead: feeLabel,
      heroStatsLeadSuffix: 'Challenge Access',
      calculatorLead: `Challenge access starts from ${feeLabel}. Each account size has its own monthly allocation that resets automatically.`,
      calculatorBadgeOpen: feeLabel,
      calculatorLocked: 'FULL',
      calculatorFeeLabel: feeLabel,
      calculatorFooter: 'Complete checkout to activate this challenge.',
      featuresHeadline: 'Institutional Grade. Challenge Ready.',
      featuresSubtitle: 'Run a transparent prop challenge with live quota controls, clear progression, and funded scaling once you pass.',
      faqLead: 'Everything you need to know about this prop trading challenge program.',
      faqItems: [
        {
          category: 'General',
          q: 'How do I start a challenge?',
          a: `Select an account tier, complete the ${feeLabel} checkout if required, and your challenge account is issued immediately once payment clears.`
        },
        {
          category: 'General',
          q: 'Are account tiers always available?',
          a: 'Each account size has its own monthly allocation. Once that size is filled, it reopens automatically at the start of the next month.'
        }
      ],
      footerHeadline: 'Start Your Challenge',
      footerSubtitle: `Per-size monthly availability updates in real time. Challenge access currently starts from ${feeLabel}.`,
      footerButton: 'Get Started',
      footerBrand: 'Prop trading challenges with transparent rules, per-size monthly quota enforcement, and funded progression once you pass.'
    }
  }

  return {
    heroBadge: 'free funded accounts - limited spots monthly',
    heroTitleLead: 'Get Funded for',
    heroTitleHighlight: 'Free.',
    heroSubtitle: 'No evaluation fees. No hidden costs. Pass our 2-phase institutional assessment and move into firm-backed deployment. Limited accounts released monthly.',
    heroPrimaryCta: 'Start Challenge',
    heroStatsLead: '100%',
    heroStatsLeadSuffix: 'Free',
    calculatorLead: 'All accounts are completely free. Each account size has limited monthly spots backed by real liquidity.',
    calculatorBadgeOpen: 'FREE',
    calculatorLocked: 'FULL',
    calculatorFeeLabel: '0.00 USD',
    calculatorFooter: 'Immediate institutional access',
    featuresHeadline: 'Institutional Grade. Completely Free.',
    featuresSubtitle: 'We bridge the gap between retail skill and firm capital without the barrier of entry fees.',
    faqLead: 'Everything you need to know about our free funded accounts.',
    faqItems: [
      {
        category: 'General',
        q: 'Is this really 100% free?',
        a: 'Yes. There are absolutely no fees, no hidden charges, and no credit card required. You register, claim an account, and start trading.'
      }
    ],
    footerHeadline: 'Claim Your Free Account',
    footerSubtitle: 'Limited per-size monthly spots backed by real liquidity. No fees, no credit card, no catch.',
    footerButton: "Get Started - It's Free",
    footerBrand: 'Free funded trading accounts backed by real liquidity. Pass our 2-phase evaluation and trade with firm capital - no fees required.'
  }
}
