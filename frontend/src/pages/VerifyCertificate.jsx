import React, { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import axios from 'axios'
import { ShieldCheck, ShieldAlert, ShieldX, ArrowRight } from 'lucide-react'

import { certificatesAPI } from '../services/api'
import { useTheme } from '../ThemeContext'

/**
 * Public certificate verification — the page a QR scan lands on.
 *
 * Fully unauthenticated, and deliberately so: it is the answer to "is this
 * person actually funded?", which is the question every prop-firm screenshot
 * invites and almost none can settle. It is also the inbound-traffic payoff for
 * the whole feature, hence the CTA at the foot.
 *
 * Uses a bare axios call rather than the shared `api` client on purpose — that
 * client carries a 401 interceptor that redirects to /login, and a public page
 * must never bounce an anonymous visitor to a sign-in screen.
 */

const STATES = {
  active: {
    Icon: ShieldCheck,
    tone: 'var(--gain)',
    kicker: 'Verified',
    headline: 'This certificate is authentic',
    detail: 'Issued by us and currently valid.'
  },
  revoked: {
    Icon: ShieldX,
    tone: 'var(--loss)',
    kicker: 'Revoked',
    headline: 'This certificate has been revoked',
    detail: 'It was genuinely issued, but is no longer valid.'
  },
  tampered: {
    Icon: ShieldAlert,
    tone: 'var(--loss)',
    kicker: 'Invalid',
    headline: 'This certificate failed verification',
    detail: 'Its details do not match the signature recorded when it was issued. Treat it as untrustworthy.'
  },
  not_found: {
    Icon: ShieldAlert,
    tone: 'var(--muted)',
    kicker: 'Not found',
    headline: 'No certificate with that ID',
    detail: 'Check the code, or scan the QR on the certificate again.'
  }
}

export default function VerifyCertificate() {
  const { publicId } = useParams()
  const { theme, toggleTheme } = useTheme()
  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)

    axios.get(certificatesAPI.verifyUrl(publicId), { withCredentials: false })
      .then((res) => { if (!cancelled) setResult(res.data) })
      .catch((err) => {
        if (cancelled) return
        // A 404 is a real verification answer, not a failure to reach us.
        if (err?.response?.status === 404 && err.response.data) setResult(err.response.data)
        else setFailed(true)
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [publicId])

  const state = STATES[result?.status] || STATES.not_found
  const { Icon } = state
  const certificate = result?.certificate

  return (
    <div className="mode-public ui-shell" style={{ minHeight: '100dvh', background: 'var(--paper)' }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-4) var(--shell-gutter-x)', borderBottom: '1px solid var(--rule)'
      }}>
        <Link to="/" style={{
          fontFamily: 'var(--font-mono)', fontSize: 13, letterSpacing: '.18em',
          textTransform: 'uppercase', color: 'var(--brand-primary)', textDecoration: 'none', fontWeight: 700
        }}>
          PropFirm
        </Link>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle colour theme"
          style={{
            background: 'none', border: '1px solid var(--rule)', color: 'var(--muted)',
            fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.1em',
            textTransform: 'uppercase', padding: '6px 10px', cursor: 'pointer'
          }}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <main className="ui-shell-section ui-shell-gutter" style={{ paddingTop: 'var(--space-8)', paddingBottom: 'var(--space-8)' }}>
        {loading && <p style={{ color: 'var(--muted)', textAlign: 'center' }}>Verifying certificate…</p>}

        {!loading && failed && (
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--ink)' }}>Could not reach the verification service</h1>
            <p style={{ color: 'var(--muted)' }}>Please try again in a moment.</p>
          </div>
        )}

        {!loading && !failed && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 'var(--space-6)' }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 8,
                border: `1px solid ${state.tone}`, color: state.tone,
                fontFamily: 'var(--font-mono)', fontSize: 10.5, letterSpacing: '.18em',
                textTransform: 'uppercase', padding: '8px 14px', marginBottom: 'var(--space-4)'
              }}>
                <Icon size={15} aria-hidden="true" />
                {state.kicker}
              </div>

              <h1 style={{
                fontFamily: 'var(--font-display)', fontSize: 'clamp(24px, 5vw, 38px)',
                color: 'var(--ink)', margin: '0 0 var(--space-3)', lineHeight: 1.2
              }}>
                {state.headline}
              </h1>
              <p style={{ color: 'var(--muted)', maxWidth: 560, margin: '0 auto' }}>{state.detail}</p>

              {/* The signature check is worthless if its result is never shown. */}
              {result?.signatureValid === false && result?.status !== 'not_found' && (
                <p style={{ color: 'var(--loss)', fontSize: 13, marginTop: 'var(--space-3)' }}>
                  The stored record does not match its integrity signature.
                </p>
              )}
            </div>

            {certificate && (
              <>
                <img
                  src={certificatesAPI.publicImageUrl(certificate.public_id, 1400)}
                  alt={`${certificate.title} awarded to ${certificate.recipient_name}`}
                  style={{
                    display: 'block', width: '100%', maxWidth: 940, height: 'auto',
                    margin: '0 auto', border: '1px solid var(--rule)'
                  }}
                />

                <dl className="ui-cols" style={{
                  '--cols': 4, '--cols-gap': 'var(--space-4)',
                  maxWidth: 940, margin: 'var(--space-6) auto 0'
                }}>
                  <Detail label="Awarded to" value={certificate.recipient_name} />
                  <Detail label="Award" value={certificate.title} />
                  <Detail
                    label="Issued"
                    value={new Date(certificate.issued_at).toLocaleDateString('en-GB', {
                      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
                    })}
                    mono
                  />
                  <Detail label="Certificate ID" value={certificate.public_id} mono />
                </dl>

                {certificate.status === 'revoked' && certificate.revoked_reason && (
                  <p style={{ textAlign: 'center', color: 'var(--loss)', marginTop: 'var(--space-5)' }}>
                    Reason: {certificate.revoked_reason}
                  </p>
                )}
              </>
            )}

            <div style={{
              textAlign: 'center', marginTop: 'var(--space-8)',
              paddingTop: 'var(--space-6)', borderTop: '1px solid var(--rule)'
            }}>
              <p style={{ color: 'var(--muted)', marginBottom: 'var(--space-4)' }}>
                Every certificate we issue can be verified here. Want one of your own?
              </p>
              <Link
                to="/register"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  background: 'var(--brand-primary)', color: 'var(--on-primary)',
                  padding: 'var(--space-3) var(--space-6)', textDecoration: 'none', fontWeight: 700,
                  fontFamily: 'var(--font-mono)', fontSize: 12,
                  letterSpacing: '.12em', textTransform: 'uppercase'
                }}
              >
                Start a challenge <ArrowRight size={14} />
              </Link>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function Detail({ label, value, mono }) {
  return (
    <div style={{ borderTop: '1px solid var(--rule-soft)', paddingTop: 'var(--space-3)' }}>
      <dt style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em',
        textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6
      }}>
        {label}
      </dt>
      <dd style={{
        margin: 0, color: 'var(--ink)', fontSize: 14,
        fontFamily: mono ? 'var(--font-mono)' : 'inherit', wordBreak: 'break-word'
      }}>
        {value}
      </dd>
    </div>
  )
}
