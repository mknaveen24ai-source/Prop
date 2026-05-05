import React from 'react';
import { useBranding } from '../../BrandingContext';
import { getChallengeFeeDisplay, isPaidTenant } from '../../utils/tenantMarketing';

export default function LandingScaling() {
  const { tenant } = useBranding();
  const requiresPayment = isPaidTenant(tenant);
  const challengeFeeDisplay = getChallengeFeeDisplay(tenant);
  const steps = [
    {
      num: "01", title: "Register & Claim Your Account", diff: "Sign Up",
      text: "Create a free account and choose your preferred account size. No payment details required — accounts are released in limited monthly batches based on available liquidity.",
      color: '#2962ff', glow: 'rgba(41, 98, 255, 0.25)'
    },
    {
      num: "02", title: "Phase 1 — Prove Your Skill", diff: "Evaluate",
      text: "Hit the profit target within 30 days. Trade Forex at 1:30 leverage and Gold/Silver at 1:10. Stay within the drawdown limits. Same rules as Phase 2 — no surprises.",
      color: '#7b61ff', glow: 'rgba(123, 97, 255, 0.25)'
    },
    {
      num: "03", title: "Phase 2 — Confirm Consistency", diff: "Verify",
      text: "Same rules, same drawdown limits, same 30-day window. Phase 2 confirms you can reproduce your results. Pass this and you are funded.",
      color: '#00c896', glow: 'rgba(0, 200, 150, 0.25)'
    },
    {
      num: "04", title: "Funded — Trade Real Capital", diff: "Funded",
      text: "Your account is now backed by real capital in our broker. Your trades are executed on live markets. Earn your share of the profits from real trading results.",
      color: '#f0b90b', glow: 'rgba(240, 185, 11, 0.25)'
    }
  ];

  return (
    <section className="mp-section" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: '30%', right: '-10%', width: '500px', height: '500px', background: 'radial-gradient(circle, rgba(123, 97, 255, 0.04), transparent 70%)', pointerEvents: 'none' }} />

      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: '80px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: '20px' }}>
            <span className="mp-badge-dot"></span>
            How It Works
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">
            From Sign-Up to <span className="mp-glow-text">Funded</span>
          </h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            {requiresPayment
              ? `A transparent, straightforward path. Two phases, same rules, and challenge access starting from ${challengeFeeDisplay}.`
              : 'A transparent, straightforward path. Two phases, same rules, zero fees.'}
          </p>
        </div>

        <div className="mp-timeline mp-reveal mp-delay-300">
          {steps.map((step, idx) => (
            <div key={idx} className="mp-timeline-item">
              <div className="mp-timeline-marker" style={{
                borderColor: step.color,
                color: step.color,
                boxShadow: `0 0 30px ${step.glow}, inset 0 0 20px ${step.glow.replace('0.25', '0.05')}`,
              }}>
                {step.num}
              </div>
              <div className="mp-timeline-content mp-glass-card" style={{ padding: '30px' }}>
                <div style={{
                  display: 'inline-block', padding: '5px 14px',
                  background: step.glow.replace('0.25', '0.08'),
                  borderRadius: '6px', fontSize: '11px',
                  textTransform: 'uppercase', letterSpacing: '0.15em',
                  color: step.color, marginBottom: '16px',
                  border: `1px solid ${step.glow.replace('0.25', '0.15')}`,
                  fontFamily: 'DM Mono, monospace',
                }}>
                  {step.diff}
                </div>
                <h3 className="mp-h3" style={{ fontSize: '22px' }}>{step.title}</h3>
                <p className="mp-p-body">{step.text}</p>
                
                {idx === 3 && (
                  <div style={{ marginTop: '20px', height: '6px', background: 'rgba(255,255,255,0.06)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: '100%',
                      background: `linear-gradient(90deg, ${steps[0].color}, ${steps[1].color}, ${steps[2].color}, ${steps[3].color})`,
                      backgroundSize: '200% 100%',
                      animation: 'mp-gradient-shift 3s ease infinite',
                    }} />
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
