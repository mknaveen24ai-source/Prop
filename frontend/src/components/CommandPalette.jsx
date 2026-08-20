import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Search } from 'lucide-react'

/**
 * Global fuzzy nav overlay (⌘K / Ctrl+K to open, Esc to close). Shell-agnostic
 * — the trader shell (Dashboard.jsx) and admin shell (AdminLayout.jsx) each
 * mount their own instance with a `results` list built from their own nav
 * structure. Both are real routes now (/dashboard/<view> and /admin/<page>);
 * Dashboard.jsx's setActivePage is a thin navigate() shim kept for backwards
 * compatibility with existing call sites, not local-only state anymore.
 */
export default function CommandPalette({ results, placeholder = 'Jump to a page…' }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    function onKey(e) {
      const key = (e.key || '').toLowerCase()
      if ((e.metaKey || e.ctrlKey) && key === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (key === 'escape') {
        setOpen(false)
      }
    }
    // Lets a visible header "⌘K" keycap button open the palette too, not
    // just the keyboard shortcut — dispatch this event from anywhere.
    function onExternalOpen() { setOpen(true) }
    window.addEventListener('keydown', onKey)
    window.addEventListener('gazette:open-command-palette', onExternalOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('gazette:open-command-palette', onExternalOpen)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    setQuery('')
    const id = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? results
      : results.filter((r) => r.label.toLowerCase().includes(q) || (r.group || '').toLowerCase().includes(q))
    return list.slice(0, 9)
  }, [results, query])

  function go(result) {
    setOpen(false)
    result.action()
  }

  if (!open) return null

  return (
    <div
      onClick={() => setOpen(false)}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)', display: 'flex', alignItems: 'flex-start',
        justifyContent: 'center', paddingTop: '12vh', zIndex: 2000,
      }}
    >
      <div
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '11px', padding: '14px 16px', borderBottom: '1px solid var(--rule)' }}>
          <Search size={16} color="var(--accent)" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter' && filtered[0]) go(filtered[0]) }}
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: '15px', color: 'var(--ink)' }}
          />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--muted)', border: '1px solid var(--rule)', borderRadius: '3px', padding: '2px 6px' }}>
            ESC
          </span>
        </div>
        <div style={{ maxHeight: '52vh', overflowY: 'auto', padding: '8px' }}>
          {filtered.length === 0 && (
            <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 'var(--fs-base)' }}>
              No matches
            </div>
          )}
          {filtered.map((r, i) => (
            <button
              key={`${r.group}-${r.label}-${i}`}
              onClick={() => go(r)}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', width: '100%', padding: '10px 12px',
                border: 'none', borderRadius: 'var(--radius-sm)', background: 'transparent',
                color: 'var(--ink)', textAlign: 'left', cursor: 'pointer', transition: 'background 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-dim)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ flex: 1, fontSize: '13.5px' }}>{r.label}</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.13em',
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
