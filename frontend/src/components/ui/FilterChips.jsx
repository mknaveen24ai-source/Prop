import React from 'react'

/**
 * Single-select filter-chip row (Modern Gazette handoff spec: "pill row,
 * active chip filled accent/paper, inactive transparent/muted; single-select
 * per screen"). `options` is [{ id, label }]; pass `activeId=''` for "All".
 *
 * Styling lives in ui.css (.lx-chip-row / .lx-chip) rather than inline so the
 * touch-target rule under `pointer: coarse` can reach it. `aria-pressed`
 * doubles as the active-state hook and the accessible state.
 */
export default function FilterChips({ options, activeId, onChange }) {
  return (
    <div className="lx-chip-row">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className="lx-chip"
          aria-pressed={opt.id === activeId}
          onClick={() => onChange && onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
