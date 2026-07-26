import React from 'react';

export default function LandingWallOfLove() {
  const testimonials = [
    {
      name: "Alex T.", handle: "@alextrades", avatar: "👩‍🦰",
      text: "I couldn't believe how cheap the challenge fee was. Passed Phase 1 in 12 days. Now trading a $25K funded account. This is the real deal.",
      proof: null
    },
    {
      name: "Maria S.", handle: "@mariascalps", avatar: "👨‍🦱",
      text: "The time limit felt fair compared to other firms. Having the same rules in every phase makes it so much simpler.",
      proof: null
    },
    {
      name: "James L.", handle: "@jimmylong", avatar: "👨‍💻",
      text: "Paid a small fee for my $10K account last month, passed both phases trading Gold on 1:10 leverage. Funded now — best money I've spent.",
      proof: null
    },
    {
      name: "Emma W.", handle: "@emmafx", avatar: "👩‍💼",
      text: "Be quick though — I tried to sign up last month and the $50K accounts were already gone. Got in this month's batch though.",
      proof: null
    },
    {
      name: "Lucas K.", handle: "@lucasfund", avatar: "👨‍🚀",
      text: "Finally a prop firm that doesn't charge hundreds in fees. The limited spots mean they're actually serious about backing real traders.",
      proof: null
    },
    {
      name: "Sophie M.", handle: "@sophiemacro", avatar: "👩‍🎤",
      text: "The fact that accounts are liquidity-backed makes me trust them much more than firms that just sell unlimited challenges.",
      proof: null
    },
    {
      name: "Rahul K.", handle: "@rahulpriceaction", avatar: "RK",
      text: "The dashboard is clean and the rules are visible before every trade. I always know exactly where my daily drawdown and profit target stand.",
      proof: null
    },
    {
      name: "Nina P.", handle: "@ninatradesny", avatar: "NP",
      text: "The monthly batch model makes the account slots feel serious. I joined for a smaller account first, passed, and scaled up with more confidence.",
      proof: null
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
          <h2 className="mp-h2 mp-reveal mp-delay-100">What Traders Are Saying</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto' }}>
            Real feedback from traders in our program.
          </p>
        </div>

        <div className="mp-masonry mp-reveal mp-delay-300">
          {testimonials.map((t, idx) => (
            <div key={idx} className="mp-masonry-item">
              <div className="mp-glass-card" style={{ padding: '28px' }}>
                {/* User Info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%',
                    background: 'var(--paper-2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '22px',
                    border: '1px solid var(--rule)',
                  }}>
                    {t.avatar}
                  </div>
                  <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '14px', color: 'var(--ink)' }}>{t.name}</div>
                    <div style={{ fontSize: '12px', color: 'var(--muted)' }}>{t.handle}</div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--muted)" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.46 6C21.69 6.35 20.86 6.58 20 6.69C20.88 6.16 21.56 5.32 21.88 4.31C21.05 4.81 20.13 5.16 19.16 5.36C18.37 4.5 17.26 4 16 4C13.65 4 11.73 5.92 11.73 8.29C11.73 8.63 11.77 8.96 11.84 9.27C8.28 9.09 5.11 7.38 3 4.79C2.63 5.42 2.42 6.16 2.42 6.94C2.42 8.43 3.17 9.75 4.33 10.5C3.62 10.5 2.96 10.3 2.38 10C2.38 10 2.38 10.02 2.38 10.04C2.38 12.11 3.86 13.85 5.82 14.24C5.46 14.34 5.08 14.39 4.69 14.39C4.42 14.39 4.15 14.36 3.89 14.31C4.43 16 6 17.23 7.87 17.26C6.4 18.41 4.53 19.09 2.5 19.09C2.14 19.09 1.78 19.07 1.42 19.03C3.33 20.26 5.6 21 8.04 21C15.98 21 20.32 14.41 20.32 8.7C20.32 8.51 20.32 8.33 20.31 8.14C21.16 7.53 21.89 6.81 22.46 6Z"/>
                    </svg>
                  </div>
                </div>

                {/* Text */}
                <p className="mp-p-body" style={{ fontSize: '14px', lineHeight: 1.7, color: 'var(--muted)' }}>
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
