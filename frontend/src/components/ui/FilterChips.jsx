import React from 'react'

/**
 * Single-select filter-chip row (Modern Gazette handoff spec: "pill row,
 * active chip filled accent/paper, inactive transparent/muted; single-select
 * per screen"). `options` is [{ id, label }]; pass `activeId=''` for "All".
 */
export default function FilterChips({ options, activeId, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-5)' }}>
      {options.map((opt) => {
        const active = opt.id === activeId
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange && onChange(opt.id)}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11px',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '6px 12px',
              borderRadius: 'var(--radius-pill)',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--rule)'}`,
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? 'var(--paper)' : 'var(--muted)',
              cursor: 'pointer',
              transition: 'background-color 0.16s ease, border-color 0.16s ease, color 0.16s ease',
            }}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
