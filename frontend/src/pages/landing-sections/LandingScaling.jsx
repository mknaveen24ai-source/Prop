import React from 'react';
import { getChallengeFeeDisplay } from '../../utils/tenantMarketing';

export default function LandingScaling() {
  const challengeFeeDisplay = getChallengeFeeDisplay();
  const steps = [
    {
      num: "01", title: "Choose Your Challenge", diff: "Sign Up",
      text: "Pick a 1-step, 2-step, or 3-step model and your preferred account size, then complete checkout. Your evaluation account is issued as soon as payment clears.",
      color: 'var(--muted)'
    },
    {
      num: "02", title: "Phase 1 — Prove Your Skill", diff: "Evaluate",
      text: "Hit the profit target within the phase time limit. Leverage is unlimited and there is no position-size cap — stay inside the daily loss cap and the trailing drawdown floor. The same rules apply at every phase, no surprises.",
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
        <div style={{ textAlign: 'center', marginBottom: 'var(--space-11)' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-5)' }}>
            <span className="mp-badge-dot"></span>
            How It Works
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">
            Here's Exactly What Happens After You Click <span className="mp-glow-text">Start</span>
          </h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            {`No surprise steps, no hidden fine print revealed after checkout. Choose your model, same rules at every phase, challenge access ${challengeFeeDisplay.toLowerCase()}.`}
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
              <div className="mp-timeline-content mp-glass-card" style={{ padding: 'var(--space-7)' }}>
                <div style={{
                  display: 'inline-block', padding: 'var(--space-1-5) var(--space-3-5)',
                  background: 'transparent',
                  fontSize: 'var(--fs-xs)',
                  textTransform: 'uppercase', letterSpacing: '0.15em',
                  color: step.color, marginBottom: 'var(--space-4)',
                  border: `1px solid ${step.color}`,
              fontFamily: 'var(--font-mono)',
                }}>
                  {step.diff}
                </div>
                <h3 className="mp-h3" style={{ fontSize: 'var(--fs-3xl)' }}>{step.title}</h3>
                <p className="mp-p-body">{step.text}</p>

                {idx === 3 && (
                  <div style={{ marginTop: 'var(--space-5)', height: '2px', background: 'var(--rule)', overflow: 'hidden' }}>
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
