import React, { useCallback, useEffect, useState } from 'react'
import { certificatesAPI } from '../services/api'
import Card from '../components/ui/Card'
import Button from '../components/ui/Button'
import CertificateViewer from '../components/CertificateViewer'
import { renderIcon } from '../utils/iconMap'

/**
 * DashboardCertificatesPage — the trader's earned awards.
 *
 * Certificates are minted automatically when a phase promotion is approved and
 * when a payout is paid (backend/services/certificateService.js), so this page
 * only reads. There is no "generate" action by design: a certificate the trader
 * could mint themselves would be worth nothing to show anyone.
 *
 * Card thumbnails request a narrow render (?w=520) rather than scaling the full
 * download; a grid of 3200px PNGs would be tens of megabytes.
 */

const KIND_META = {
  funded: { label: 'Funded Trader', icon: 'leaderboard', tone: 'var(--warn)' },
  phase_passed: { label: 'Challenge Passed', icon: 'target', tone: 'var(--gain)' },
  payout: { label: 'Profit Payout', icon: 'payouts', tone: 'var(--accent)' },
  custom: { label: 'Award', icon: 'leaderboard', tone: 'var(--accent)' }
}

export default function DashboardCertificatesPage() {
  const [certificates, setCertificates] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState(null)

  const load = useCallback(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    certificatesAPI.getMine()
      .then((res) => { if (!cancelled) setCertificates(Array.isArray(res.data) ? res.data : []) })
      .catch((err) => {
        if (cancelled) return
        // Distinguish a real failure from "you have none yet" — showing an empty
        // state on a network error is the bug this page's KYC sibling had.
        setError(err?.response?.data?.error || 'Could not load your certificates.')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => load(), [load])

  if (loading) {
    return (
      <Card style={{ textAlign: 'center', padding: 48 }}>
        <p style={{ color: 'var(--muted)', margin: 0 }}>Loading your certificates…</p>
      </Card>
    )
  }

  if (error) {
    return (
      <Card style={{ padding: 32 }}>
        <h3 style={{ color: 'var(--loss)', marginTop: 0 }}>Could not load certificates</h3>
        <p style={{ color: 'var(--muted)' }}>{error}</p>
        <Button variant="secondary" onClick={load}>Retry</Button>
      </Card>
    )
  }

  if (certificates.length === 0) {
    return (
      <Card style={{ textAlign: 'center', padding: 48, maxWidth: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          {renderIcon('leaderboard', { size: 48, color: 'var(--accent)' })}
        </div>
        <h3 style={{ color: 'var(--accent)', marginBottom: 12 }}>No certificates yet</h3>
        <p style={{ color: 'var(--muted)', margin: 0 }}>
          Pass a challenge phase, reach funded status, or receive a profit payout, and your official
          certificate will appear here automatically — ready to download and share.
        </p>
      </Card>
    )
  }

  return (
    <>
      <div className="ui-cols" style={{ '--cols': 3, '--cols-gap': 'var(--space-4)' }}>
        {certificates.map((certificate) => {
          const meta = KIND_META[certificate.kind] || KIND_META.custom
          const isRevoked = certificate.status === 'revoked'
          return (
            <Card
              key={certificate.public_id}
              interactive
              flush
              onClick={() => setSelected(certificate)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(certificate) }
              }}
              aria-label={`View ${certificate.title} certificate`}
              style={{ cursor: 'pointer', overflow: 'hidden' }}
            >
              <img
                src={certificatesAPI.imageUrl(certificate.public_id, 520)}
                alt=""
                loading="lazy"
                style={{ display: 'block', width: '100%', height: 'auto', opacity: isRevoked ? 0.5 : 1 }}
              />
              <div style={{ padding: 'var(--space-4)', borderTop: '1px solid var(--rule-soft)' }}>
                <div style={{
                  fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em',
                  textTransform: 'uppercase', color: isRevoked ? 'var(--loss)' : meta.tone, marginBottom: 6
                }}>
                  {isRevoked ? 'Revoked' : meta.label}
                </div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, color: 'var(--ink)', lineHeight: 1.25 }}>
                  {certificate.title}
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                  {new Date(certificate.issued_at).toLocaleDateString('en-GB', {
                    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
                  })}
                  {' · '}
                  {certificate.public_id}
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <CertificateViewer
        certificate={selected}
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
      />
    </>
  )
}
