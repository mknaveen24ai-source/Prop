import React, { lazy, Suspense, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu } from 'lucide-react';
import ThemeToggle from '../components/ThemeToggle';
import BottomSheet from '../components/ui/BottomSheet';
import { useTheme } from '../ThemeContext';
import { trackEvent } from '../utils/analytics';
import { useBranding } from '../BrandingContext';

// Import Masterpiece sections
import { MASTERPIECE_CSS } from './landing-sections/LandingStyles';
import LandingHero from './landing-sections/LandingHero';
import { API_BASE_URL as API_URL } from '../config/apiBase'
const LandingLiveStats = lazy(() => import('./landing-sections/LandingLiveStats'));
const LandingCalculator = lazy(() => import('./landing-sections/LandingCalculator'));
const LandingFeatures = lazy(() => import('./landing-sections/LandingFeatures'));
const LandingScaling = lazy(() => import('./landing-sections/LandingScaling'));
const LandingWallOfLove = lazy(() => import('./landing-sections/LandingWallOfLove'));
const LandingAffiliate = lazy(() => import('./landing-sections/LandingAffiliate'));
const LandingComparison = lazy(() => import('./landing-sections/LandingComparison'));
const LandingFAQ = lazy(() => import('./landing-sections/LandingFAQ'));
const LandingFooter = lazy(() => import('./landing-sections/LandingFooter'));

// One source for the header destinations, so the desktop row and the mobile
// menu can never drift apart. Previously the row was simply hidden below
// 1024px with nothing replacing it, which made all six unreachable on a phone.
const NAV_LINKS = [
  { label: 'Funding', href: '#mp-calculator' },
  { label: 'Features', href: '#mp-features' },
  { label: 'How It Works', href: '#mp-scaling' },
  { label: 'Refer & Earn', href: '#mp-affiliate' },
  { label: 'FAQ', href: '#faq' },
];

