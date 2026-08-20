import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export default function PrivacyPolicy() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState(null)

  const sections = [
    {
      id: 'collect',
      title: '1. Information We Collect',
      content: `We collect the following categories of personal information when you register and use our platform:

Registration Data: Full name, email address, phone number, country of residence, and password (stored as a secure hash).

Identity Verification (KYC): Government-issued ID documents, proof of address, and any other documentation required for identity verification.

Trading Activity: All trades placed, account performance metrics, profit/loss records, and trading history within the simulated evaluation environment.

Technical Data: IP address, device fingerprint, browser type, operating system, and session data collected automatically when you access the platform.

Payment Data: Cryptocurrency wallet addresses provided for payout purposes. We do not collect or store card numbers or bank account details.`
    },
    {
      id: 'use',
      title: '2. How We Use Your Information',
      content: `We use your personal information for the following purposes:

— To create and manage your account
— To operate and administer the trader evaluation program
— To verify your identity (KYC) and prevent fraud
— To process payout requests to verified traders
— To communicate with you about your account, including evaluation results and payout status
— To detect and prevent prohibited trading activity, cheating, or abuse
— To comply with applicable legal obligations
— To improve and maintain our platform

We do not use your data for advertising, sell it to third parties, or use it for any purpose beyond what is described here.`
    },
    {
      id: 'legal',
      title: '3. Legal Basis for Processing (GDPR)',
      content: `For users in the European Economic Area (EEA) and UK, we process your personal data under the following legal bases:

Contract Performance: Processing necessary to provide you with our evaluation services and manage your account.

Legitimate Interests: Fraud prevention, security monitoring, and platform abuse detection.

Legal Obligation: Identity verification and record-keeping required by applicable anti-money laundering and financial regulations.

Consent: Where we send you marketing or non-essential communications, we rely on your consent, which you may withdraw at any time.`
    },
    {
      id: 'sharing',
      title: '4. Sharing Your Information',
      content: `We do not sell, rent, or trade your personal information to third parties.

We may share your information only in the following limited circumstances:

Service Providers: We use trusted third-party providers for email delivery (SendGrid), identity verification, and infrastructure hosting. These providers process data only as instructed by us and under strict confidentiality obligations.

Legal Requirements: We may disclose your information if required to do so by law, court order, or governmental authority, or if we believe disclosure is necessary to protect our legal rights or prevent harm.

Business Transfers: In the event of a merger, acquisition, or sale of all or substantially all of our assets, your data may be transferred as part of that transaction. We will notify you of any such change.`
    },
    {
      id: 'retention',
      title: '5. Data Retention',
      content: `We retain your personal data for as long as your account is active and for a period of 5 years after account closure, to comply with legal, regulatory, and financial record-keeping obligations.

KYC documents are retained for a minimum of 5 years from the date of your last transaction or account closure, whichever is later.

Trading records and payout history are retained for 7 years for accounting and legal compliance purposes.

You may request deletion of your account and personal data at any time (see Section 7), subject to our retention obligations.`
    },
    {
      id: 'security',
      title: '6. Security',
      content: `We implement appropriate technical and organizational measures to protect your personal information against unauthorized access, loss, destruction, or alteration. These include:

— Passwords stored using bcrypt hashing (never in plain text)
— JWT-based authentication with short expiry windows
— HTTPS encryption for all data in transit
— Rate limiting on authentication endpoints
— Database access restricted to application layer only

No method of transmission over the internet or electronic storage is 100% secure. While we strive to use commercially acceptable means to protect your data, we cannot guarantee absolute security.`
    },
    {
      id: 'rights',
      title: '7. Your Rights',
      content: `Depending on your jurisdiction, you may have the following rights regarding your personal data:

Right of Access: Request a copy of the personal data we hold about you.

Right to Rectification: Request correction of inaccurate or incomplete data.

Right to Erasure: Request deletion of your personal data, subject to our legal retention obligations.

Right to Restriction: Request that we limit how we process your data in certain circumstances.

Right to Portability: Request your data in a structured, machine-readable format.

Right to Object: Object to processing based on legitimate interests.

To exercise any of these rights, contact us at support@propfirm.com. We will respond within 30 days. We may require identity verification before processing your request.`
    },
    {
      id: 'cookies',
      title: '8. Cookies',
      content: `We use secure, HTTP-only cookies to maintain your authentication session. These cookies are required for core functionality and cannot be disabled while using the service.\r\n\r\nWe do not use advertising cookies, tracking pixels, or third-party analytics tools that share your data with external parties.\r\n\r\nClearing your browser cookies will log you out of the platform.`
    },
    {
      id: 'international',
      title: '9. International Transfers',
      content: `Our servers are located in the European Union / United States (depending on your deployment region). If you access our platform from outside this region, your data may be transferred to and processed in a country with different data protection laws than your own.

By using our platform, you consent to this transfer. We ensure appropriate safeguards are in place for any international transfers, including Standard Contractual Clauses where required by GDPR.`
    },
    {
      id: 'changes',
      title: '10. Changes to This Policy',
      content: `We may update this Privacy Policy from time to time. When we make material changes, we will notify you by email or by prominently posting a notice on our platform. The updated policy will be effective upon posting.

We encourage you to review this policy periodically. Your continued use of the platform after changes constitutes your acceptance of the revised policy.`
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
        background: 'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--muted) 5%, transparent) 0%, transparent 60%)'
      }}>
        <div style={{
          display: 'inline-block', background: 'color-mix(in srgb, var(--muted) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)', borderRadius: 'var(--radius-pill)',
          padding: '5px 14px', fontSize: 'var(--fs-xs)', color: 'var(--cyan)',
          letterSpacing: '0.1em', marginBottom: 'var(--space-5)'
        }}>
          LEGAL DOCUMENT
        </div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--fs-6xl)', fontWeight: '700',
          marginBottom: 'var(--space-3)', color: 'var(--text)'
        }}>
          Privacy Policy
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-md)' }}>
          Last updated: {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      <div style={{ maxWidth: '860px', margin: '0 auto', padding: 'var(--space-9) var(--space-6)' }}>

        {/* Intro box */}
        <div style={{
          background: 'color-mix(in srgb, var(--muted) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
            padding: '24px 28px', marginBottom: 'var(--space-8)'
        }}>
          <p style={{ color: 'var(--text)', lineHeight: '1.8', fontSize: 'var(--fs-md)', margin: 0 }}>
            This Privacy Policy explains how we collect, use, and protect your personal information when you use our platform. We are committed to handling your data responsibly and transparently, in compliance with GDPR and applicable data protection laws.
          </p>
        </div>

        {/* Sections */}
        {sections.map((section) => (
          <div
            key={section.id}
            style={{
              background: 'var(--navy-card)',
              border: `1px solid ${activeSection === section.id ? 'color-mix(in srgb, var(--muted) 30%, transparent)' : 'var(--navy-border)'}`,
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
                color: 'var(--cyan)', fontSize: 'var(--fs-xl)', transition: 'transform 0.2s ease',
                transform: activeSection === section.id ? 'rotate(45deg)' : 'rotate(0deg)',
                display: 'inline-block'
              }}>+</span>
            </button>

            {activeSection === section.id && (
              <div style={{ padding: '0 24px 24px', borderTop: '1px solid var(--navy-border)' }}>
                <p style={{
                  color: 'var(--text-muted)', lineHeight: '1.9', fontSize: 'var(--fs-md)',
                  whiteSpace: 'pre-line', margin: '20px 0 0'
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
            For privacy-related requests or concerns, contact our data protection team at<br />
            <span style={{ color: 'var(--cyan)' }}>privacy@propfirm.com</span>
          </p>
        </div>
      </div>
    </div>
  )
}
