import React, { useState, useEffect, useMemo, useRef, useId, useCallback } from 'react'
import { Search } from 'lucide-react'
import useFocusTrap from '../hooks/useFocusTrap'

/**
 * Global fuzzy nav overlay (⌘K / Ctrl+K to open, Esc to close). Shell-agnostic
 * — the trader shell (Dashboard.jsx) and admin shell (AdminLayout.jsx) each
 * mount their own instance with a `results` list built from their own nav
 * structure. Both are real routes now (/dashboard/<view> and /admin/<page>);
 * Dashboard.jsx's setActivePage is a thin navigate() shim kept for backwards
 * compatibility with existing call sites, not local-only state anymore.
 *
 * Keyboard model: the input keeps focus the whole time and the list is driven
 * by aria-activedescendant. That is the combobox pattern, and it is the reason
 * Arrow keys move the highlight without moving focus — moving real focus into
 * the list would stop the user typing to narrow it, which is the entire point
 * of a command palette.
 */
export default function CommandPalette({ results, placeholder = 'Jump to a page…' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)
  const listId = useId()
  const optionId = (index) => `${listId}-option-${index}`

  const closePalette = useCallback(() => {
    setOpen(false)
    setQuery('')
    setHighlighted(0)
  }, [])
  const openPalette = useCallback(() => {
    setQuery('')
    setHighlighted(0)
    setOpen(true)
  }, [])

  const panelRef = useFocusTrap(open, closePalette, { initialFocusRef: inputRef })

  useEffect(() => {
    function onKey(e) {
      const key = (e.key || '').toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault()
        if (open) closePalette()
        else openPalette()
      }
      // Escape is handled by the focus trap while open, so it is not repeated
      // here — two handlers closing the same overlay is how a nested dialog
      // ends up dismissing its parent too.
    }
    // Lets a visible header "⌘K" keycap button open the palette too, not
    // just the keyboard shortcut — dispatch this event from anywhere.
    function onExternalOpen() { openPalette() }
    window.addEventListener('keydown', onKey)
    window.addEventListener('gazette:open-command-palette', onExternalOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('gazette:open-command-palette', onExternalOpen)
    }
  }, [closePalette, open, openPalette])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? results
      : results.filter((r) => r.label.toLowerCase().includes(q) || (r.group || '').toLowerCase().includes(q))
    return list.slice(0, 9)
  }, [results, query])

  // Typing narrows the list, so a highlight left at index 5 can end up past the
  // end. Clamp rather than reset to 0: the top match is what Enter should hit.
  const activeIndex = Math.min(highlighted, Math.max(filtered.length - 1, 0))

  // Keep the highlighted row in view — with nine results and a 52vh cap the
  // list scrolls, and an arrow-key highlight that scrolls off screen is
  // invisible to the sighted keyboard user it exists for.
  useEffect(() => {
    if (!open || !listRef.current) return
    const node = listRef.current.querySelector(`#${CSS.escape(optionId(activeIndex))}`)
    node?.scrollIntoView({ block: 'nearest' })
    // optionId is derived from a stable useId, so it needs no dependency entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex])

  function go(result) {
    closePalette()
    result.action()
  }

  function onInputKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => (filtered.length === 0 ? 0 : (Math.min(i, filtered.length - 1) + 1) % filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => (filtered.length === 0 ? 0 : (Math.min(i, filtered.length - 1) - 1 + filtered.length) % filtered.length))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlighted(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlighted(Math.max(filtered.length - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      // The highlighted row, not filtered[0] — arrowing down and pressing
      // Enter used to silently navigate somewhere else.
      const target = filtered[activeIndex]
      if (target) go(target)
    }
  }

  if (!open) return null

  return (
    <div
      onClick={closePalette}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', paddingTop: '12vh', zIndex: 2000,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(620px, 92vw)',
          background: 'var(--glass-2)',
          backdropFilter: 'blur(24px) saturate(160%)',
          WebkitBackdropFilter: 'blur(24px) saturate(160%)',
          border: '1px solid var(--rule)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--elev-lg)',
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-3-5) var(--space-4)', borderBottom: '1px solid var(--rule)' }}>
          <Search size={16} color="var(--accent)" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlighted(0) }}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={filtered.length > 0 ? optionId(activeIndex) : undefined}
            onKeyDown={onInputKeyDown}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 'var(--fs-control)', color: 'var(--ink)' }}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--muted)', border: '1px solid var(--rule)', borderRadius: '3px', padding: 'var(--space-1) var(--space-1-5)' }}>
            ESC
          </span>
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          style={{ maxHeight: '52vh', overflowY: 'auto', padding: 'var(--space-2)' }}
        >
          {filtered.length === 0 && (
            <div role="status" style={{ padding: 'var(--space-6)', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-base)' }}>
              No matches
            </div>
          )}
          {filtered.map((r, i) => (
            <button
              key={`${r.group}-${r.label}-${i}`}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              // -1 so Tab does not walk the list: focus stays on the input and
              // the Arrow keys drive the highlight, per the combobox pattern.
              tabIndex={-1}
              onClick={() => go(r)}
              onMouseEnter={() => setHighlighted(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 'var(--space-3)', width: '100%', padding: 'var(--space-2-5) var(--space-3)',
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: i === activeIndex ? 'var(--accent-dim)' : 'transparent',
                color: 'var(--ink)', textAlign: 'left', cursor: 'pointer', transition: 'background 0.12s',
              }}
            >
              <span style={{ flex: 1, fontSize: 'var(--fs-md)' }}>{r.label}</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', letterSpacing: '.13em',
                textTransform: 'uppercase', color: 'var(--muted)',
              }}>
                {r.group}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