function scrollToId(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const nav = document.querySelector('.nav-transparent');
  const navRect = nav ? nav.getBoundingClientRect() : { top: 0, height: 72 };
  const headerOffset = (navRect.top || 0) + navRect.height;
  const top = window.pageYOffset + el.getBoundingClientRect().top - headerOffset - 28;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
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
  const { tenant } = useBranding();
  const { theme } = useTheme();
  const defaultTitle = `${tenant?.name || 'PropFirm'} | Prop Trading Challenges`;
  const defaultDescription = 'Start a prop trading challenge with transparent rules, clear progression, and white-label infrastructure.';
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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

    // Nav bar scroll effect
    const handleScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 50);
    };
    window.addEventListener('scroll', handleScroll);
    handleScroll();

    trackEvent('landing_view', { page: 'landing' });

    // Internal "Visitors" funnel stage for the admin Analytics section —
    // separate from trackEvent() above, which only forwards to GA/GTM if
    // configured. Fire-and-forget, best-effort.
    try {
      let sessionId = sessionStorage.getItem('funnel_session_id');
      if (!sessionId) {
        sessionId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
        sessionStorage.setItem('funnel_session_id', sessionId);
      }
      fetch(`${API_URL}/api/analytics/track`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'visit', session_id: sessionId }),
      }).catch(() => {});

      // Real acquisition-source capture (utm_source, else referrer host, else
      // 'direct') for the Model Optimization "Revenue per Segment" chart —
      // stashed so Register.jsx can send it along at signup.
      if (!sessionStorage.getItem('signup_source')) {
        const utmSource = new URLSearchParams(window.location.search).get('utm_source');
        let source = utmSource;
        if (!source) {
          source = document.referrer ? new URL(document.referrer).hostname : 'direct';
        }
        sessionStorage.setItem('signup_source', source.slice(0, 100));
      }
    } catch {
      // no-op — tracking must never break the landing page
    }

    // Cleanup
    return () => {
      domObserver.disconnect();
      observer.disconnect();
      sectionObserver.disconnect();
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  useEffect(() => {
    const scrollToHash = () => {
      const targetId = window.location.hash.replace('#', '').trim();
      if (!targetId) return;
      window.requestAnimationFrame(() => {
        window.setTimeout(() => scrollToId(targetId), 80);
      });
    };

    scrollToHash();
    window.addEventListener('hashchange', scrollToHash);
    return () => window.removeEventListener('hashchange', scrollToHash);
  }, []);

  useEffect(() => {
    const prevTitle = document.title;
    document.title = tenant?.brand?.hero_title || defaultTitle;

    upsertMetaTag({
      name: 'description',
      content: tenant?.brand?.hero_subtitle || defaultDescription,
      id: 'mp-meta-description',
    });
    upsertMetaTag({
      property: 'og:title',
      content: tenant?.brand?.hero_title || defaultTitle,
      id: 'mp-meta-og-title',
    });
    upsertMetaTag({
      property: 'og:description',
      content: tenant?.brand?.hero_subtitle || defaultDescription,
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
      name: tenant?.brand?.hero_title || defaultTitle,
      description: tenant?.brand?.hero_subtitle || defaultDescription,
      url: `${window.location.origin}/`,
      mainEntity: {
        '@type': 'Service',
        name: `${tenant?.name || 'PropFirm'} Funded Trading Program`,
        provider: {
          '@type': 'Organization',
          name: tenant?.name || 'PropFirm',
        },
      },
    });

    return () => {
      document.title = prevTitle;
    };
  }, [defaultDescription, defaultTitle, tenant]);

  const sectionFallback = (
    <div className="mp-container ui-surface ui-empty-state" style={{ padding: 'var(--space-9) var(--space-6)', color: 'var(--muted)' }}>
      Loading section...
    </div>
  );

  return (
    <>
      <div className="mode-public ui-shell masterpiece-landing" data-theme={theme}>

      {/* Glass Navbar */}
      <nav className={`nav-transparent ${scrolled ? 'scrolled' : ''}`}>
        <div className="mp-nav-brand" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2-5)', cursor: 'pointer' }}>
          <span style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-2xl)', fontWeight: 800, letterSpacing: '0.08em', color: 'var(--ink)' }}>
            {String(tenant?.logo_text || tenant?.brand?.short_name || tenant?.name || 'PROPFIRM').toUpperCase()}
          </span>
        </div>

        {/* Center Links (desktop). Layout lives in public.css: an inline
            `display: flex` here is exactly what forced responsive.css to hide
            this row with !important. */}
        <div className="mp-nav-links">
              {NAV_LINKS.map(link => (
                <a key={link.label} href={link.href} style={{
                  color: 'var(--text-secondary)', textDecoration: 'none', fontSize: 'var(--fs-md)',
                  fontFamily: 'var(--font-ui)', fontWeight: '500',
                  transition: 'color 0.2s',
                  position: 'relative',
                }}
                onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                onClick={(e) => {
                  trackEvent('landing_nav_click', { label: link.label, href: link.href });
                  if (link.href.startsWith('#')) {
                    e.preventDefault();
                    const targetId = link.href.slice(1);
                    window.history.replaceState(null, '', `#${targetId}`);
                    scrollToId(targetId);
                  }
                }}
                >{link.label}</a>
              ))}
              <Link
                to="/rules"
                style={{
                  color: 'var(--text-secondary)', textDecoration: 'none', fontSize: 'var(--fs-md)',
                  fontFamily: 'var(--font-ui)', fontWeight: '500',
                  transition: 'color 0.2s',
                }}
                onMouseOver={e => { e.currentTarget.style.color = 'var(--text-primary)' }}
                onMouseOut={e => { e.currentTarget.style.color = 'var(--text-secondary)' }}
                onClick={() => trackEvent('landing_nav_click', { label: 'Rules', href: '/rules' })}
              >Rules</Link>
              <Link
                to="/transparency"
                style={{
                  color: 'var(--text-secondary)', textDecoration: 'none', fontSize: 'var(--fs-md)',
                  fontFamily: 'var(--font-ui)', fontWeight: '500',
                  transition: 'color 0.2s',
                }}
                onMouseOver={e => e.currentTarget.style.color = 'var(--text-primary)'}
                onMouseOut={e => e.currentTarget.style.color = 'var(--text-secondary)'}
                onClick={() => trackEvent('landing_nav_click', { label: 'Transparency', href: '/transparency' })}
              >
                Transparency
              </Link>
            </div>

            {/* Right Actions */}
            <div className="mp-nav-actions" style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <ThemeToggle />
              <Link to={'/login'} className="btn btn-ghost mp-nav-login" style={{ textDecoration: 'none' }}>
                Log In
              </Link>
              <Link to={'/register'} className="btn btn-primary mp-nav-primary" style={{ textDecoration: 'none' }}
                onClick={() => trackEvent('landing_cta_click', { placement: 'nav', action: 'register' })}>
                Get Funded
              </Link>
              {/* Mobile only — the counterpart to hiding .mp-nav-links. */}
              <button
                type="button"
                className="mp-nav-burger"
                aria-label="Open menu"
                aria-haspopup="dialog"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen(true)}
              >
                <Menu size={20} />
              </button>
            </div>
      </nav>

      <BottomSheet open={menuOpen} onClose={() => setMenuOpen(false)} title="Menu" padded={false}>
        <nav className="mp-menu">
          {NAV_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="mp-menu__link"
              onClick={(e) => {
                trackEvent('landing_nav_click', { label: link.label, href: link.href });
                setMenuOpen(false);
                if (link.href.startsWith('#')) {
                  e.preventDefault();
                  const targetId = link.href.slice(1);
                  window.history.replaceState(null, '', `#${targetId}`);
                  // Let the sheet finish closing before measuring scroll offsets.
                  window.setTimeout(() => scrollToId(targetId), 240);
                }
              }}
            >
              {link.label}
            </a>
          ))}
          <Link
            to="/transparency"
            className="mp-menu__link"
            onClick={() => {
              trackEvent('landing_nav_click', { label: 'Transparency', href: '/transparency' });
              setMenuOpen(false);
            }}
          >
            Transparency
          </Link>
          <div className="mp-menu__actions">
            <Link to="/login" className="btn btn-ghost" onClick={() => setMenuOpen(false)}>
              Log In
            </Link>
            <Link
              to="/register"
              className="btn btn-primary"
              onClick={() => {
                trackEvent('landing_cta_click', { placement: 'mobile_menu', action: 'register' });
                setMenuOpen(false);
              }}
            >
              Get Funded
            </Link>
          </div>
        </nav>
      </BottomSheet>

      <div>
      {/* Sections */}
      <div data-mp-section="hero" id="mp-hero">
        <LandingHero
          onPrimaryCta={() => trackEvent('landing_cta_click', { placement: 'hero', action: 'view_accounts_primary' })}
          onSecondaryCta={() => trackEvent('landing_cta_click', { placement: 'hero', action: 'view_accounts' })}
        />
      </div>

      <Suspense fallback={sectionFallback}>
        <div data-mp-section="live_payouts" id="mp-live-payouts">
          <LandingLiveStats />
        </div>
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
        <div data-mp-section="affiliate" id="mp-affiliate">
          <LandingAffiliate />
        </div>
        <div data-mp-section="comparison" id="mp-comparison">
          <LandingComparison />
        </div>
        <div data-mp-section="faq">
          <LandingFAQ />
        </div>
        <div data-mp-section="footer" id="mp-footer">
          <LandingFooter onFooterCta={() => trackEvent('landing_cta_click', { placement: 'footer', action: 'register' })} />
        </div>
      </Suspense>
      </div>

      </div>
    </>
  );
}
