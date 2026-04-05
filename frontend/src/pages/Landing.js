import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ThemeToggle from '../components/ThemeToggle';
import RiskWarningBanner from '../components/RiskWarningBanner';
import { trackEvent } from '../utils/analytics';

// Import Masterpiece sections
import { MASTERPIECE_CSS } from './landing-sections/LandingStyles';
import LandingHero from './landing-sections/LandingHero';
const LandingCalculator = lazy(() => import('./landing-sections/LandingCalculator'));
const LandingFeatures = lazy(() => import('./landing-sections/LandingFeatures'));
const LandingScaling = lazy(() => import('./landing-sections/LandingScaling'));
const LandingWallOfLove = lazy(() => import('./landing-sections/LandingWallOfLove'));
const LandingFAQ = lazy(() => import('./landing-sections/LandingFAQ'));
const LandingFooter = lazy(() => import('./landing-sections/LandingFooter'));

function scrollToId(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function upsertMetaTag({ name, property, content, id }) {
  const selector = id
    ? `meta#${id}`
    : name
      ? `meta[name="${name}"]`
      : `meta[property="${property}"]`;
  let tag = document.head.querySelector(selector);
  if (!tag) {
    tag = document.createElement('meta');
    if (id) tag.id = id;
    if (name) tag.setAttribute('name', name);
    if (property) tag.setAttribute('property', property);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

export default function Landing() {
  const [scrolled, setScrolled] = useState(false);
  const [showStickyCta, setShowStickyCta] = useState(false);

  useEffect(() => {
    // Inject Masterpiece CSS
    let styleSheet = document.getElementById('mp-landing-styles');
    if (!styleSheet) {
      styleSheet = document.createElement('style');
      styleSheet.id = 'mp-landing-styles';
      styleSheet.type = 'text/css';
      styleSheet.innerText = MASTERPIECE_CSS;
      document.head.appendChild(styleSheet);
    }

    // Scroll reveal + section analytics observers
    const trackedSections = new Set();
    const observedReveals = new WeakSet();
    const observedSections = new WeakSet();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('mp-active');
        }
      });
    }, { threshold: 0.1 });

    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const sectionName = entry.target.getAttribute('data-mp-section');
        if (!sectionName || trackedSections.has(sectionName)) return;
        trackedSections.add(sectionName);
        trackEvent('landing_section_view', { section: sectionName });
      });
    }, { threshold: 0.35 });

    const attachObservers = () => {
      const revealElements = document.querySelectorAll('.mp-reveal');
      const trackedSectionElements = document.querySelectorAll('[data-mp-section]');

      revealElements.forEach(el => {
        if (observedReveals.has(el)) return;
        observedReveals.add(el);
        observer.observe(el);
      });

      trackedSectionElements.forEach(el => {
        if (observedSections.has(el)) return;
        observedSections.add(el);
        sectionObserver.observe(el);
      });
    };

    attachObservers();

    const domObserver = new MutationObserver(() => {
      attachObservers();
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    // Nav bar + sticky CTA scroll effect
    const handleScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 50);
      setShowStickyCta(y > Math.max(420, window.innerHeight * 0.65));
    };
    window.addEventListener('scroll', handleScroll);
    handleScroll();

    trackEvent('landing_view', { page: 'landing' });

    // Cleanup
    return () => {
      domObserver.disconnect();
      observer.disconnect();
      sectionObserver.disconnect();
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = 'PropFirm V2 | Free Funded Trading Accounts';

    upsertMetaTag({
      name: 'description',
      content: 'Get a free funded trading account. Pass a transparent 2-phase evaluation and trade institutional capital with zero evaluation fees.',
      id: 'mp-meta-description',
    });
    upsertMetaTag({
      property: 'og:title',
      content: 'PropFirm V2 | Free Funded Trading Accounts',
      id: 'mp-meta-og-title',
    });
    upsertMetaTag({
      property: 'og:description',
      content: 'Zero evaluation fees. Transparent rules. Limited monthly slots for funded traders.',
      id: 'mp-meta-og-description',
    });
    upsertMetaTag({
      property: 'og:type',
      content: 'website',
      id: 'mp-meta-og-type',
    });

    let canonical = document.head.querySelector('#mp-canonical');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.id = 'mp-canonical';
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', `${window.location.origin}/`);

    let schemaTag = document.head.querySelector('#mp-landing-schema');
    if (!schemaTag) {
      schemaTag = document.createElement('script');
      schemaTag.id = 'mp-landing-schema';
      schemaTag.type = 'application/ld+json';
      document.head.appendChild(schemaTag);
    }
    schemaTag.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'PropFirm V2 - Free Funded Accounts',
      description: 'Free funded trading accounts with a transparent 2-phase evaluation.',
      url: `${window.location.origin}/`,
      mainEntity: {
        '@type': 'Service',
        name: 'PropFirm Funded Trading Program',
        provider: {
          '@type': 'Organization',
          name: 'PropFirm V2',
        },
      },
    });

    return () => {
      document.title = prevTitle;
    };
  }, []);

  const sectionFallback = (
    <div className="mp-container" style={{ padding: '48px 24px', textAlign: 'center', color: 'rgba(255,255,255,0.45)' }}>
      Loading section...
    </div>
  );

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
      <nav className={`nav-transparent ${scrolled ? 'scrolled' : ''}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
          <span style={{ fontFamily: 'Inter, sans-serif', fontSize: '20px', fontWeight: 800, letterSpacing: '0.08em', color: '#fff' }}>
            PROPFIRM <span style={{ color: 'var(--accent)' }}>V2</span>
          </span>
        </div>

        {/* Center Links (desktop) */}
        <div className="mp-nav-links" style={{ display: 'flex', gap: '28px', alignItems: 'center' }}>
              {[
                { label: 'Funding', href: '#mp-calculator' },
                { label: 'Features', href: '#mp-features' },
                { label: 'How It Works', href: '#mp-scaling' },
                { label: 'FAQ', href: '#faq' },
              ].map(link => (
                <a key={link.label} href={link.href} style={{
                  color: 'var(--text-secondary)', textDecoration: 'none', fontSize: '14px',
                  fontFamily: 'Inter, sans-serif', fontWeight: '500',
                  transition: 'color 0.2s',
                  position: 'relative',
                }}
                onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                onClick={() => trackEvent('landing_nav_click', { label: link.label, href: link.href })}
                >{link.label}</a>
              ))}
            </div>

            {/* Right Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <ThemeToggle />
              <Link to="/login" className="btn btn-ghost" style={{ textDecoration: 'none' }}>
                Log In
              </Link>
              <Link to="/register" className="btn btn-primary" style={{ textDecoration: 'none' }}
                onClick={() => trackEvent('landing_cta_click', { placement: 'nav', action: 'register' })}>
                Get Funded
              </Link>
            </div>
      </nav>

      <main>
      {/* Sections */}
      <div data-mp-section="hero" id="mp-hero">
        <LandingHero
          onPrimaryCta={() => trackEvent('landing_cta_click', { placement: 'hero', action: 'register' })}
          onSecondaryCta={() => trackEvent('landing_cta_click', { placement: 'hero', action: 'view_accounts' })}
        />
      </div>

      <Suspense fallback={sectionFallback}>
        <div data-mp-section="features" id="mp-features">
          <LandingFeatures />
        </div>
        <div data-mp-section="calculator" id="mp-calculator">
          <LandingCalculator
            onStartAssessment={(size) => trackEvent('landing_cta_click', { placement: 'calculator', action: 'start_assessment', size })}
          />
        </div>
        <div data-mp-section="how_it_works" id="mp-scaling">
          <LandingScaling />
        </div>
        <div data-mp-section="testimonials" id="mp-testimonials">
          <LandingWallOfLove />
        </div>
        <div data-mp-section="faq">
          <LandingFAQ />
        </div>
        <div data-mp-section="footer" id="mp-footer">
          <LandingFooter onFooterCta={() => trackEvent('landing_cta_click', { placement: 'footer', action: 'register' })} />
        </div>
      </Suspense>
      </main>

      {/* Sticky Conversion CTA */}
      {showStickyCta && (
        <div className="mp-sticky-cta">
          <div className="mp-sticky-cta-inner">
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontFamily: 'Sora, sans-serif', fontWeight: 700, fontSize: '14px', color: '#fff' }}>
                Start Your Free Evaluation Today
              </span>
              <span style={{ color: 'rgba(255,255,255,0.58)', fontSize: '12px' }}>
                Limited monthly spots. No card required.
              </span>
            </div>
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="mp-btn-secondary"
                style={{ padding: '10px 16px', fontSize: '13px' }}
                onClick={() => {
                  trackEvent('landing_cta_click', { placement: 'sticky', action: 'view_rules' });
                  scrollToId('faq');
                }}
              >
                View Rules
              </button>
              <Link
                to="/register"
                className="mp-btn-primary"
                style={{ padding: '10px 18px', fontSize: '13px', textDecoration: 'none' }}
                onClick={() => trackEvent('landing_cta_click', { placement: 'sticky', action: 'register' })}
              >
                Get Funded
              </Link>
            </div>
          </div>
        </div>
      )}

      </div>
    </>
  );
}
