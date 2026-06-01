import React, { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getMemoryItem, setMemoryItem } from '../../utils/memoryStore';
import { useBranding } from '../../BrandingContext';
import { getTenantLandingCopy } from '../../utils/tenantMarketing';

/* ══════════════════════════════════════════════════════════════
   3D PARTICLE CANVAS — Connected nodes + floating orbs
   ══════════════════════════════════════════════════════════════ */
function ParticleCanvas() {
  const canvasRef = useRef(null);
  const animRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const particlesRef = useRef([]);

  const initParticles = useCallback((w, h) => {
    const isSmall = w < 768;
    const count = Math.min(
      Math.floor((w * h) / (isSmall ? 18000 : 13000)),
      isSmall ? 46 : 90
    );
    const particles = [];
    const colors = [
      'rgba(41, 98, 255, 0.6)',
      'rgba(41, 98, 255, 0.4)',
      'rgba(0, 200, 150, 0.4)',
      'rgba(240, 185, 11, 0.3)',
      'rgba(123, 97, 255, 0.35)',
    ];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r: Math.random() * 2 + 1,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
    particlesRef.current = particles;
  }, []);

  useEffect(() => {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }

    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    let dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = cvs.parentElement.offsetWidth;
    let h = cvs.parentElement.offsetHeight;
    cvs.width = Math.floor(w * dpr);
    cvs.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    initParticles(w, h);

    const handleResize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = cvs.parentElement.offsetWidth;
      h = cvs.parentElement.offsetHeight;
      cvs.width = Math.floor(w * dpr);
      cvs.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initParticles(w, h);
    };
    const handleMouse = (e) => {
      const rect = cvs.getBoundingClientRect();
      mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    window.addEventListener('resize', handleResize);
    window.addEventListener('pointermove', handleMouse, { passive: true });

    const draw = () => {
      if (document.hidden) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, w, h);
      const pts = particlesRef.current;
      const mx = mouseRef.current.x;
      const my = mouseRef.current.y;

      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        const dmx = mx - p.x;
        const dmy = my - p.y;
        const dm = Math.sqrt(dmx * dmx + dmy * dmy);
        if (dm < 200 && dm > 0) {
          p.x += dmx * 0.002;
          p.y += dmy * 0.002;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }

      const connDist = 140;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x;
          const dy = pts[i].y - pts[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < connDist) {
            const alpha = (1 - dist / connDist) * 0.15;
            ctx.beginPath();
            ctx.moveTo(pts[i].x, pts[i].y);
            ctx.lineTo(pts[j].x, pts[j].y);
            ctx.strokeStyle = `rgba(41, 98, 255, ${alpha})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      animRef.current = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('pointermove', handleMouse);
    };
  }, [initParticles]);

  return <canvas ref={canvasRef} className="mp-hero-canvas" />;
}

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

/* ══ MAGNETIC BUTTON HOOK ══ */
function useMagnetic(ref, strength = 0.4) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const handleMouse = (e) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      const dist = Math.sqrt(x*x + y*y);

      if (dist < 150) {
        el.style.transform = `translate(${x * strength}px, ${y * strength}px)`;
      } else {
        el.style.transform = '';
      }
    };

    const handleLeave = () => {
      el.style.transform = '';
    };

    window.addEventListener('mousemove', handleMouse);
    el.addEventListener('mouseleave', handleLeave);
    return () => {
      window.removeEventListener('mousemove', handleMouse);
      el.removeEventListener('mouseleave', handleLeave);
    };
  }, [ref, strength]);
}

/* ══════════════════════════════════════════════════════════════
   LANDING HERO SECTION
   ══════════════════════════════════════════════════════════════ */
export default function LandingHero({ onPrimaryCta, onSecondaryCta }) {
  const navigate = useNavigate();
  const { tenant } = useBranding();
  const landingCopy = getTenantLandingCopy(tenant);
  const heroRef = useRef(null);
  const magneticBtnRef = useRef(null);
  useMagnetic(magneticBtnRef, 0.35);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!heroRef.current) return;
      const { clientX, clientY } = e;
      const { innerWidth, innerHeight } = window;
      const xPos = (clientX / innerWidth - 0.5) * 40; // Increased for parallax
      const yPos = (clientY / innerHeight - 0.5) * 40;
      heroRef.current.style.setProperty('--mouse-x', xPos + 'px');
      heroRef.current.style.setProperty('--mouse-y', yPos + 'px');
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  return (
    <section className="mp-section mp-hero" ref={heroRef} style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', paddingTop: '120px', position: 'relative' }}>
      
      <ParticleCanvas />

      {/* Floating 3D Shapes with Parallax */}
      <div className="mp-float-shape mp-float-shape-1" style={{ transform: 'translate(calc(var(--mouse-x) * 0.5), calc(var(--mouse-y) * 0.5)) rotate(45deg)' }} />
      <div className="mp-float-shape mp-float-shape-2" style={{ transform: 'translate(calc(var(--mouse-x) * -0.8), calc(var(--mouse-y) * -0.8))' }} />
      <div className="mp-float-shape mp-float-shape-3" style={{ transform: 'translate(calc(var(--mouse-x) * 1.2), calc(var(--mouse-y) * 1.2))' }} />

      <div className="mp-container" style={{ position: 'relative', zIndex: 2 }}>
        
        <div style={{ position: 'absolute', top: '-20%', left: '-10%', width: '600px', height: '600px', background: 'radial-gradient(circle, rgba(41, 98, 255, 0.12), transparent 60%)', filter: 'blur(80px)', pointerEvents: 'none', transform: 'translate(calc(var(--mouse-x) * 0.3), calc(var(--mouse-y) * 0.3))' }} />

        <div style={{ maxWidth: '950px', position: 'relative', zIndex: 10 }}>
          <div className="mp-badge mp-reveal mp-active" style={{ marginBottom: '32px' }}>
            <span className="mp-badge-dot"></span>
            <ScrambleText text={landingCopy.heroBadge} delay={500} />
          </div>
          
          <h1 className="mp-h1 mp-reveal mp-delay-100 mp-active" style={{ textWrap: 'balance' }}>
            {landingCopy.heroTitleLead} <span className="mp-glow-text mp-shimmer" style={{ whiteSpace: 'nowrap' }}>{landingCopy.heroTitleHighlight}</span><br />
            Trade with <span style={{ color: '#00c896', textShadow: '0 0 30px rgba(0,200,150,0.4)' }}>Firm-Backed</span> Capital.
          </h1>
          
          <p className="mp-p-lead mp-reveal mp-delay-200 mp-active" style={{ textWrap: 'balance' }}>
            {landingCopy.heroSubtitle}
          </p>
          
          <div className="mp-reveal mp-delay-300 mp-active" style={{ display: 'flex', gap: '24px', flexWrap: 'wrap', alignItems: 'center' }}>
            <button 
              ref={magneticBtnRef}
              className="mp-btn-primary" 
              onClick={() => {
                // Save pending challenge intent in memory so
                // Login.js / Register.js can auto-create the account after authentication.
                // Default size 10000; overridden by the pricing section if a size was selected.
                const selectedSize = parseInt(getMemoryItem('heroSelectedSize') || '10000')
                setMemoryItem('pendingChallenge', JSON.stringify({
                  accountSize: selectedSize,
                  accountType: 'phase1'
                }))
                if (onPrimaryCta) onPrimaryCta();
                navigate('/login');
              }}
              style={{ padding: '22px 54px', fontSize: '18px', transition: 'transform 0.1s ease-out' }}
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
                <span style={{ color: '#f0b90b', fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 700 }}>{landingCopy.heroStatsLead}</span>
              <span className="mp-stat-number">&nbsp;{landingCopy.heroStatsLeadSuffix}</span>
            </div>
            <div className="mp-stat-divider" />
            <div className="mp-stat-item">
              <span className="mp-badge-dot" style={{ display: 'inline-block', marginRight: '8px' }}></span>
              <span className="mp-stat-number">
                <AnimatedCounter value="2400" suffix="" /> Funded Traders
              </span>
            </div>
            <div className="mp-stat-divider" />
            <div className="mp-stat-item">
              <span className="mp-stat-number" style={{ color: '#f0b90b' }}>Weekly</span>
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
