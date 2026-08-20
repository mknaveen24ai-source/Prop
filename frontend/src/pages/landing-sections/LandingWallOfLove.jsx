import React from 'react';

export default function LandingWallOfLove() {
  // Illustrative trader sentiment, not individual verified quotes — no invented
  // names, handles, avatars, dollar figures, or timeframes. Every claim here
  // reflects a real, documented product mechanic (same rules per phase, live
  // quota depletion, disclosed leverage, liquidity-backed funding, dashboard
  // drawdown tracking, monthly batch releases). Swap in real trader
  // testimonials here once you have them to attribute.
  const testimonials = [
    {
      role: "Funded Trader", program: "2-Step Program",
      text: "The rules were clear from day one — no surprises at payout time. That's rare in this industry.",
    },
    {
      role: "Funded Trader", program: "3-Step Program",
      text: "Every phase plays by the same rulebook. Once I understood that, the whole evaluation felt a lot less intimidating.",
    },
    {
      role: "Funded Trader", program: "1-Step Program",
      text: "Knowing my leverage and instruments upfront meant I could plan my risk before I ever placed a trade.",
    },
    {
      role: "Evaluation Trader", program: "Account Selection",
      text: "Account slots really do fill up — I watched a size go from open to full while I was deciding. Glad I didn't wait.",
    },
    {
      role: "Funded Trader", program: "3-Step Program",
      text: "The entry cost felt low enough to just try it, instead of talking myself out of it for another month.",
    },
    {
      role: "Funded Trader", program: "2-Step Program",
      text: "Knowing funded accounts trade on real liquidity, not a simulated bucket shop, made the decision easier.",
    },
    {
      role: "Evaluation Trader", program: "Dashboard",
      text: "My dashboard shows exactly where my drawdown and profit target stand, every single day. No guessing.",
    },
    {
      role: "Funded Trader", program: "1-Step Program",
      text: "I started small to test the process, passed, and scaled up once I trusted how it worked.",
    }
  ];

  return (
    <section className="mp-section" style={{ background: 'var(--paper-2)', position: 'relative' }}>
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: '80px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: '20px' }}>
            <span className="mp-badge-dot"></span>
            Community
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">What Traders Say About the Process</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            Illustrative feedback reflecting how the program actually works — real trader stories coming soon.
          </p>
        </div>

        <div className="mp-masonry mp-reveal mp-delay-300">
          {testimonials.map((t, idx) => (
            <div key={idx} className="mp-masonry-item">
              <div className="mp-glass-card" style={{ padding: '28px' }}>
                {/* Role / program attribution — illustrative, not an individual identity */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                  <div style={{
                    width: '4px', height: '36px',
                    background: 'var(--warn)',
                  }} />
                  <div>
                    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 'var(--fs-md)', color: 'var(--ink)' }}>{t.role}</div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>{t.program}</div>
                  </div>
                </div>

                {/* Text */}
                <p className="mp-p-body" style={{ fontSize: 'var(--fs-md)', lineHeight: 1.7, color: 'var(--muted)' }}>
                  {t.text}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
