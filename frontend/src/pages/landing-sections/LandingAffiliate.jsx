import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../services/api'

export default function LandingAffiliate() {
  const [discountPct, setDiscountPct] = useState(10)

  useEffect(() => {
    api.get('/api/affiliates/settings-public')
      .then(res => {
        if (res.data?.program_enabled && res.data?.referred_discount_pct != null) {
          setDiscountPct(res.data.referred_discount_pct)
        }
      })
      .catch(() => {})
  }, [])

  const steps = [
    {
      num: '01', title: 'Get Your Link', diff: 'Share',
      text: 'Every trader gets a personal referral code and link the moment they sign up — find it on your Affiliate dashboard.',
    },
    {
      num: '02', title: 'They Save, You Earn', diff: 'Refer',
      text: `Anyone who signs up through your link gets ${discountPct}% off their first challenge. You start earning commission the moment they pay.`,
    },
    {
      num: '03', title: 'Commission For Life', diff: 'Earn',
      text: 'Every future challenge your referral ever buys — not just their first — pays you a commission, at a rate that climbs as you refer more traders.',
    }
  ]

  return (
    <section className="mp-section" style={{ position: 'relative' }}>
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-10)' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="mp-badge-dot"></span>
            Affiliate Program
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">
            Refer a Trader, <span className="mp-glow-text">Earn For Life</span>
          </h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            Give friends a discount on their first challenge. Earn a recurring commission on every challenge they ever buy after that — no cap, no expiry.
          </p>
        </div>

        <div className="mp-timeline mp-reveal mp-delay-300">
          {steps.map((step, idx) => (
            <div key={idx} className="mp-timeline-item">
              <div className="mp-timeline-marker" style={{ borderColor: 'var(--gain)', color: 'var(--gain)' }}>
                {step.num}
              </div>
              <div className="mp-timeline-content mp-glass-card" style={{ padding: 'var(--space-7)' }}>
                <div style={{
                  display: 'inline-block', padding: 'var(--space-1-5) var(--space-3-5)',
                  background: 'transparent', fontSize: 'var(--fs-xs)',
                  textTransform: 'uppercase', letterSpacing: '0.15em',
                  color: 'var(--gain)', marginBottom: 'var(--space-4)',
                  border: '1px solid var(--gain)', fontFamily: 'var(--font-mono)',
                }}>
                  {step.diff}
                </div>
                <h3 className="mp-h3" style={{ fontSize: 'var(--fs-3xl)' }}>{step.title}</h3>
                <p className="mp-p-body">{step.text}</p>
              </div>
            </div>
          ))}
        </div>

        <div style={{ textAlign: 'center', marginTop: 'var(--space-9)' }}>
          <Link to="/register" className="mp-btn-primary" style={{ textDecoration: 'none' }}>
            Create Your Account &amp; Get Your Link
          </Link>
        </div>
      </div>
    </section>
  )
}
