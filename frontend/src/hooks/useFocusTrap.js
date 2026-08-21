import { useEffect, useRef } from 'react'

/**
 * Keyboard containment for a modal surface: Escape closes, Tab cycles inside,
 * focus lands somewhere sensible on open and returns where it came from on
 * close.
 *
 * ── Why this is a hook ───────────────────────────────────────────────────────
 *
 * `components/ui/Drawer.jsx` already had a correct trap, hand-written. Nothing
 * else did: `AdminModal` (11 call sites) had no Escape, no trap and no dialog
 * role at all, and `BottomSheet` and `CertificateCelebrationModal` had Escape
 * only. This is Drawer's implementation, lifted verbatim, plus the two things
 * it was missing.
 *
 * ── Focus restore ────────────────────────────────────────────────────────────
 *
 * The part most hand-rolled traps omit. Without it, closing a dialog drops
 * focus back to <body>, so the next Tab starts from the top of the document and
 * a keyboard user loses their place in a long admin table every time they open
 * and dismiss a row. The element that had focus when the dialog opened is
 * captured and re-focused on close.
 *
 * ── Why not `inert` ──────────────────────────────────────────────────────────
 *
 * `inert` on everything outside the dialog is the modern answer and is cleaner,
 * but it requires a single known wrapper for "the rest of the app". Overlays
 * here are rendered inline at ~12 different depths rather than through a
 * portal, so there is no such element to mark. Cycling Tab within the panel
 * achieves the same containment without restructuring where dialogs mount.
 *
 * @param {boolean} open Whether the dialog is currently shown.
 * @param {() => void} onClose Called on Escape.
 * @param {object} [options]
 * @param {React.RefObject<HTMLElement>} [options.initialFocusRef] Element to
 *   focus on open. Defaults to the first focusable node in the panel.
 * @param {boolean} [options.restoreFocus=true] Return focus on close.
 * @returns {React.RefObject<HTMLElement>} Attach to the dialog panel.
 */
export default function useFocusTrap(open, onClose, options = {}) {
  const { initialFocusRef, restoreFocus = true } = options
  const panelRef = useRef(null)
  const previouslyFocusedRef = useRef(null)

  // Keep the latest onClose without making it a dependency: callers almost
  // always pass an inline arrow, which would otherwise tear down and rebuild
  // the listener on every render.
  //
  // Assigned in an effect, not during render. A ref written in the render body
  // is a mutation React does not know about, and under StrictMode's double
  // render or a discarded concurrent render it would publish a callback from a
  // render that never committed. The keydown listener can only fire after
  // paint, so the effect has always run by the time it reads this.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return undefined

    previouslyFocusedRef.current = document.activeElement

    const FOCUSABLE = [
      'a[href]',
      'button:not([disabled])',
      'textarea:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(', ')

    // A hidden node is not focusable, and leaving one in the list puts a dead
    // stop in the Tab cycle.
    //
    // Computed style rather than `offsetParent !== null`, which is the usual
    // shorthand and is wrong here: offsetParent is also null for any
    // `position: fixed` element, and these dialogs are full of them. It would
    // have silently emptied the list for a fixed-position panel and let Tab
    // walk straight out of the dialog.
    function isVisible(node) {
      if (node.hidden || node.closest('[hidden]')) return false
      const style = window.getComputedStyle(node)
      return style.display !== 'none' && style.visibility !== 'hidden'
    }

    function focusableNodes() {
      if (!panelRef.current) return []
      return Array.from(panelRef.current.querySelectorAll(FOCUSABLE)).filter(isVisible)
    }

    // Defer one frame: on the render that opens the dialog the panel's children
    // may not be in the DOM yet, and framer-motion mounts some of them behind
    // an enter transition.
    const raf = requestAnimationFrame(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus()
        return
      }
      const nodes = focusableNodes()
      if (nodes.length > 0) nodes[0].focus()
      else panelRef.current?.focus()
    })

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab' || !panelRef.current) return

      const nodes = focusableNodes()
      if (nodes.length === 0) {
        // Nothing to move to, so Tab must not escape the dialog.
        event.preventDefault()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]

      // Focus can sit outside the panel if the dialog opened without any
      // focusable child and the fallback panel focus was lost. Pull it back.
      if (!panelRef.current.contains(document.activeElement)) {
        event.preventDefault()
        first.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('keydown', handleKeyDown)
      if (restoreFocus) {
        const previous = previouslyFocusedRef.current
        // Guard isConnected: the trigger is often inside a list that re-rendered
        // while the dialog was open, so the captured node can be detached.
        // <body> is skipped too — focusing it is indistinguishable from not
        // restoring at all, and it would clobber focus the caller had moved.
        if (
          previous
          && previous !== document.body
          && previous.isConnected
          && typeof previous.focus === 'function'
        ) {
          previous.focus()
        }
      }
    }
  }, [open, initialFocusRef, restoreFocus])

  return panelRef
}
