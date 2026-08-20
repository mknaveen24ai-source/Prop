import React, { useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'

/**
 * Trader-side detail drawer (Modern Gazette handoff spec: "row click opens a
 * detail drawer — slide-in panel with the record's full context — never a
 * route change"). Admin-side equivalent is components/admin/AdminEntityDrawer.jsx.
 */
export default function Drawer({ open, onClose, title, subtitle, children }) {
  const panelRef = useRef(null)
  const closeBtnRef = useRef(null)

  useEffect(() => {
    if (!open) return
    closeBtnRef.current?.focus()

    function handleKeyDown(e) {
      if (e.key === 'Escape') {
        onClose?.()
        return
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusable = panelRef.current.querySelectorAll(
          'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
        )
        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={onClose}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 1800, display: 'flex', justifyContent: 'flex-end' }}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Details'}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              width: 'min(440px, 92vw)', height: '100%', overflowY: 'auto',
              background: 'var(--glass-2)', backdropFilter: 'blur(24px) saturate(160%)', WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              borderLeft: '1px solid var(--rule)', boxShadow: 'var(--elev-lg)', padding: 'var(--space-6)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', borderBottom: '3px double var(--rule)', paddingBottom: 'var(--space-3)', marginBottom: 'var(--space-5)' }}>
              <div>
                {title && <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--ink)', margin: 0 }}>{title}</h3>}
                {subtitle && <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted)', marginTop: 'var(--space-1)' }}>{subtitle}</div>}
              </div>
              <button
                type="button"
                ref={closeBtnRef}
                onClick={onClose}
                aria-label="Close"
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 'var(--space-1)' }}
              >
                <X size={18} />
              </button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
