import React from 'react';
import { Link } from 'react-router-dom';
import { getTenantLandingCopy } from '../../utils/tenantMarketing';

export default function LandingFooter({ onFooterCta }) {
  const landingCopy = getTenantLandingCopy();

  function linkHref(label) {
    if (label === 'Account Sizes') return '#mp-calculator';
    if (label === 'How It Works') return '#mp-scaling';
    if (label === 'Trading Rules') return '#faq';
    if (label === 'FAQ') return '#faq';
    if (label === 'Help Center') return '/login';
    if (label === 'Discord Community') return '/register';
    if (label === 'Contact Us') return '/login';
    if (label === 'Submit Ticket') return '/login';
    return '/';
  }

  return (
    <footer className="mp-section" style={{ background: 'var(--paper)', paddingTop: 'var(--space-12)', paddingBottom: 'var(--space-8)', borderTop: '1px solid var(--rule)' }}>
      <div className="mp-container">

        {/* CTA Banner */}
        <div className="mp-glass-card mp-reveal" style={{
          textAlign: 'center', padding: 'var(--space-11) var(--space-8)', marginBottom: 'var(--space-12)',
          background: 'var(--paper-2)',
          border: '1px solid var(--rule)',
          borderTop: '3px double var(--ink)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{ position: 'relative', zIndex: 1 }}>
            <h2 className="mp-h2" style={{ fontSize: 'clamp(32px, 4vw, 52px)' }}>{landingCopy.footerHeadline}</h2>
            <p className="mp-p-lead" style={{ margin: '0 auto var(--space-8)' }}>{landingCopy.footerSubtitle}</p>
            <Link to="/register" className="mp-btn-primary" style={{ padding: 'var(--space-6) var(--space-10)', fontSize: 'var(--fs-xl)', textDecoration: 'none' }} onClick={onFooterCta}>
              {landingCopy.footerButton}
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12H19M19 12L12 5M19 12L12 19" />
              </svg>
            </Link>
        <p style={{ marginTop: 'var(--space-6)', fontSize: 'var(--fs-sm)', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>Accounts released monthly · Limited availability</p>
          </div>
        </div>

        {/* Footer Grid */}
        <div className="mp-footer-grid mp-reveal mp-delay-200" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-10)', marginBottom: 'var(--space-11)' }}>

          {/* Brand */}
          <div className="mp-footer-brand" style={{ gridColumn: 'span 2' }}>
          <div style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-4xl)', fontWeight: 800, marginBottom: 'var(--space-6)', display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
              <span style={{ color: 'var(--ink)' }}>PROPFIRM </span>
              <span style={{ color: 'var(--muted)' }}>V2</span>
            </div>
            <p className="mp-p-body" style={{ color: 'var(--muted)', maxWidth: '300px', fontSize: 'var(--fs-md)' }}>
              {landingCopy.footerBrand}
            </p>
            <div style={{ marginTop: 'var(--space-7)', display: 'flex', gap: 'var(--space-3)' }}>
              {[
                { name: 'Twitter', letter: '𝕏' },
                { name: 'Discord', letter: 'D' },
                { name: 'YouTube', letter: '▶' },
                { name: 'Instagram', letter: '◉' },
              ].map(social => (
                <div key={social.name} style={{
                  width: '42px', height: '42px',
                  background: 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--fs-lg)', color: 'var(--muted)', cursor: 'pointer',
                  border: '1px solid var(--rule)',
                  transition: 'border-color 0.2s ease, color 0.2s ease',
                }}
                onMouseOver={e => {
                  e.currentTarget.style.borderColor = 'var(--ink)';
                  e.currentTarget.style.color = 'var(--ink)';
                }}
                onMouseOut={e => {
                  e.currentTarget.style.borderColor = 'var(--rule)';
                  e.currentTarget.style.color = 'var(--muted)';
                }}
                >
                  {social.letter}
                </div>
              ))}
            </div>
          </div>

          {/* Links */}
          {[
            {
              title: 'Platform',
              links: ['Account Sizes', 'How It Works', 'Trading Rules', 'FAQ']
            },
            {
              title: 'Support',
              links: ['Help Center', 'Discord Community', 'Contact Us', 'Submit Ticket']
            },
          ].map(col => (
            <div key={col.title}>
                <h4 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-md)', color: 'var(--muted)', marginBottom: 'var(--space-6)', textTransform: 'uppercase', letterSpacing: '0.15em' }}>{col.title}</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3-5)' }}>
                {col.links.map(link => (
                  <li key={link}>
                    <a href={linkHref(link)} style={{
                      color: 'var(--muted)', textDecoration: 'none', fontSize: 'var(--fs-md)',
                      transition: 'color 0.2s',
                      display: 'inline-block',
                    }}
                    onMouseOver={e => { e.currentTarget.style.color = 'var(--ink)'; }}
                    onMouseOut={e => { e.currentTarget.style.color = 'var(--muted)'; }}
                    >{link}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Legal */}
          {/* "Risk Disclosure" and "KYC Policy" used to sit here as href="/#"
              dead links. Replaced with the two policies that actually exist and
              that consumer law requires us to publish. */}
          <div>
            <h4 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-md)', color: 'var(--muted)', marginBottom: 'var(--space-6)', textTransform: 'uppercase', letterSpacing: '0.15em' }}>Legal</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-3-5)' }}>
              {[
                // The rulebook is the single most-asked-for page before purchase
                // and it used to be reachable only from inside a paid account.
                { to: '/rules', label: 'Trading Rules' },
                { to: '/terms', label: 'Terms of Service' },
                { to: '/privacy', label: 'Privacy Policy' },
                { to: '/refund-policy', label: 'Refund Policy' },
                { to: '/cookie-policy', label: 'Cookie Policy' }
              ].map(({ to, label }) => (
                <li key={to}>
                  <Link
                    to={to}
                    style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 'var(--fs-md)', transition: 'color 0.2s' }}
                    onMouseOver={e => { e.currentTarget.style.color = 'var(--ink)' }}
                    onMouseOut={e => { e.currentTarget.style.color = 'var(--muted)' }}
                    onFocus={e => { e.currentTarget.style.color = 'var(--ink)' }}
                    onBlur={e => { e.currentTarget.style.color = 'var(--muted)' }}
                  >
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mp-footer-bottom" style={{ borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-7)', display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
          <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--muted)', lineHeight: 1.8, textAlign: 'justify' }}>
            <strong style={{ color: 'var(--ink)' }}>Risk Warning:</strong> Trading Foreign Exchange (Forex) and Commodities carries a high level of risk and is not suitable for all investors. You may sustain a loss of some or all of your capital. Past performance is not indicative of future results.
            <br/><br/>
            <strong style={{ color: 'var(--ink)' }}>Simulated Trading Disclaimer:</strong> All accounts provided during the evaluation phases (1-step, 2-step, or 3-step, depending on the model chosen) are simulated demo accounts using live market quotes. Upon passing every phase, funded accounts are backed by the firm's real capital and trades may be executed on live markets. PropFirm V2 is not a broker, does not accept client deposits for trading, and does not provide financial advice. Challenge accounts are paid and limited in availability.
          </p>
          <div className="mp-footer-bottom-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--rule)', paddingTop: 'var(--space-6)', flexWrap: 'wrap', gap: 'var(--space-4)' }}>
            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--muted)' }}>© {new Date().getFullYear()} PropFirm V2. All rights reserved.</span>
            <div className="mp-footer-chip-row" style={{ display: 'flex', gap: 'var(--space-2-5)' }}>
              {['WEB PLATFORM', 'FOREX', 'GOLD', 'SILVER'].map(p => (
                <div key={p} style={{
                  fontSize: 'var(--fs-2xs)', color: 'var(--muted)',
                  border: '1px solid var(--rule)', padding: 'var(--space-1-5) var(--space-2-5)',
                fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.05em',
                }}>{p}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}
