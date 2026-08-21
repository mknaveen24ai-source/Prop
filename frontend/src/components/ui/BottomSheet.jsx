import React, { useRef } from 'react'
import useFocusTrap from '../../hooks/useFocusTrap'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import useBodyScrollLock from '../../hooks/useBodyScrollLock'

/**
 * Mobile bottom sheet — the touch counterpart to ui/Drawer.jsx (which slides in
 * from the right and suits a wide viewport). Extracted from the hand-rolled
 * "More" sheet that lived inline in Sidebar.jsx so the trading order ticket can
 * reuse the same behaviour instead of growing a third copy.
 *
 * Carries the focus trap + Escape handling Drawer.jsx already implements, plus
 * body scroll lock, which neither previous implementation had — without it the
 * page scrolls behind an open sheet on touch.
 *
 * Props
 *  open      — visibility
 *  onClose   — called on Escape, scrim tap, and close button
 *  title     — sheet heading; also the accessible name
 *  maxHeight — CSS length, default 72vh (dvh where supported)
 *  padded    — apply body padding; pass false for edge-to-edge lists
 */
export default function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  maxHeight = 'min(72dvh, 72vh)',
  padded = true,
  children,
}) {
  const closeBtnRef = useRef(null)
  const panelRef = useFocusTrap(open, onClose, { initialFocusRef: closeBtnRef })

  useBodyScrollLock(open)

  return (
    <AnimatePresence>
      {open && (
        <div className="lx-sheet-root">
          <motion.div
            className="lx-sheet-scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            className="lx-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={title || 'Options'}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ maxHeight }}
          >
            {/* Grab affordance — signals the sheet is dismissable. */}
            <div className="lx-sheet__grip" aria-hidden="true" />

            <div className="lx-sheet__head">
              <div>
                {title && <div className="lx-sheet__title">{title}</div>}
                {subtitle && <div className="lx-sheet__subtitle">{subtitle}</div>}
              </div>
              <button
                type="button"
                ref={closeBtnRef}
                onClick={onClose}
                aria-label="Close"
                className="lx-sheet__close"
              >
                <X size={18} />
              </button>
            </div>

            <div className={padded ? 'lx-sheet__body lx-sheet__body--padded' : 'lx-sheet__body'}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}
