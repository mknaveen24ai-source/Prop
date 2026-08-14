import React, { useEffect, useRef, useState } from 'react';
import api from '../../services/api';
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

/* ══ TERMINAL ILLUSTRATION ══
   Code-drawn trading-terminal plate — candlesticks + a glowing price line
   + a mock order book — standing in for real product photography until
   the tenant supplies some. Static/deterministic coordinates (no Math.random)
   so the SVG doesn't redraw on every re-render. */
const HERO_CANDLES = [
  { x: 16,  open: 110, close: 95,  high: 90,  low: 115, up: true },
  { x: 44,  open: 95,  close: 100, high: 88,  low: 105, up: false },
  { x: 72,  open: 100, close: 78,  high: 72,  low: 104, up: true },
  { x: 100, open: 78,  close: 85,  high: 70,  low: 90,  up: false },
  { x: 128, open: 85,  close: 58,  high: 52,  low: 88,  up: true },
  { x: 156, open: 58,  close: 66,  high: 50,  low: 70,  up: false },
  { x: 184, open: 66,  close: 34,  high: 28,  low: 68,  up: true },
  { x: 212, open: 34,  close: 42,  high: 26,  low: 48,  up: false },
];

const HERO_ORDERBOOK = [
  { side: 'ask', price: '1.08652', size: '2.4M' },
  { side: 'ask', price: '1.08647', size: '1.1M' },
  { side: 'ask', price: '1.08641', size: '3.6M' },
  { side: 'bid', price: '1.08633', size: '2.9M' },
  { side: 'bid', price: '1.08627', size: '4.2M' },
  { side: 'bid', price: '1.08619', size: '1.7M' },
];

