import React from 'react'
import { Search } from 'lucide-react'

/**
 * Visible header trigger for CommandPalette (Modern Gazette handoff spec:
 * "global search trigger, ⌘K shown as a keycap"). CommandPalette also
 * listens for Cmd/Ctrl+K directly — this button just makes that discoverable
 * and dispatches the same open event.
 */
export default function CommandPaletteTrigger({ label = 'Search…' }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event('gazette:open-command-palette'))}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: '8px',
        background: 'var(--glass)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)',
        padding: '6px 10px', color: 'var(--muted)', cursor: 'pointer', fontSize: 'var(--fs-base)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <Search size={14} />
      <span>{label}</span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: '9.5px', color: 'var(--muted)',
        border: '1px solid var(--rule)', borderRadius: '2px', padding: '1px 5px', marginLeft: '4px',
      }}>
        ⌘K
      </span>
    </button>
  )
}
