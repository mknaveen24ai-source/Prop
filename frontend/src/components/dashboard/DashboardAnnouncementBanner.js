import React from 'react';

const ANNOUNCEMENT_COLORS = {
  info: { bg: 'rgba(100, 180, 255, 0.10)', border: 'rgba(100, 180, 255, 0.4)', text: '#60b4ff', icon: 'ℹ' },
  warning: { bg: 'rgba(255, 180, 50, 0.10)', border: 'rgba(255, 180, 50, 0.4)', text: '#ffb432', icon: '!' },
  success: { bg: 'rgba(80, 200, 120, 0.10)', border: 'rgba(80, 200, 120, 0.4)', text: '#50c878', icon: 'OK' },
  error: { bg: 'rgba(240, 80, 80, 0.10)', border: 'rgba(240, 80, 80, 0.4)', text: '#f05050', icon: 'X' },
};

export default function DashboardAnnouncementBanner({ announcement, dismissed, onDismiss }) {
  if (!announcement || dismissed) return null;

  const colors = ANNOUNCEMENT_COLORS[announcement.type] || ANNOUNCEMENT_COLORS.info;

  return (
    <div
      style={{
        background: colors.bg,
        borderBottom: `1px solid ${colors.border}`,
        padding: '10px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        position: 'sticky',
        top: '57px',
        zIndex: 90,
      }}
    >
      <span>{colors.icon}</span>
      <span style={{ flex: 1, fontSize: '13px', color: colors.text, fontWeight: '500' }}>
        {announcement.message}
      </span>
      <button
        onClick={onDismiss}
        style={{ background: 'none', border: 'none', color: colors.text, cursor: 'pointer', fontSize: '16px', opacity: 0.7, padding: '0 4px' }}
      >
        x
      </button>
    </div>
  );
}
