import React from 'react';

export default function AdminBadge({ status, label, outline = false, bracket = false }) {
  // Normalize status for class matching
  const normalized = (status || '').toLowerCase();

  let colorClass = 'neutral';

  if (['funded', 'gold'].includes(normalized)) colorClass = 'gold';
  else if (['active', 'passed', 'resolved', 'info', 'blue'].includes(normalized)) colorClass = 'info';
  else if (['failed', 'breach', 'rejected', 'danger', 'red', 'open', 'banned'].includes(normalized)) colorClass = 'danger';
  else if (['pending', 'amber', 'under review', 'warning'].includes(normalized)) colorClass = 'warning';
  else if (['success', 'approved', 'green'].includes(normalized)) colorClass = 'success';
  else if (['accent', 'purple'].includes(normalized)) colorClass = 'accent';

  const text = label || status || '';

  return (
    <span
      className={`admin-badge admin-badge-${colorClass} ${outline ? 'outline' : 'solid'}`}
      style={bracket ? { fontFamily: 'var(--font-mono)' } : undefined}
    >
      {bracket ? `[${String(text).toUpperCase()}]` : text}
    </span>
  );
}
