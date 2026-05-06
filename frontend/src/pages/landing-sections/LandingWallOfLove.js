import React from 'react';

export default function LandingWallOfLove() {
  const testimonials = [
    {
      name: "Alex T.", handle: "@alextrades", avatar: "👩‍🦰",
      text: "I couldn't believe it was actually free. Passed Phase 1 in 12 days. Now trading a $25K funded account. This is the real deal.",
      proof: null
    },
    {
      name: "Maria S.", handle: "@mariascalps", avatar: "👨‍🦱",
      text: "The 30-day time limit felt pressure-free compared to other firms. Having the same rules in both phases makes it so much simpler.",
      proof: null
    },
    {
      name: "James L.", handle: "@jimmylong", avatar: "👨‍💻",
      text: "Claimed my free $10K account last month, passed both phases trading Gold on 1:10 leverage. Funded now. Zero fees paid.",
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
    }
  ];

  return (
    <section className="mp-section" style={{ background: 'rgba(10,14,23,0.6)', position: 'relative' }}>
      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: '600px', height: '600px', background: 'radial-gradient(circle, rgba(240,185,11,0.03), transparent 60%)', pointerEvents: 'none' }} />

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
              <div className="mp-glass-card" style={{ padding: '28px', borderRadius: '20px' }}>
                {/* User Info */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '18px' }}>
                  <div style={{
                    width: '44px', height: '44px', borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(41,98,255,0.15), rgba(123,97,255,0.1))',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '22px',
                    border: '2px solid rgba(41,98,255,0.15)',
                    boxShadow: '0 0 16px rgba(41,98,255,0.08)',
                  }}>
                    {t.avatar}
                  </div>
                  <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: '14px', color: '#fff' }}>{t.name}</div>
                    <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>{t.handle}</div>
                  </div>
                  <div style={{ marginLeft: 'auto' }}>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="rgba(255,255,255,0.2)" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.46 6C21.69 6.35 20.86 6.58 20 6.69C20.88 6.16 21.56 5.32 21.88 4.31C21.05 4.81 20.13 5.16 19.16 5.36C18.37 4.5 17.26 4 16 4C13.65 4 11.73 5.92 11.73 8.29C11.73 8.63 11.77 8.96 11.84 9.27C8.28 9.09 5.11 7.38 3 4.79C2.63 5.42 2.42 6.16 2.42 6.94C2.42 8.43 3.17 9.75 4.33 10.5C3.62 10.5 2.96 10.3 2.38 10C2.38 10 2.38 10.02 2.38 10.04C2.38 12.11 3.86 13.85 5.82 14.24C5.46 14.34 5.08 14.39 4.69 14.39C4.42 14.39 4.15 14.36 3.89 14.31C4.43 16 6 17.23 7.87 17.26C6.4 18.41 4.53 19.09 2.5 19.09C2.14 19.09 1.78 19.07 1.42 19.03C3.33 20.26 5.6 21 8.04 21C15.98 21 20.32 14.41 20.32 8.7C20.32 8.51 20.32 8.33 20.31 8.14C21.16 7.53 21.89 6.81 22.46 6Z"/>
                    </svg>
                  </div>
                </div>
                
                {/* Text */}
                <p className="mp-p-body" style={{ fontSize: '14px', lineHeight: 1.7, color: 'rgba(255,255,255,0.6)' }}>
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
