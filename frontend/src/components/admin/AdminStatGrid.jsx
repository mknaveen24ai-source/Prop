import React from 'react';

// The one standard stat-card row layout for the admin panel — replaces each
// page hand-rolling its own gridTemplateColumns/gap (previously 190px/200px/
// 220px minmax values scattered across pages with no shared source of truth).
export default function AdminStatGrid({ children, minColumnWidth = 200, gap = 16, style }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))`,
        gap: `${gap}px`,
        marginBottom: '24px',
        ...style
      }}
    >
      {children}
    </div>
  );
}
