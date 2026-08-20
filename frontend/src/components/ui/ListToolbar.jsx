import React from 'react'
import { Search } from 'lucide-react'

/**
 * Trader-side list-pattern toolbar (Modern Gazette handoff spec: "search —
 * instant client-side filter across visible columns, filters as-you-type").
 * Admin-side equivalent is components/admin/AdminFilterBar.jsx — kept
 * separate since the trader kit is deliberately lighter (no saved views/
 * column config, just search + an actions slot).
 */
export default function ListToolbar({ searchValue, onSearchChange, placeholder = 'Search…', actions }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-4)', flexWrap: 'wrap', marginBottom: 'var(--space-4)' }}>
      <div style={{ position: 'relative', width: '280px', maxWidth: '100%' }}>
        <Search size={14} style={{ position: 'absolute', left: '11px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
        <input
          type="text"
          className="lx-field__control"
          style={{ paddingLeft: 'var(--space-7)' }}
          placeholder={placeholder}
          value={searchValue || ''}
          onChange={(e) => onSearchChange && onSearchChange(e.target.value)}
        />
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>{actions}</div>}
    </div>
  )
}
