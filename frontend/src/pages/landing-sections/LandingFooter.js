import React from 'react';
import { Link } from 'react-router-dom';

export default function LandingFooter() {
  return (
    <footer className="mp-section" style={{ background: '#060a12', paddingTop: '100px', paddingBottom: '40px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
      <div className="mp-container">
        
        {/* Premium CTA Banner */}
        <div className="mp-glass-card mp-reveal" style={{
          textAlign: 'center', padding: '80px 40px', marginBottom: '100px',
          background: 'radial-gradient(ellipse at top, rgba(41,98,255,0.08), rgba(123,97,255,0.03), transparent)',
          border: '1px solid rgba(41,98,255,0.15)',
          position: 'relative',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute', top: '-50%', left: '-50%', width: '200%', height: '200%',
            background: 'conic-gradient(from 0deg, transparent, rgba(41,98,255,0.05), transparent, rgba(240,185,11,0.03), transparent)',
            animation: 'mp-rotate-slow 20s linear infinite',
            pointerEvents: 'none',
          }} />
          
          <div style={{ position: 'relative', zIndex: 1 }}>
            <h2 className="mp-h2" style={{ fontSize: 'clamp(32px, 4vw, 52px)' }}>Claim Your Free Account</h2>
            <p className="mp-p-lead" style={{ margin: '0 auto 40px' }}>Limited monthly spots backed by real liquidity. No fees, no credit card, no catch.</p>
            <Link to="/register" className="mp-btn-primary" style={{ padding: '22px 56px', fontSize: '17px', textDecoration: 'none' }}>
              Get Started — It's Free
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12H19M19 12L12 5M19 12L12 19" />
              </svg>
            </Link>
            <p style={{ marginTop: '24px', fontSize: '12px', color: 'rgba(255,255,255,0.3)', fontFamily: 'DM Mono, monospace' }}>Accounts released monthly · Limited availability</p>
          </div>
        </div>

        {/* Footer Grid */}
        <div className="mp-reveal mp-delay-200" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '60px', marginBottom: '80px' }}>
          
          {/* Brand */}
          <div style={{ gridColumn: 'span 2' }}>
            <div style={{ fontFamily: 'Sora, sans-serif', fontSize: '24px', fontWeight: 800, marginBottom: '24px', display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div className="mp-badge-dot"></div>
              <span style={{ color: '#fff' }}>PROPFIRM </span>
              <span style={{ color: '#2962ff' }}>V2</span>
            </div>
            <p className="mp-p-body" style={{ color: 'rgba(255,255,255,0.4)', maxWidth: '300px', fontSize: '14px' }}>
              Free funded trading accounts backed by real liquidity. Pass our 2-phase evaluation and trade with real capital — no fees required.
            </p>
            <div style={{ marginTop: '30px', display: 'flex', gap: '12px' }}>
              {[
                { name: 'Twitter', letter: '𝕏' },
                { name: 'Discord', letter: 'D' },
                { name: 'YouTube', letter: '▶' },
                { name: 'Instagram', letter: '◉' },
              ].map(social => (
                <div key={social.name} style={{
                  width: '42px', height: '42px', borderRadius: '12px',
                  background: 'rgba(255,255,255,0.03)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '16px', color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                  border: '1px solid rgba(255,255,255,0.06)',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                }}
                onMouseOver={e => {
                  e.currentTarget.style.borderColor = 'rgba(41,98,255,0.3)';
                  e.currentTarget.style.background = 'rgba(41,98,255,0.08)';
                  e.currentTarget.style.color = '#2962ff';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 4px 16px rgba(41,98,255,0.15)';
                }}
                onMouseOut={e => {
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                  e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                  e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
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
              <h4 style={{ fontFamily: 'Sora, sans-serif', fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>{col.title}</h4>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {col.links.map(link => (
                  <li key={link}>
                    <a href="/#" style={{
                      color: 'rgba(255,255,255,0.35)', textDecoration: 'none', fontSize: '14px',
                      transition: 'color 0.2s, transform 0.2s',
                      display: 'inline-block',
                    }}
                    onMouseOver={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.transform = 'translateX(4px)'; }}
                    onMouseOut={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.35)'; e.currentTarget.style.transform = 'translateX(0)'; }}
                    >{link}</a>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {/* Legal */}
          <div>
            <h4 style={{ fontFamily: 'Sora, sans-serif', fontSize: '14px', color: 'rgba(255,255,255,0.5)', marginBottom: '24px', textTransform: 'uppercase', letterSpacing: '0.15em' }}>Legal</h4>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <li><Link to="/terms" style={{ color: 'rgba(255,255,255,0.35)', textDecoration: 'none', fontSize: '14px', transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='rgba(255,255,255,0.35)'}>Terms of Service</Link></li>
              <li><Link to="/privacy" style={{ color: 'rgba(255,255,255,0.35)', textDecoration: 'none', fontSize: '14px', transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='rgba(255,255,255,0.35)'}>Privacy Policy</Link></li>
              <li><a href="/#" style={{ color: 'rgba(255,255,255,0.35)', textDecoration: 'none', fontSize: '14px', transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='rgba(255,255,255,0.35)'}>Risk Disclosure</a></li>
              <li><a href="/#" style={{ color: 'rgba(255,255,255,0.35)', textDecoration: 'none', fontSize: '14px', transition: 'color 0.2s' }} onMouseOver={e => e.currentTarget.style.color='#fff'} onMouseOut={e => e.currentTarget.style.color='rgba(255,255,255,0.35)'}>KYC Policy</a></li>
            </ul>
          </div>
        </div>

        {/* Bottom Bar */}
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '32px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
          <p style={{ fontSize: '11px', color: 'rgba(255,255,255,0.25)', lineHeight: 1.8, textAlign: 'justify' }}>
            <strong style={{ color: 'rgba(255,255,255,0.4)' }}>Risk Warning:</strong> Trading Foreign Exchange (Forex) and Commodities carries a high level of risk and is not suitable for all investors. You may sustain a loss of some or all of your capital. Past performance is not indicative of future results.
            <br/><br/>
            <strong style={{ color: 'rgba(255,255,255,0.4)' }}>Simulated Trading Disclaimer:</strong> All accounts provided during the Phase 1 and Phase 2 evaluations are simulated demo accounts using live market quotes. Upon passing the evaluation, funded accounts are backed by the firm's real capital and trades may be executed on live markets. PropFirm V2 is not a broker, does not accept client deposits for trading, and does not provide financial advice. Accounts are provided free of charge and are limited in availability.
          </p>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid rgba(255,255,255,0.04)', paddingTop: '24px', flexWrap: 'wrap', gap: '16px' }}>
            <span style={{ fontSize: '12px', color: 'rgba(255,255,255,0.3)' }}>© {new Date().getFullYear()} PropFirm V2. All rights reserved.</span>
            <div style={{ display: 'flex', gap: '10px' }}>
              {['WEB PLATFORM', 'FOREX', 'GOLD', 'SILVER'].map(p => (
                <div key={p} style={{
                  fontSize: '10px', color: 'rgba(255,255,255,0.2)',
                  border: '1px solid rgba(255,255,255,0.06)', padding: '5px 10px',
                  borderRadius: '6px', fontFamily: 'DM Mono, monospace',
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
