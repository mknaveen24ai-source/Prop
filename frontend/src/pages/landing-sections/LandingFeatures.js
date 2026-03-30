import React, { useRef, useEffect } from 'react';

export default function LandingFeatures() {
  const gridRef = useRef(null);

  // 3D tilt + Proximity Glow (Torch) effect
  useEffect(() => {
    const grid = gridRef.current;
    const cards = grid?.querySelectorAll('.mp-feature-card');
    if (!grid || !cards) return;

    const handleGlobalMove = (e) => {
      const rect = grid.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      grid.style.setProperty('--grid-mouse-x', `${x}px`);
      grid.style.setProperty('--grid-mouse-y', `${y}px`);
    };

    const handlers = [];
    cards.forEach(card => {
      const handleMove = (e) => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const centerX = rect.width / 2;
        const centerY = rect.height / 2;
        const rotateX = (y - centerY) / centerY * -8; // Slightly more aggressive
        const rotateY = (x - centerX) / centerX * 8;
        card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-8px) scale(1.02)`;
        card.style.boxShadow = `${-rotateY}px ${rotateX}px 30px rgba(0,0,0,0.4)`;
      };
      const handleLeave = () => {
        card.style.transform = 'perspective(1000px) rotateX(0) rotateY(0) translateY(0) scale(1)';
        card.style.boxShadow = '';
      };
      card.addEventListener('mousemove', handleMove);
      card.addEventListener('mouseleave', handleLeave);
      handlers.push({ card, handleMove, handleLeave });
    });

    window.addEventListener('mousemove', handleGlobalMove);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMove);
      handlers.forEach(({ card, handleMove, handleLeave }) => {
        card.removeEventListener('mousemove', handleMove);
        card.removeEventListener('mouseleave', handleLeave);
      });
    };
  }, []);

  const bentoItems = [
    {
      colSpan: '1 / -1',
      title: '100% Free Funded Accounts',
      desc: 'No evaluation fees. No hidden costs. No credit card required. We fund elite traders from our own liquid capital reserves — pass the institutional assessment and start trading.',
      iconColor: '#00c896',
      glowColor: 'rgba(0, 200, 150, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#00c896" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    },
    {
      colSpan: 'span 6',
      title: 'Institutional Evaluation',
      desc: 'Clear, documented rules for both phases. Reach the profit target without breaching dynamic or daily drawdown limits. Pure skill-based selection.',
      iconColor: '#2962ff',
      glowColor: 'rgba(41, 98, 255, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#2962ff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      )
    },
    {
      colSpan: 'span 6',
      title: 'Precise Time Horizons',
      desc: 'Each phase provides 30 calendar days of execution time. High-performance trading environments with zero artificial latency or slippage.',
      iconColor: '#7b61ff',
      glowColor: 'rgba(123, 97, 255, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#7b61ff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: 'Liquidity Backed',
      desc: 'Funded accounts are deployed on real liquidity bridges. We execute where it matters, putting institutional weight behind your strategy.',
      iconColor: '#f0b90b',
      glowColor: 'rgba(240, 185, 11, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#f0b90b" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2"></rect>
          <line x1="2" y1="10" x2="22" y2="10"></line>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: '1:30 Execution Leverage',
      desc: 'Standard institutional leverage across Forex and Commodities. Optimized for risk-adjusted returns and capital preservation.',
      iconColor: '#00e5ff',
      glowColor: 'rgba(0, 229, 255, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#00e5ff" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
          <polyline points="17 6 23 6 23 12"></polyline>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: 'Curated Batch Releases',
      desc: 'Accounts are released in exclusive monthly cycles to maintain liquidity integrity. Professional grade funding for a selected number of traders.',
      iconColor: '#ff4757',
      glowColor: 'rgba(255, 71, 87, 0.15)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="#ff4757" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )
    },
  ];

  return (
    <section className="mp-section" style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: '20%', left: '50%', transform: 'translateX(-50%)', width: '800px', height: '800px', background: 'radial-gradient(circle, rgba(41, 98, 255, 0.05), transparent 70%)', pointerEvents: 'none', filter: 'blur(100px)' }} />
      
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: '100px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: '24px' }}>
            <span className="mp-badge-dot"></span>
            The Standard
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">Institutional Grade. <span className="mp-shimmer">Completely Free.</span></h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto', maxWidth: '800px' }}>
            We bridge the gap between retail skill and institutional capital. Transform your edge 
            into a funded career without the barrier of entry fees.
          </p>
        </div>

        <div ref={gridRef} style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: '28px',
          position: 'relative',
        }}>
          {/* Global Torch Effect Overlay (CSS via JS variables) */}
          <style>{`
            .mp-feature-card::after {
              content: '';
              position: absolute;
              inset: -1px;
              border-radius: 24px;
              background: radial-gradient(
                600px circle at var(--grid-mouse-x, 0) var(--grid-mouse-y, 0),
                rgba(41, 98, 255, 0.12),
                transparent 40%
              );
              opacity: 0;
              transition: opacity 0.5s ease;
              pointer-events: none;
              z-index: 3;
            }
            .mp-feature-card:hover::after {
              opacity: 1;
            }
          `}</style>

          {bentoItems.map((item, i) => (
            <div
              key={i}
              className={'mp-bento-item mp-feature-card mp-reveal mp-delay-' + ((i + 1) * 100)}
              style={{
                display: 'flex', flexDirection: 'column', padding: '48px',
                transition: 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
                transformStyle: 'preserve-3d',
                gridColumn: item.colSpan,
                minHeight: '260px',
                background: 'rgba(13, 18, 32, 0.4)',
                border: '1px solid rgba(255,255,255,0.04)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div style={{
                marginBottom: '32px',
                width: '80px', height: '80px',
                borderRadius: '20px',
                background: item.glowColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${item.iconColor}33`,
                transition: 'all 0.4s ease',
                transform: 'translateZ(20px)',
              }}>
                {item.icon}
              </div>
              <h3 className="mp-h3" style={{ fontSize: '24px', marginBottom: '16px', color: '#fff', transform: 'translateZ(10px)' }}>{item.title}</h3>
              <p className="mp-p-body" style={{ flexGrow: 1, fontSize: '16px', color: 'rgba(255,255,255,0.5)', transform: 'translateZ(5px)' }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
