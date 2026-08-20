import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Download, ArrowRight } from 'lucide-react'

import Button from './ui/Button'
import { certificatesAPI } from '../services/api'
import { triggerDownload } from '../utils/certificateShare'

/**
 * The moment a certificate is earned.
 *
 * Fires off the `certificate_awarded` socket event. A toast alone under-delivers
 * this — passing an evaluation or being paid out is the emotional peak of the
 * whole product, and it deserves more than eight seconds in the corner.
 *
 * Confetti is skipped entirely under prefers-reduced-motion rather than merely
 * slowed: the effect is decorative, and a screenful of moving particles is
 * exactly what that preference exists to suppress.
 */

const CONFETTI_COUNT = 60
// Confetti reads from the theme rather than a fixed gold ramp. The literals it
// replaced (#E8B400, #F5C518, #EDE9E0, #8C7A2E) were the DARK palette's values,
// so in light mode the celebration threw pale-parchment confetti onto a
// pale-parchment page and two of the four colours were effectively invisible.
const GOLD = ['var(--warn)', 'var(--accent)', 'var(--ink)', 'var(--muted)']

/**
 * Confetti geometry is generated once at module load, not per render.
 *
 * Math.random() during render is impure — React may render twice and produce
 * two different layouts — and the effect needs no true randomness, only
 * scatter. Computing it here makes the render pure and costs one pass at import.
 */
const CONFETTI = Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
  id: i,
  left: (i * 37.5) % 100,
  delay: ((i * 13) % 60) / 100,
  duration: 2.4 + ((i * 7) % 18) / 10,
  size: 5 + ((i * 11) % 7),
  color: GOLD[i % GOLD.length],
  drift: (((i * 29) % 140) - 70)
}))

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const list = window.matchMedia(REDUCED_MOTION_QUERY)
  list.addEventListener('change', onChange)
  return () => list.removeEventListener('change', onChange)
}

function getReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia(REDUCED_MOTION_QUERY).matches
}

/**
 * Reads the preference through useSyncExternalStore rather than a ref written
 * during render, matching hooks/useBreakpoint.js. It also means a viewer who
 * changes the setting mid-session is respected immediately.
 */
function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeToReducedMotion, getReducedMotion, () => false)
}

export default function CertificateCelebrationModal({ certificate, open, onClose, onView }) {
  const reducedMotion = usePrefersReducedMotion()
  const closeRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    closeRef.current?.focus()
    function onKeyDown(e) { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!certificate) return null

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.24 }}
          role="dialog"
          aria-modal="true"
          aria-label={`Certificate earned: ${certificate.title}`}
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 1200,
            background: 'rgba(6, 5, 4, 0.88)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 'var(--space-5)', overflow: 'auto'
          }}
        >
          {!reducedMotion && (
            <div aria-hidden="true" style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
              {CONFETTI.map((piece) => (
                <motion.span
                  key={piece.id}
                  initial={{ y: '-12vh', x: 0, opacity: 0, rotate: 0 }}
                  animate={{ y: '112vh', x: piece.drift, opacity: [0, 1, 1, 0], rotate: 540 }}
                  transition={{ duration: piece.duration, delay: piece.delay, ease: 'linear', repeat: Infinity }}
                  style={{
                    position: 'absolute', top: 0, left: `${piece.left}%`,
                    width: piece.size, height: piece.size * 0.42,
                    background: piece.color
                  }}
                />
              ))}
            </div>
          )}

          <motion.div
            initial={{ scale: reducedMotion ? 1 : 0.92, y: reducedMotion ? 0 : 18 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: reducedMotion ? 1 : 0.96, opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'relative', width: 'min(100%, 720px)',
              background: 'var(--paper-2)', border: '1px solid var(--rule)',
              padding: 'var(--space-6)', textAlign: 'center'
            }}
          >
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{
                position: 'absolute', top: 12, right: 12, background: 'none',
                border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6
              }}
            >
              <X size={18} />
            </button>

            <div style={{
              fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.22em',
              textTransform: 'uppercase', color: 'var(--warn)', marginBottom: 'var(--space-3)'
            }}>
              Certificate Earned
            </div>

            <h2 style={{
              fontFamily: 'var(--font-display)', fontSize: 'clamp(22px, 4vw, 32px)',
              color: 'var(--ink)', margin: '0 0 var(--space-4)', lineHeight: 1.2
            }}>
              {certificate.title}
            </h2>

            <img
              src={certificatesAPI.imageUrl(certificate.public_id, 900)}
              alt={`${certificate.title} certificate`}
              style={{ display: 'block', width: '100%', height: 'auto', border: '1px solid var(--rule)' }}
            />

            <div style={{
              display: 'flex', gap: 'var(--space-2)', justifyContent: 'center',
              flexWrap: 'wrap', marginTop: 'var(--space-5)'
            }}>
              <Button variant="primary" onClick={onView}>
                View &amp; share <ArrowRight size={14} />
              </Button>
              <Button
                variant="secondary"
                onClick={() => triggerDownload(
                  certificatesAPI.downloadPngUrl(certificate.public_id),
                  `certificate-${certificate.public_id}.png`
                )}
              >
                <Download size={14} /> Download
              </Button>
            </div>

            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--muted)', marginTop: 'var(--space-4)', marginBottom: 0 }}>
              {certificate.public_id}
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
