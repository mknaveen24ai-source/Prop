import React from 'react'
import LegalPage from '../components/legal/LegalPage'

/**
 * Refund / cancellation policy.
 *
 * This page did not exist, which is a consumer-protection gap for a product
 * sold to EU/UK customers: the Consumer Rights Directive requires the trader to
 * disclose withdrawal rights (or their lawful exclusion) *before* purchase, in
 * a durable form. The digital-content exemption only applies if the buyer
 * expressly consents to immediate performance and acknowledges losing the
 * right — which is exactly what §3 sets out.
 *
 * The specifics below are a defensible default, not legal advice. Have counsel
 * review before launch, particularly the §2 window and the §5 chargeback terms.
 */
export default function RefundPolicy() {
  const sections = [
    {
      id: 'what-you-buy',
      title: '1. What You Are Purchasing',
      content: `When you purchase an evaluation, you are buying access to a simulated trading evaluation on a demo environment. You are not:

— depositing funds into a live brokerage account
— purchasing securities, derivatives, or any financial instrument
— entering into an investment or asset-management agreement

The fee covers access to the evaluation platform, live market data, and the assessment process. It is a service fee, not a deposit, and it is not held on your behalf or returnable as a balance.`
    },
    {
      id: 'window',
      title: '2. 14-Day Refund Window',
      content: `You may request a full refund of your evaluation fee within 14 calendar days of purchase, provided you have not started the evaluation.

An evaluation is considered started once any of the following has occurred on the account:
— a trade has been opened, or
— a pending order has been placed, or
— the platform has recorded any trading activity

If none of these has occurred, we refund in full to the original payment method, with no questions asked. Refunds are processed within 5–10 business days; the time for funds to appear depends on your payment provider.`
    },
    {
      id: 'after-start',
      title: '3. After the Evaluation Has Started',
      content: `Once you place your first trade, the service has been delivered and the fee becomes non-refundable.

For customers in the EEA and UK: by placing your first trade you expressly request immediate performance of the service and acknowledge that you thereby lose your statutory 14-day right of withdrawal under the Consumer Rights Directive, to the extent the service has been performed. Until you place that first trade, your withdrawal right is unaffected and §2 applies.

Failing an evaluation is not grounds for a refund. Breaching a drawdown limit, a daily-loss limit, or any other documented rule is a normal outcome of the evaluation, not a service defect.`
    },
    {
      id: 'we-refund',
      title: '4. When We Refund Regardless',
      content: `We will refund you in full, whether or not you have started trading, if:

— a platform fault on our side prevented you from trading for a material portion of the evaluation period, and we could not remedy it
— you were charged more than once for the same evaluation
— your account failed as a direct result of a demonstrable pricing or execution error on our side
— we cancel or discontinue the evaluation programme before you complete it
— we are unable to verify your identity and must close your account for reasons that are not attributable to you

Where an account failed because of our error, we will normally offer a free replacement evaluation instead of, or in addition to, a refund. The choice is yours.`
    },
    {
      id: 'no-refund',
      title: '5. When We Do Not Refund',
      content: `We do not refund where:

— you failed the evaluation under the published rules
— you breached the Terms of Service, including prohibited trading practices such as latency arbitrage, tick scalping, reverse arbitrage, or coordinated group trading
— you provided false information during registration or identity verification
— the refund is requested more than 14 days after purchase
— you have already received a payout on the account
— the evaluation was obtained free of charge, through a promotion, a competition prize, or a gift voucher

Discounted purchases are refundable at the amount actually paid, not the list price.`
    },
    {
      id: 'chargebacks',
      title: '6. Chargebacks',
      content: `Please contact us before initiating a chargeback. Most disputes are resolved faster directly, and we would rather fix the problem than argue about it with a payment processor.

Initiating a chargeback while an evaluation or payout is in progress will suspend the associated account until the dispute is resolved. Where a chargeback is raised on a fee that this policy does not make refundable, we reserve the right to close the associated accounts and forfeit any pending payout.`
    },
    {
      id: 'how',
      title: '7. How to Request a Refund',
      content: `Open a support ticket from your dashboard, or email the address at the foot of this page, including:

— the email address on your account
— the order or transaction reference
— the reason for the request

We acknowledge every request within 2 business days and aim to reach a decision within 5. If we decline, we will tell you which clause of this policy applies and how to escalate.

Nothing in this policy limits any statutory rights you have under the consumer law of your country of residence.`
    }
  ]

  return (
    <LegalPage
      title="Refund & Cancellation Policy"
      intro={`This policy explains when your evaluation fee is refundable, when it is not, and how to ask.

Short version: full refund within 14 days if you have not placed a trade; once you start trading the service has been delivered; and we refund regardless if the fault was ours.`}
      sections={sections}
      contactEmail="billing@propfirm.com"
      contactLabel="For refund requests or billing questions, contact"
    />
  )
}
