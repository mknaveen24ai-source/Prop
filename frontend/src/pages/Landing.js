import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import RiskWarningBanner from '../components/RiskWarningBanner';

// Import Masterpiece sections
import { MASTERPIECE_CSS } from './landing-sections/LandingStyles';
import LandingHero from './landing-sections/LandingHero';
import LandingCalculator from './landing-sections/LandingCalculator';
import LandingFeatures from './landing-sections/LandingFeatures';
import LandingWallOfLove from './landing-sections/LandingWallOfLove';
import LandingScaling from './landing-sections/LandingScaling';
import LandingFAQ from './landing-sections/LandingFAQ';
import LandingFooter from './landing-sections/LandingFooter';

export default function Landing() {
  const [scrolled, setScrolled] = useState(false);
  
  useEffect(() => {
    // Inject Masterpiece CSS
    const styleSheet = document.createElement("style");
    styleSheet.type = "text/css";
    styleSheet.innerText = MASTERPIECE_CSS;
    document.head.appendChild(styleSheet);

    // Scroll reveal observer
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('mp-active');
        }
      });
    }, { threshold: 0.1 });

    const revealElements = document.querySelectorAll('.mp-reveal');
    revealElements.forEach(el => observer.observe(el));

    // Nav bar scroll effect
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);

    // Cleanup
    return () => {
      document.head.removeChild(styleSheet);
      revealElements.forEach(el => observer.unobserve(el));
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  return (
    <>
      <div className="masterpiece-landing" data-theme="dark">
        {/* Liquid / Noise Filter Definitions */}
        <svg style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
          <defs>
            <filter id="mp-liquid">
              <feGaussianBlur in="SourceGraphic" stdDeviation="40" result="blur" />
              <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -11" result="mp-liquid" />
              <feComposite in="SourceGraphic" in2="mp-liquid" operator="atop" />
            </filter>
            <filter id="mp-noise">
              <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch" />
              <feColorMatrix type="saturate" values="0" />
              <feComponentTransfer>
                <feFuncR type="linear" slope="0.05" />
                <feFuncG type="linear" slope="0.05" />
                <feFuncB type="linear" slope="0.05" />
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>

        {/* Background System */}
        <div className="mp-bg-system">
          <div className="mp-bg-noise"></div>
          <div className="mp-bg-orb-1"></div>
          <div className="mp-bg-orb-2"></div>
          <div className="mp-bg-grid"></div>
        </div>

      <RiskWarningBanner />
      
      {/* Glass Navbar */}
      <nav id="mp-nav" style={{
        position: 'fixed', top: '30px', left: '0', right: '0', zIndex: 1000,
        transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        padding: '0',
      }}>
        <div style={{
          maxWidth: '1400px', margin: '0 auto', padding: '0 24px',
        }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '14px 24px',
            background: scrolled ? 'rgba(10, 14, 23, 0.92)' : 'rgba(10, 14, 23, 0.4)',
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            borderRadius: '16px',
            border: scrolled ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(255,255,255,0.04)',
            boxShadow: scrolled ? '0 8px 32px rgba(0,0,0,0.4)' : 'none',
            transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          }}>
            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
              <div className="mp-badge-dot"></div>
              <span style={{ fontFamily: 'Sora, sans-serif', fontSize: '20px', fontWeight: 800, letterSpacing: '0.08em', color: '#fff' }}>
                PROPFIRM <span style={{ color: '#2962ff' }}>V2</span>
              </span>
            </div>

            {/* Center Links (desktop) */}
            <div style={{ display: 'flex', gap: '28px', alignItems: 'center' }}>
              {[
                { label: 'Funding', href: '#mp-calculator' },
                { label: 'Features', href: '#' },
                { label: 'FAQ', href: '#faq' },
              ].map(link => (
                <a key={link.label} href={link.href} style={{
                  color: 'rgba(255,255,255,0.55)', textDecoration: 'none', fontSize: '14px',
                  fontFamily: 'Sora, sans-serif', fontWeight: '500',
                  transition: 'color 0.2s',
                  position: 'relative',
                }}
                onMouseOver={e => e.currentTarget.style.color = '#fff'}
                onMouseOut={e => e.currentTarget.style.color = 'rgba(255,255,255,0.55)'}
                >{link.label}</a>
              ))}
            </div>

            {/* Right Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <ThemeToggle />
              <Link to="/login" style={{
                color: 'rgba(255,255,255,0.7)', textDecoration: 'none', fontSize: '14px',
                fontFamily: 'Sora, sans-serif', fontWeight: '600', padding: '10px 20px',
                transition: 'color 0.2s',
              }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='rgba(255,255,255,0.7)'}>
                Log In
              </Link>
              <Link to="/register" style={{
                background: 'linear-gradient(135deg, #2962ff, #4d82ff)',
                color: '#fff', textDecoration: 'none', fontSize: '14px',
                fontFamily: 'Sora, sans-serif', fontWeight: '600', padding: '10px 24px',
                borderRadius: '10px',
                boxShadow: '0 4px 16px rgba(41,98,255,0.35)',
                transition: 'all 0.3s ease',
              }}>Get Funded</Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Sections */}
      <LandingHero />
      <LandingFeatures />
      <LandingCalculator />
      <LandingScaling />
      <LandingWallOfLove />
      <LandingFAQ />
      <LandingFooter />

      </div>
    </>
  );
}
