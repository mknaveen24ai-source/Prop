import React from 'react';
import { getTenantLandingCopy } from '../../utils/tenantMarketing';

export default function LandingFeatures() {
  const landingCopy = getTenantLandingCopy();

  const bentoItems = [
    {
      colSpan: '1 / -1',
      title: 'Live Challenge Access',
      desc: landingCopy.featuresSubtitle,
      iconColor: 'var(--gain)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--gain)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
          <polyline points="22 4 12 14.01 9 11.01" />
        </svg>
      )
    },
    {
      colSpan: 'span 6',
      title: 'Institutional Evaluation',
      desc: 'The same documented rules apply to every phase, whichever model you pick. Hit the profit target without breaching the drawdown limit. Pure skill-based selection — no surprise conditions revealed later.',
      iconColor: 'var(--muted)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--muted)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
      )
    },
    {
      colSpan: 'span 6',
      title: 'No Artificial Rush',
      desc: 'Each phase gives you 45 calendar days — enough room to trade your edge, not the clock. High-performance execution with zero artificial latency or slippage.',
      iconColor: 'var(--muted)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--muted)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: 'Liquidity Backed',
      desc: 'Funded accounts are deployed on real liquidity bridges. We execute where it matters, putting institutional weight behind your strategy.',
      iconColor: 'var(--warn)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--warn)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2"></rect>
          <line x1="2" y1="10" x2="22" y2="10"></line>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: '1:30 Execution Leverage',
      desc: 'Standard institutional leverage across Forex and Commodities. Optimized for risk-adjusted returns and capital preservation.',
      iconColor: 'var(--muted)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--muted)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
          <polyline points="17 6 23 6 23 12"></polyline>
        </svg>
      )
    },
    {
      colSpan: 'span 4',
      title: 'Curated Batch Releases',
      desc: 'Each account size has a limited monthly allocation to protect liquidity integrity. Once a tier fills, it reopens automatically the following month — check the live counter above before it does.',
      iconColor: 'var(--loss)',
      icon: (
        <svg viewBox="0 0 24 24" width="44" height="44" stroke="var(--loss)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      )
    },
  ];

  return (
    <section className="mp-section" style={{ position: 'relative' }}>
      <div className="mp-container">
        <div style={{ textAlign: 'center', marginBottom: '100px' }}>
          <div className="mp-badge mp-reveal" style={{ marginBottom: 'var(--space-6)' }}>
            <span className="mp-badge-dot"></span>
            The Standard
          </div>
          <h2 className="mp-h2 mp-reveal mp-delay-100">{landingCopy.featuresHeadline}</h2>
          <p className="mp-p-lead mp-reveal mp-delay-200" style={{ margin: '0 auto', maxWidth: '800px' }}>
            {landingCopy.featuresSubtitle}
          </p>
        </div>

        <div className="mp-feature-grid" style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(12, 1fr)',
          gap: '28px',
          position: 'relative',
        }}>
          {bentoItems.map((item, i) => (
            <div
              key={i}
              className={'mp-bento-item mp-feature-card mp-reveal mp-delay-' + ((i + 1) * 100)}
              style={{
                display: 'flex', flexDirection: 'column', padding: 'var(--space-9)',
                gridColumn: item.colSpan,
                minHeight: '260px',
                background: 'var(--bg-surface)',
                border: '1px solid var(--border)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <div style={{
                marginBottom: 'var(--space-7)',
                width: '80px', height: '80px',
                background: 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${item.iconColor}`,
                transition: 'border-color 0.3s ease',
              }}>
                {item.icon}
              </div>
              <h3 className="mp-h3" style={{ fontSize: 'var(--fs-4xl)', marginBottom: 'var(--space-4)', color: 'var(--ink)' }}>{item.title}</h3>
              <p className="mp-p-body" style={{ flexGrow: 1, fontSize: 'var(--fs-lg)', color: 'var(--muted)' }}>{item.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
