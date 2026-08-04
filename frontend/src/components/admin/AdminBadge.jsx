import React from 'react';
import { normalizeAdminTone } from './adminStatusTone';

export default function AdminBadge({ status, label, outline = false, bracket = false }) {
  // One of exactly 5 tones (gain/accent/warn/muted/loss) — see
  // utils/statusTone.js, the single map shared with the trader side.
  const tone = normalizeAdminTone(status);

  const text = label || status || '';

  return (
    <span
      className={`admin-badge admin-badge-${tone} ${outline ? 'outline' : 'solid'}`}
      style={bracket ? { fontFamily: 'var(--font-mono)' } : undefined}
    >
      {bracket ? `[${String(text).toUpperCase()}]` : text}
    </span>
  );
}
