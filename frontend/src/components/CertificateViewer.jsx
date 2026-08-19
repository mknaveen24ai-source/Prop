import React, { useState } from 'react'
import { Download, FileText, Copy, Share2, Check, ExternalLink } from 'lucide-react'

import Drawer from './ui/Drawer'
import BottomSheet from './ui/BottomSheet'
import Button from './ui/Button'
import { useIsMobile } from '../hooks/useBreakpoint'
import { certificatesAPI } from '../services/api'
import {
  twitterShareUrl, linkedInShareUrl, shareTextFor, copyToClipboard,
  shareImageNatively, canShareFiles, triggerDownload, verifyUrlFor
} from '../utils/certificateShare'

/**
 * Interactive certificate viewer.
 *
 * Renders the server's PNG rather than the SVG endpoint. An <img src="*.svg">
 * is an isolated document with no access to the page's webfonts and no network
 * fetch of its own, so the SVG would render in a fallback face and look nothing
 * like the download. The PNG is the same artefact the trader saves, the email
 * attaches and the public page shows — one output, no drift.
 *
 * Drawer on desktop, BottomSheet on mobile: there is no trader-side Modal in
 * components/ui, by design.
 */
export default function CertificateViewer({ certificate, open, onClose }) {
  const isMobile = useIsMobile()
  const [copied, setCopied] = useState('')
  const [shareNote, setShareNote] = useState('')
  const [zoomed, setZoomed] = useState(false)

  if (!certificate) return null

  const isRevoked = certificate.status === 'revoked'

  async function handleCopy(kind, text) {
    const ok = await copyToClipboard(text)
    setCopied(ok ? kind : '')
    setShareNote(ok ? '' : 'Could not copy automatically — please copy the link manually.')
    if (ok) setTimeout(() => setCopied(''), 2000)
  }

  async function handleInstagram() {
    setShareNote('')
    const result = await shareImageNatively(certificate, certificatesAPI.imageUrl(certificate.public_id, 1400))
    if (result.shared || result.reason === 'cancelled') return

    // No web intent exists for Instagram Stories, so the honest desktop path is
    // to hand over the image and the caption.
    triggerDownload(certificatesAPI.downloadPngUrl(certificate.public_id), `certificate-${certificate.public_id}.png`)
    const ok = await copyToClipboard(shareTextFor(certificate))
    setShareNote(ok
      ? 'Image downloaded and caption copied — add them to your story from the Instagram app.'
      : 'Image downloaded — add it to your story from the Instagram app.')
  }

  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <button
        type="button"
        onClick={() => setZoomed((z) => !z)}
        aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
        style={{
          background: 'none', border: `1px solid var(--rule)`, padding: 0,
          cursor: 'zoom-in', lineHeight: 0, overflow: zoomed ? 'auto' : 'hidden',
          maxHeight: zoomed ? '60vh' : 'none'
        }}
      >
        <img
          src={certificatesAPI.imageUrl(certificate.public_id, 1400)}
          alt={`${certificate.title} awarded to ${certificate.recipient_name}`}
          style={{
            display: 'block',
            width: zoomed ? '180%' : '100%',
            height: 'auto',
            opacity: isRevoked ? 0.85 : 1
          }}
        />
      </button>

      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 16px', margin: 0 }}>
        <Meta label="Issued" value={new Date(certificate.issued_at).toLocaleDateString('en-GB', {
          day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
        })} />
        <Meta label="ID" value={certificate.public_id} mono />
        <Meta label="Status" value={isRevoked ? `Revoked — ${certificate.revoked_reason || 'no reason given'}` : 'Active'} />
      </dl>

      <div>
        <SectionLabel>Download</SectionLabel>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <Button
            variant="primary"
            onClick={() => triggerDownload(certificatesAPI.downloadPngUrl(certificate.public_id), `certificate-${certificate.public_id}.png`)}
          >
            <Download size={14} /> High-res PNG
          </Button>
          <Button
            variant="secondary"
            onClick={() => triggerDownload(certificatesAPI.downloadPdfUrl(certificate.public_id), `certificate-${certificate.public_id}.pdf`)}
          >
            <FileText size={14} /> PDF
          </Button>
        </div>
      </div>

      {!isRevoked && (
        <div>
          <SectionLabel>Share</SectionLabel>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Button as="a" variant="secondary" href={twitterShareUrl(certificate)} target="_blank" rel="noopener noreferrer">
              <Share2 size={14} /> X
            </Button>
            <Button as="a" variant="secondary" href={linkedInShareUrl(certificate)} target="_blank" rel="noopener noreferrer">
              <Share2 size={14} /> LinkedIn
            </Button>
            <Button variant="secondary" onClick={() => handleCopy('discord', shareTextFor(certificate))}>
              {copied === 'discord' ? <Check size={14} /> : <Copy size={14} />}
              {copied === 'discord' ? 'Copied for Discord' : 'Copy for Discord'}
            </Button>
            <Button variant="secondary" onClick={handleInstagram}>
              <Share2 size={14} /> {canShareFiles() ? 'Instagram story' : 'Save for Instagram'}
            </Button>
          </div>

          {/* Say plainly what these buttons do — Discord and Instagram have no
              web share intent, and pretending otherwise reads as a bug. */}
          <p style={{ fontSize: 11, color: 'var(--muted)', marginTop: 'var(--space-2)', lineHeight: 1.5 }}>
            X and LinkedIn open a pre-filled post. Discord copies the caption and link to paste into a server.
            Instagram stories cannot be posted from a browser — on a phone this opens the share sheet, otherwise it
            saves the image and copies the caption.
          </p>
          {shareNote && (
            <p role="status" style={{ fontSize: 12, color: 'var(--warn)', marginTop: 'var(--space-2)' }}>{shareNote}</p>
          )}

          <div style={{ marginTop: 'var(--space-4)' }}>
            <SectionLabel>Verification link</SectionLabel>
            <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{
                fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--muted)',
                border: '1px solid var(--rule-soft)', padding: '6px 8px', wordBreak: 'break-all', flex: '1 1 220px'
              }}>
                {verifyUrlFor(certificate)}
              </code>
              <Button variant="ghost" onClick={() => handleCopy('link', verifyUrlFor(certificate))}>
                {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
              </Button>
              <Button as="a" variant="ghost" href={verifyUrlFor(certificate)} target="_blank" rel="noopener noreferrer" aria-label="Open verification page">
                <ExternalLink size={14} />
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  const shell = isMobile ? BottomSheet : Drawer
  return React.createElement(shell, {
    open,
    onClose,
    title: certificate.title,
    subtitle: certificate.recipient_name
  }, body)
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em',
      textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 'var(--space-2)'
    }}>
      {children}
    </div>
  )
}

function Meta({ label, value, mono }) {
  return (
    <>
      <dt style={{
        fontFamily: 'var(--font-mono)', fontSize: 9.5, letterSpacing: '.12em',
        textTransform: 'uppercase', color: 'var(--muted)', alignSelf: 'center'
      }}>
        {label}
      </dt>
      <dd style={{
        margin: 0, fontSize: 13, color: 'var(--ink)',
        fontFamily: mono ? 'var(--font-mono)' : 'inherit'
      }}>
        {value}
      </dd>
    </>
  )
}
