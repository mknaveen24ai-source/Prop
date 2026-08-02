import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMemoryItem, setMemoryItem } from '../../utils/memoryStore';
import { getTenantLandingCopy } from '../../utils/tenantMarketing';

/* ══ SCRAMBLE TEXT EFFECT ══ */
function ScrambleText({ text, delay = 0 }) {
  const [display, setDisplay] = React.useState('');
  const chars = '!<>-_\\/[]{}—=+*^?#________';

  React.useEffect(() => {
    let iteration = 0;
    let timeout;
    let interval;

    const start = () => {
      interval = setInterval(() => {
        setDisplay(text.split('').map((char, index) => {
          if (index < iteration) return text[index];
          return chars[Math.floor(Math.random() * chars.length)];
        }).join(''));

        if (iteration >= text.length) clearInterval(interval);
        iteration += 1 / 3;
      }, 30);
    };

    timeout = setTimeout(start, delay);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, [text, delay]);

  return <span>{display}</span>;
}

/* ══ ANIMATED COUNTER ══ */
function AnimatedCounter({ value, prefix = '', suffix = '', duration = 2000 }) {
  const ref = useRef(null);
  const counted = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !counted.current) {
        counted.current = true;
        let start = 0;
        const target = parseFloat(value.replace(/[^0-9.]/g, ''));
        const startTime = performance.now();
        const step = (now) => {
          const progress = Math.min((now - startTime) / duration, 1);
          const ease = 1 - Math.pow(1 - progress, 4);
          start = target * ease;
          el.textContent = prefix + start.toLocaleString(undefined, { maximumFractionDigits: 0 }) + suffix;
          if (progress < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }
    }, { threshold: 0.5 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value, prefix, suffix, duration]);

  return <span ref={ref}>{prefix}0{suffix}</span>;
}

/* ══════════════════════════════════════════════════════════════
   LANDING HERO SECTION — flat editorial masthead, no 3D/glow/particles
   ══════════════════════════════════════════════════════════════ */
export default function LandingHero({ onPrimaryCta, onSecondaryCta }) {
  const navigate = useNavigate();
  const landingCopy = getTenantLandingCopy();
  const heroRef = useRef(null);

  return (
    <section className="mp-section mp-hero" ref={heroRef} style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', paddingTop: '120px', position: 'relative' }}>

      <div className="mp-container" style={{ position: 'relative', zIndex: 2 }}>

        <div style={{ maxWidth: '950px', position: 'relative', zIndex: 10 }}>
          <div className="mp-badge mp-reveal mp-active" style={{ marginBottom: '32px' }}>
            <ScrambleText text={landingCopy.heroBadge} delay={500} />
          </div>

          <h1 className="mp-h1 mp-reveal mp-delay-100 mp-active" style={{ textWrap: 'balance' }}>
            {landingCopy.heroTitleLead} <span className="mp-glow-text" style={{ whiteSpace: 'nowrap' }}>{landingCopy.heroTitleHighlight}</span><br />
            Start Trading <span style={{ color: 'var(--gain)' }}>Ours.</span>
          </h1>

          <p className="mp-p-lead mp-reveal mp-delay-200 mp-active" style={{ textWrap: 'balance' }}>
            {landingCopy.heroSubtitle}
          </p>

          <div className="mp-reveal mp-delay-300 mp-active" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="mp-btn-primary"
              onClick={() => {
                // Save pending challenge intent in memory so /checkout can
                // show the right order summary. Default size 10000; overridden
                // by the pricing section if a size was selected there instead.
                const selectedSize = parseInt(getMemoryItem('heroSelectedSize') || '10000')
                setMemoryItem('pendingChallenge', JSON.stringify({
                  accountSize: selectedSize,
                  accountType: 'phase1',
                  stepModel: null
                }))
                if (onPrimaryCta) onPrimaryCta();
                navigate('/checkout');
              }}
              style={{ padding: '22px 54px', fontSize: '18px' }}
            >
              {landingCopy.heroPrimaryCta}
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M5 12H19M19 12L12 5M19 12L12 19" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button className="mp-btn-secondary" onClick={() => {
              if (onSecondaryCta) onSecondaryCta();
              const target = document.getElementById('mp-calculator');
              const nav = document.querySelector('.nav-transparent');
              const navRect = nav ? nav.getBoundingClientRect() : { top: 0, height: 72 };
              const headerOffset = (navRect.top || 0) + navRect.height;
              if (target) {
                const top = window.pageYOffset + target.getBoundingClientRect().top - headerOffset - 28;
                window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
              }
            }} style={{ padding: '20px 40px' }}>
              View Account Sizes
            </button>
          </div>

          {/* Trust Stats */}
          <div className="mp-reveal mp-delay-400 mp-active mp-stat-counter">
            <div className="mp-stat-item">
                <span style={{ color: 'var(--warn)', fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 700 }}>{landingCopy.heroStatsLead}</span>
              <span className="mp-stat-number">&nbsp;{landingCopy.heroStatsLeadSuffix}</span>
            </div>
            <div className="mp-stat-divider" />
            <div className="mp-stat-item">
              <span className="mp-stat-number">
                <AnimatedCounter value="2400" suffix="" /> Funded Traders
              </span>
            </div>
            <div className="mp-stat-divider" />
            <div className="mp-stat-item">
              <span className="mp-stat-number" style={{ color: 'var(--warn)' }}>Weekly</span>
              <span className="mp-stat-number">&nbsp;Payout Cycles</span>
            </div>
          </div>
        </div>
      </div>

      {/* Scroll indicator */}
      <div style={{ position: 'absolute', bottom: '40px', left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', opacity: 0.4, animation: 'mp-scroll-bounce 2s ease-in-out infinite' }}>
              <span style={{ fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.2em', fontFamily: 'var(--font-mono)' }}>Scroll to explore</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </section>
  );
}
