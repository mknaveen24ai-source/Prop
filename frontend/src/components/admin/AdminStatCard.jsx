import React from 'react';
import { renderIcon } from '../../utils/iconMap';

export default function AdminStatCard({
  icon,
  label,
  value,
  trend,
  trendDirection = 'neutral',
  onClick,
  alert = false,
  alertColor = 'var(--admin-danger)'
}) {
  const trendIcon = trendDirection === 'up'
    ? renderIcon('trade', { size: 12, color: 'var(--admin-success)' })
    : trendDirection === 'down'
      ? renderIcon('floating_down', { size: 12, color: 'var(--admin-danger)' })
      : renderIcon('arrow', { size: 12, color: 'var(--admin-text-faint)' });

  return (
    <div
      className="admin-stat-card"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        border: alert ? `1px solid ${alertColor}` : undefined,
        background: alert ? 'var(--glass-2)' : undefined
      }}
    >
      <div className="admin-stat-header">
        <div className="admin-stat-icon-wrap">
          {renderIcon(icon, { size: 16, color: alert ? alertColor : 'var(--admin-accent)' })}
        </div>
        {trend && (
          <div className={`admin-stat-trend ${trendDirection}`}>
            {trendIcon}
            <span style={{ marginLeft: '4px' }}>{trend}</span>
          </div>
        )}
      </div>
      <div>
        <div className="admin-stat-value" style={alert ? { color: alertColor } : undefined}>{value}</div>
        <div className="admin-stat-label">{label}</div>
      </div>
    </div>
  );
}
