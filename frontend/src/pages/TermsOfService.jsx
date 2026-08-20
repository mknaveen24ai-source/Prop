import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function TermsOfService() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState(null)

  const sections = [
    {
      id: 'nature',
      title: '1. Nature of the Platform',
      content: `This platform is a trader evaluation program operated as a performance assessment service. It is not a brokerage, investment firm, financial advisor, or regulated financial service provider.

All trading accounts provided are simulated evaluation accounts. No real market orders are placed on your behalf. Profits and losses within the evaluation environment are simulated and do not represent actual gains or losses in live financial markets.

By registering, you acknowledge that you are participating in a skill-based evaluation program, not engaging in live financial trading or investment activity.`
    },
    {
      id: 'eligibility',
      title: '2. Eligibility',
      content: `You must be at least 18 years of age to register and use this platform. By registering, you confirm that you are of legal age in your jurisdiction.

This service is not available to residents of the United States, Canada, Iran, North Korea, Cuba, Syria, Russia, Belarus, or any jurisdiction where participation would violate applicable law. You are solely responsible for ensuring that your use of this platform complies with the laws of your country of residence.

We reserve the right to suspend or terminate accounts from any jurisdiction at our sole discretion.`
    },
    {
      id: 'evaluation',
      title: '3. Evaluation Program Rules',
      content: `The evaluation program is offered as 1-Step, 2-Step, and 3-Step models, followed by a funded stage. Every phase of a given model shares the same core rules: hit that phase's profit target within its time limit, without breaching the daily or maximum drawdown limit.

Current headline terms (also shown on your dashboard before you start, and subject to change per model):

— 1-Step: 16% profit target, single phase, 45-day time limit.
— 2-Step: 10% target in Phase 1, then 8% in Phase 2, 45 days per phase.
— 3-Step: 8% target in Phase 1, 6% in Phase 2, then 6% in Phase 3, 45 days per phase.
— Maximum drawdown: 4% trailing from peak equity, on every model and every phase.
— Daily drawdown: 2% of starting-of-day equity, on every model and every phase.
— Minimum trading days: at least 5 qualifying days per phase (a day qualifies once that day's profit reaches 0.75% of starting balance), even if the profit target is reached sooner.
— Consistency rule: no single day's profit may exceed 15% of your total profit when you hit the target. Exceeding this is a hold, not a failure — trading continues until the ratio corrects itself.
— Funded Account: no profit target. The same drawdown discipline continues to apply, with the drawdown floor locking in your favor once equity reaches 2% above starting balance.

Failure to meet phase requirements, breaching drawdown limits, or expiry of the time limit will result in account termination. No refunds or appeals are available for failed accounts.`
    },
    {
      id: 'payouts',
      title: '4. Funded Account Payouts',
      content: `Traders who reach the funded stage and generate profits are eligible to request payouts subject to the following conditions:

— Minimum payout request is $50 USD equivalent.
— Payouts are calculated at 75% of realized profits above the starting balance.
— Before your first payout, the account must have at least 10 qualifying trading days and 6% net profit; there is no further lock-up period after that.
— Payouts are available on a weekly basis, and only one pending payout request is permitted at a time.
— Payouts are discretionary performance bonuses paid from company capital and do not represent withdrawal of deposited funds.
— Payouts are processed in USDT (TRC20 network). You are responsible for providing a valid wallet address and for any network fees.
— We reserve the right to delay, withhold, or deny payouts if we have reasonable grounds to suspect manipulation, abuse, or violation of these Terms.
— KYC verification must be completed and approved before any payout is processed.
— Payout processing time is up to 7 business days after admin approval.`
    },
    {
      id: 'kyc',
      title: '5. KYC & Identity Verification',
      content: `All users must complete identity verification (KYC) before accessing funded accounts or requesting payouts. You agree to provide accurate, current, and complete identification documents as requested.

We collect and process KYC data solely for identity verification and fraud prevention purposes. KYC documents are stored securely and are not shared with third parties except where required by law.

Providing false, misleading, or fraudulent identification documents will result in immediate account termination and may be reported to relevant authorities.`
    },
    {
      id: 'prohibited',
      title: '6. Prohibited Conduct',
      content: `The following activities are strictly prohibited and will result in immediate account termination without payout:

— Trading with the intent to exploit platform pricing or technical errors
— Use of automated trading bots, scripts, or algorithmic strategies unless explicitly permitted
— Copy trading between multiple accounts owned by the same user or coordinated group
— Hedging across multiple accounts on the same platform
— Any strategy that generates profit without genuine market risk (e.g., latency arbitrage)
— Creating multiple accounts to circumvent account limits or rules
— Sharing account credentials with third parties
— Any form of market manipulation or fraudulent activity`
    },
    {
      id: 'liability',
      title: '7. Limitation of Liability',
      content: `This platform is provided on an "as is" and "as available" basis. We make no warranties, express or implied, regarding the accuracy of price feeds, continuity of service, or fitness for any particular purpose.

To the maximum extent permitted by applicable law, we shall not be liable for any direct, indirect, incidental, special, or consequential damages arising from your use of or inability to use this platform, including but not limited to lost profits, data loss, or business interruption.

Our total liability to you for any claim arising from your use of this platform shall not exceed the value of any payout you have received in the 30 days preceding the claim.`
    },
    {
      id: 'termination',
      title: '8. Termination',
      content: `We reserve the right to suspend or terminate your account at any time, with or without notice, for any reason including but not limited to violation of these Terms, suspected fraud, or at our sole discretion.

Upon termination, any pending payout requests may be cancelled. You may not create a new account after termination without our express written consent.

You may close your account at any time by contacting support. Closure does not entitle you to any payout that has not already been approved.`
    },
    {
      id: 'changes',
      title: '9. Changes to Terms',
      content: `We reserve the right to modify these Terms at any time. Changes will be effective upon posting to this page. Your continued use of the platform after changes constitutes acceptance of the revised Terms.

It is your responsibility to review these Terms periodically. We will make reasonable efforts to notify users of material changes via email or platform notification.`
    },
    {
      id: 'governing',
      title: '10. Governing Law & Disputes',
      content: `These Terms are governed by and construed in accordance with the laws of the jurisdiction in which the company is incorporated, without regard to conflict of law principles.

Any dispute arising from these Terms or your use of the platform shall first be attempted to be resolved through good-faith negotiation. If unresolved, disputes shall be submitted to binding arbitration. You waive any right to participate in class action lawsuits.

If any provision of these Terms is found to be unenforceable, the remaining provisions shall continue in full force and effect.`
    }
  ]

  return (
    <div style={{
      background: 'var(--navy)',
      minHeight: '100dvh',
      color: 'var(--text)',
      fontFamily: 'var(--font-ui)'
    }}>

      {/* Nav */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-5) var(--space-9)', borderBottom: '1px solid var(--nav-border)',
        position: 'sticky', top: 0, background: 'var(--nav-bg)',
        backdropFilter: 'blur(12px)', zIndex: 100
      }}>
        <span
          onClick={() => navigate('/')}
          style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-3xl)', fontWeight: '700', color: 'var(--accent)', letterSpacing: '0.12em', cursor: 'pointer' }}
        >
          PROP FIRM
        </span>
        <button onClick={() => navigate(-1)} className="btn" style={{
          background: 'transparent', border: '1px solid var(--navy-border)',
          color: 'var(--text-muted)', padding: 'var(--space-2) var(--space-5)', fontSize: 'var(--fs-base)'
        }}>
          ← Back
        </button>
      </div>

      {/* Hero */}
      <div style={{
        textAlign: 'center', padding: 'var(--space-10) var(--space-6) var(--space-9)',
        borderBottom: '1px solid var(--navy-border)',
        background: 'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--muted) 6%, transparent) 0%, transparent 60%)'
      }}>
        <div style={{
          display: 'inline-block', background: 'color-mix(in srgb, var(--muted) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)', borderRadius: 'var(--radius-pill)',
          padding: '5px 14px', fontSize: 'var(--fs-xs)', color: 'var(--accent)',
          letterSpacing: '0.1em', marginBottom: 'var(--space-5)'
        }}>
          LEGAL DOCUMENT
        </div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--fs-6xl)', fontWeight: '700',
          marginBottom: 'var(--space-3)', color: 'var(--text)'
        }}>
          Terms of Service
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
          Last updated: {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      <div style={{ maxWidth: '860px', margin: '0 auto', padding: 'var(--space-9) var(--space-6)' }}>

        {/* Intro box */}
        <div style={{
          background: 'color-mix(in srgb, var(--muted) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--muted) 20%, transparent)',
            padding: '24px 28px', marginBottom: 'var(--space-8)'
        }}>
          <p style={{ color: 'var(--text)', lineHeight: '1.8', fontSize: 'var(--fs-md)', margin: 0 }}>
            Please read these Terms of Service carefully before using our platform. By registering an account or using any part of this service, you agree to be bound by these Terms. If you do not agree, do not use this platform.
          </p>
        </div>

        {/* Sections */}
        {sections.map((section) => (
          <div
            key={section.id}
            style={{
              background: 'var(--navy-card)',
              border: `1px solid ${activeSection === section.id ? 'var(--accent-dim)' : 'var(--navy-border)'}`,
                marginBottom: 'var(--space-3)',
              overflow: 'hidden', transition: 'border-color 0.2s ease'
            }}
          >
            <button
              onClick={() => setActiveSection(activeSection === section.id ? null : section.id)}
              style={{
                width: '100%', display: 'flex', justifyContent: 'space-between',
                alignItems: 'center', padding: 'var(--space-5) var(--space-6)', background: 'transparent',
                border: 'none', cursor: 'pointer', color: 'var(--text)', textAlign: 'left'
              }}
            >
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-md)', fontWeight: '600', letterSpacing: '0.05em' }}>
                {section.title}
              </span>
              <span style={{
                color: 'var(--accent)', fontSize: 'var(--fs-xl)', transition: 'transform 0.2s ease',
                transform: activeSection === section.id ? 'rotate(45deg)' : 'rotate(0deg)',
                display: 'inline-block'
              }}>+</span>
            </button>

            {activeSection === section.id && (
              <div style={{ padding: '0 var(--space-6) var(--space-6)', borderTop: '1px solid var(--navy-border)' }}>
                <p style={{
                  color: 'var(--text-muted)', lineHeight: '1.9', fontSize: 'var(--fs-md)',
                  marginTop: 'var(--space-5)', whiteSpace: 'pre-line', margin: 'var(--space-5) 0 0'
                }}>
                  {section.content}
                </p>
              </div>
            )}
          </div>
        ))}

        {/* Footer note */}
        <div style={{
          marginTop: 'var(--space-8)', padding: 'var(--space-6)', background: 'var(--navy-mid)',
          border: '1px solid var(--navy-border)',   textAlign: 'center'
        }}>
          <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', margin: 0, lineHeight: '1.7' }}>
            By using this platform you confirm you have read, understood, and agreed to these Terms of Service.<br />
            For questions, contact us at <span style={{ color: 'var(--accent)' }}>support@propfirm.com</span>
          </p>
        </div>
      </div>
    </div>
  )
}