function TerminalIllustration() {
  return (
    <div>
      <svg viewBox="0 0 240 130" width="100%" height="auto" style={{ display: 'block' }} aria-hidden="true">
        <line x1="0" y1="45" x2="240" y2="45" stroke="var(--rule)" strokeWidth="0.5" opacity="0.5" />
        <line x1="0" y1="80" x2="240" y2="80" stroke="var(--rule)" strokeWidth="0.5" opacity="0.5" />
        <line x1="0" y1="120" x2="240" y2="120" stroke="var(--rule)" strokeWidth="1" />
        {HERO_CANDLES.map((c) => (
          <g key={c.x}>
            <line x1={c.x} y1={c.high} x2={c.x} y2={c.low} stroke={c.up ? 'var(--gain)' : 'var(--loss)'} strokeWidth="1.5" />
            <rect
              x={c.x - 5}
              y={Math.min(c.open, c.close)}
              width="10"
              height={Math.max(2, Math.abs(c.close - c.open))}
              fill={c.up ? 'var(--gain)' : 'var(--loss)'}
              opacity="0.9"
            />
          </g>
        ))}
        <polyline
          points={HERO_CANDLES.map((c) => `${c.x},${c.close}`).join(' ')}
          fill="none"
          stroke="var(--warn)"
          strokeWidth="1.5"
          strokeLinejoin="round"
          style={{ filter: 'drop-shadow(0 0 5px var(--glow-accent))' }}
        />
      </svg>

      <div style={{ marginTop: '14px', fontFamily: 'var(--font-mono)', fontSize: '10.5px' }}>
        {HERO_ORDERBOOK.map((row, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '2.5px 0', borderBottom: i === 2 ? '1px solid var(--rule-soft)' : 'none' }}>
            <span style={{ color: row.side === 'bid' ? 'var(--gain)' : 'var(--loss)' }}>{row.price}</span>
            <span style={{ color: 'var(--muted)' }}>{row.size}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════
   LANDING HERO SECTION — editorial masthead: headline + justified intro
   column on the left, a glass-matted "plate" on the right holding a
   code-drawn trading-terminal illustration with an ambient gold glow
   and a light scroll parallax.
   ══════════════════════════════════════════════════════════════ */
export default function LandingHero({ onPrimaryCta, onSecondaryCta }) {
  const landingCopy = getTenantLandingCopy();
  const heroRef = useRef(null);
  const platePar = useRef(null);
  // Same public endpoint LandingLiveStats reads from — real figure instead
  // of a hardcoded number. Fetched independently here (not lifted to
  // Landing.jsx) since the hero renders eagerly above the fold while
  // LandingLiveStats is a lazy section that may mount much later.
  const [fundedTraderCount, setFundedTraderCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/public/landing-stats', { skipAuthRedirect: true })
      .then((res) => {
        if (cancelled) return;
        const count = Number(res.data?.funded_trader_count);
        if (Number.isFinite(count)) setFundedTraderCount(count);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Light scroll parallax on the hero plate — direct style writes on scroll
  // (no state) to avoid re-rendering the whole hero on every scroll tick.
  useEffect(() => {
    function onScroll() {
      if (!platePar.current) return;
      const offset = Math.max(-24, Math.min(24, window.scrollY * 0.08));
      platePar.current.style.transform = `translateY(${offset}px)`;
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  function scrollToCalculator() {
    const target = document.getElementById('mp-calculator');
    const nav = document.querySelector('.nav-transparent');
    const navRect = nav ? nav.getBoundingClientRect() : { top: 0, height: 72 };
    const headerOffset = (navRect.top || 0) + navRect.height;
    if (target) {
      const top = window.pageYOffset + target.getBoundingClientRect().top - headerOffset - 28;
      window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    }
  }

  return (
    <section className="mp-section mp-hero" ref={heroRef} style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', paddingTop: '120px', position: 'relative' }}>

      <div className="mp-container" style={{ position: 'relative', zIndex: 2 }}>
        <div
          className="mp-hero-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)',
            gap: '48px',
            alignItems: 'center',
          }}
        >
          <div style={{ position: 'relative', zIndex: 10 }}>
            <div className="mp-badge mp-reveal mp-active" style={{ marginBottom: '32px' }}>
              <ScrambleText text={landingCopy.heroBadge} delay={500} />
            </div>

            <h1 className="mp-h1 mp-reveal mp-delay-100 mp-active" style={{ textWrap: 'balance' }}>
              {landingCopy.heroTitleLead} <span className="mp-glow-text" style={{ whiteSpace: 'nowrap' }}>{landingCopy.heroTitleHighlight}</span><br />
              Start Trading <span style={{ color: 'var(--gain)' }}>Ours.</span>
            </h1>

            {/* Justified two-column intro (Modern Gazette handoff spec) collapses
                to the single lead paragraph below on narrow viewports. */}
            <div
              className="mp-hero-intro mp-reveal mp-delay-200 mp-active"
              style={{ display: 'flex', gap: '22px', maxWidth: '640px', marginBottom: '40px' }}
            >
              <p style={{
                flex: 1, fontSize: '15px', lineHeight: 1.72, color: 'var(--mp-text-secondary)',
                textAlign: 'justify', hyphens: 'auto', margin: 0,
              }}>
                {landingCopy.heroSubtitle}
              </p>
            </div>

            <div className="mp-reveal mp-delay-300 mp-active" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                className="mp-btn-primary"
                onClick={() => {
                  if (onPrimaryCta) onPrimaryCta();
                  scrollToCalculator();
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
                scrollToCalculator();
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
                  {fundedTraderCount != null
                    ? <AnimatedCounter value={String(fundedTraderCount)} suffix="" />
                    : <span>&mdash;</span>} Funded Traders
                </span>
              </div>
              <div className="mp-stat-divider" />
              <div className="mp-stat-item">
                <span className="mp-stat-number" style={{ color: 'var(--warn)' }}>Weekly</span>
                <span className="mp-stat-number">&nbsp;Payout Cycles</span>
              </div>
            </div>
          </div>

          {/* Plate — glass-matted frame holding a code-drawn trading-terminal
              illustration. Swap the <TerminalIllustration /> for a real <img>
              once product photography is supplied; the frame/caption stay. */}
          <div
            className="mp-hero-plate mp-reveal mp-delay-200 mp-active"
            style={{ position: 'relative', zIndex: 10 }}
          >
            <div ref={platePar} style={{ position: 'relative' }}>
              <div style={{
                position: 'absolute', inset: '-14%',
                background: 'radial-gradient(circle at 50% 40%, var(--glow-accent), transparent 65%)',
                filter: 'blur(60px)', opacity: 0.55, zIndex: 0, pointerEvents: 'none',
              }} />
              <div style={{
                position: 'relative', zIndex: 1,
                border: '1px solid var(--rule)', background: 'var(--glass)',
                backdropFilter: 'blur(14px) saturate(140%)', WebkitBackdropFilter: 'blur(14px) saturate(140%)',
                padding: '12px', boxShadow: 'var(--elev), 0 0 60px -30px var(--glow-primary)',
              }}>
                <div style={{
                  aspectRatio: '4 / 5', border: '1px solid var(--rule-soft)',
                  background: 'var(--paper-2)',
                  display: 'flex', flexDirection: 'column', justifyContent: 'center',
                  padding: '28px 22px',
                }}>
                  <TerminalIllustration />
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10px', letterSpacing: '0.1em', color: 'var(--muted)', marginTop: '10px', textAlign: 'center' }}>
                  Fig. 1 — funded and trading live
                </div>
              </div>
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
