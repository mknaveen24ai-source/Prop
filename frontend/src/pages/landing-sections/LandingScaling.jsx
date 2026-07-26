import React from 'react';
import { getChallengeFeeDisplay } from '../../utils/tenantMarketing';

export default function LandingScaling() {
  const challengeFeeDisplay = getChallengeFeeDisplay();
  const steps = [
    {
      num: "01", title: "Choose Your Challenge", diff: "Sign Up",
      text: "Pick a 1-step, 2-step, or 3-step model and your preferred account size, then complete checkout to activate — accounts are released in limited monthly batches based on available liquidity.",
      color: 'var(--muted)'
    },
    {
      num: "02", title: "Phase 1 — Prove Your Skill", diff: "Evaluate",
      text: "Hit the profit target within the phase time limit. Trade Forex at 1:30 leverage and Gold/Silver at 1:10. Stay within the drawdown limits — the same rules apply at every phase, no surprises.",
      color: 'var(--muted)'
    },
    {
      num: "03", title: "Verification Phases", diff: "Verify",
      text: "Depending on your model, one or two more phases confirm you can reproduce your results under the same rules and drawdown limits. Pass them all and you are funded.",
      color: 'var(--gain)'
    },
    {
      num: "04", title: "Funded — Trade Real Capital", diff: "Funded",
      text: "Your account is now backed by real capital in our broker. Your trades are executed on live markets. Earn your share of the profits from real trading results.",
      color: 'var(--warn)'
    }
  ];

  return (
    <section className="mp-section" style={{ position: 'relative' }}>
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
            {`A transparent, straightforward path. Choose your model, same rules at every phase, challenge access starting from ${challengeFeeDisplay}.`}
          </p>
        </div>

        <div className="mp-timeline mp-reveal mp-delay-300">
          {steps.map((step, idx) => (
            <div key={idx} className="mp-timeline-item">
              <div className="mp-timeline-marker" style={{
                borderColor: step.color,
                color: step.color,
              }}>
                {step.num}
              </div>
              <div className="mp-timeline-content mp-glass-card" style={{ padding: '30px' }}>
                <div style={{
                  display: 'inline-block', padding: '5px 14px',
                  background: 'transparent',
                  fontSize: '11px',
                  textTransform: 'uppercase', letterSpacing: '0.15em',
                  color: step.color, marginBottom: '16px',
                  border: `1px solid ${step.color}`,
              fontFamily: 'var(--font-mono)',
                }}>
                  {step.diff}
                </div>
                <h3 className="mp-h3" style={{ fontSize: '22px' }}>{step.title}</h3>
                <p className="mp-p-body">{step.text}</p>

                {idx === 3 && (
                  <div style={{ marginTop: '20px', height: '2px', background: 'var(--rule)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: '100%',
                      background: 'var(--ink)',
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
