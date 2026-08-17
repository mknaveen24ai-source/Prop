import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBranding } from '../../BrandingContext'

/**
 * Shared shell for legal documents (refund policy, cookie policy, and any
 * future ones).
 *
 * Extracted because PrivacyPolicy.jsx and TermsOfService.jsx each hand-rolled
 * the same ~120-line nav / hero / accordion / footer block. Adding two more
 * copies would have made four.
 *
 * Accessibility notes — the hand-rolled originals had none of this:
 *   - the accordion is a real disclosure widget (aria-expanded + aria-controls)
 *   - panels are labelled by their trigger, so a screen reader announces which
 *     section it is reading
 *   - the +/- affordance is aria-hidden (decorative; state is on the button)
 *   - section content stays in the DOM when collapsed via `hidden`, so
 *     in-page search (Ctrl+F) still finds it
 */
export default function LegalPage({ eyebrow = 'LEGAL DOCUMENT', title, intro, sections, contactEmail, contactLabel }) {
  const navigate = useNavigate()
  const branding = useBranding?.() || {}
  const firmName = branding.firmName || branding.firm_name || 'PROP FIRM'
  const [openId, setOpenId] = useState(sections?.[0]?.id ?? null)

  return (
    <div style={{
      background: 'var(--navy)',
      minHeight: '100dvh',
      color: 'var(--text)',
      fontFamily: 'var(--font-ui)'
    }}>
      {/* Nav */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '20px clamp(16px, 4vw, 48px)', borderBottom: '1px solid var(--nav-border)',
        position: 'sticky', top: 0, background: 'var(--nav-bg)',
        backdropFilter: 'blur(12px)', zIndex: 100
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            fontFamily: 'var(--font-ui)', fontSize: 'clamp(16px, 4vw, 22px)', fontWeight: '700',
            color: 'var(--accent)', letterSpacing: '0.12em', cursor: 'pointer',
            background: 'transparent', border: 'none', padding: 0
          }}
        >
          {firmName}
        </button>
        <button onClick={() => navigate(-1)} className="btn" style={{
          background: 'transparent', border: '1px solid var(--navy-border)',
          color: 'var(--text-muted)', padding: '8px 20px', fontSize: '13px'
        }}>
          ← Back
        </button>
      </div>

      {/* Hero */}
      <div style={{
        textAlign: 'center', padding: 'clamp(36px, 8vw, 64px) 24px clamp(28px, 6vw, 48px)',
        borderBottom: '1px solid var(--navy-border)',
        background: 'radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--muted) 5%, transparent) 0%, transparent 60%)'
      }}>
        <div style={{
          display: 'inline-block', background: 'color-mix(in srgb, var(--muted) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--muted) 30%, transparent)', borderRadius: 'var(--radius-pill)',
          padding: '5px 14px', fontSize: '11px', color: 'var(--cyan)',
          letterSpacing: '0.1em', marginBottom: '20px'
        }}>
          {eyebrow}
        </div>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: 'clamp(26px, 6vw, 40px)', fontWeight: '700',
          marginBottom: '12px', color: 'var(--text)'
        }}>
          {title}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          Last updated: {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
      </div>

      <div style={{ maxWidth: '860px', margin: '0 auto', padding: 'clamp(28px, 6vw, 48px) clamp(16px, 4vw, 24px)' }}>
        {intro && (
          <div style={{
            background: 'color-mix(in srgb, var(--muted) 5%, transparent)',
            border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
            padding: '24px 28px', marginBottom: '40px'
          }}>
            <p style={{ color: 'var(--text)', lineHeight: '1.8', fontSize: '14px', margin: 0, whiteSpace: 'pre-line' }}>
              {intro}
            </p>
          </div>
        )}

        {sections.map((section) => {
          const isOpen = openId === section.id
          const panelId = `legal-panel-${section.id}`
          const buttonId = `legal-trigger-${section.id}`

          return (
            <div
              key={section.id}
              style={{
                background: 'var(--navy-card)',
                border: `1px solid ${isOpen ? 'color-mix(in srgb, var(--muted) 30%, transparent)' : 'var(--navy-border)'}`,
                marginBottom: '12px',
                overflow: 'hidden',
                transition: 'border-color 0.2s ease'
              }}
            >
              <h2 style={{ margin: 0 }}>
                <button
                  id={buttonId}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => setOpenId(isOpen ? null : section.id)}
                  style={{
                    width: '100%', display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', gap: '16px', padding: '20px 24px', background: 'transparent',
                    border: 'none', cursor: 'pointer', color: 'var(--text)', textAlign: 'left',
                    fontFamily: 'var(--font-ui)', fontSize: '14px', fontWeight: '600', letterSpacing: '0.05em'
                  }}
                >
                  <span>{section.title}</span>
                  <span aria-hidden="true" style={{
                    color: 'var(--cyan)', fontSize: '18px', transition: 'transform 0.2s ease',
                    transform: isOpen ? 'rotate(45deg)' : 'rotate(0deg)',
                    display: 'inline-block', flexShrink: 0
                  }}>+</span>
                </button>
              </h2>

              {/* `hidden` rather than unmounting: keeps Ctrl+F working. */}
              <div
                id={panelId}
                role="region"
                aria-labelledby={buttonId}
                hidden={!isOpen}
                style={{ padding: '0 24px 24px', borderTop: '1px solid var(--navy-border)' }}
              >
                <p style={{
                  color: 'var(--text-muted)', lineHeight: '1.9', fontSize: '14px',
                  whiteSpace: 'pre-line', margin: '20px 0 0'
                }}>
                  {section.content}
                </p>
              </div>
            </div>
          )
        })}

        {contactEmail && (
          <div style={{
            marginTop: '40px', padding: '24px', background: 'var(--navy-mid)',
            border: '1px solid var(--navy-border)', textAlign: 'center'
          }}>
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0, lineHeight: '1.7' }}>
              {contactLabel || 'Questions about this policy? Contact us at'}<br />
              <a href={`mailto:${contactEmail}`} style={{ color: 'var(--cyan)' }}>{contactEmail}</a>
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
