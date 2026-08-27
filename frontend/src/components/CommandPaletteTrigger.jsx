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
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)',
        background: 'var(--glass)', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)',
        padding: 'var(--space-1-5) var(--space-2-5)', color: 'var(--muted)', cursor: 'pointer', fontSize: 'var(--fs-base)',
        fontFamily: 'var(--font-ui)',
      }}
    >
      <Search size={14} />
      <span>{label}</span>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-2xs)', color: 'var(--muted)',
        border: '1px solid var(--rule)', borderRadius: '2px', padding: '1px var(--space-1-5)', marginLeft: 'var(--space-1)',
      }}>
        ⌘K
      </span>
    </button>
  )
}
