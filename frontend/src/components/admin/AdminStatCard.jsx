import React from 'react';
import Card from '../ui/Card';
import Sparkline from '../ui/Sparkline';
import { renderIcon } from '../../utils/iconMap';

export default function AdminStatCard({
  icon,
  label,
  value,
  trend,
  trendDirection = 'neutral',
  onClick,
  alert = false,
  alertColor = 'var(--admin-danger)',
  spark
}) {
  const trendIcon = trendDirection === 'up'
    ? renderIcon('trade', { size: 12, color: 'var(--admin-success)' })
    : trendDirection === 'down'
      ? renderIcon('floating_down', { size: 12, color: 'var(--admin-danger)' })
      : renderIcon('arrow', { size: 12, color: 'var(--admin-text-faint)' });

  const tone = alert
    ? alertColor
    : trendDirection === 'up'
      ? 'var(--gain)'
      : trendDirection === 'down'
        ? 'var(--loss)'
        : undefined;

  return (
    <Card
      stat
      interactive={!!onClick}
      tone={tone}
      onClick={onClick}
      style={{
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
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px', marginTop: '3px' }}>
          <div className="admin-stat-label">{label}</div>
          {Array.isArray(spark) && spark.length > 1 && (
            <span style={{ width: '52px', height: '20px', flex: '0 0 auto' }}>
              <Sparkline data={spark} tone={tone || 'var(--admin-accent)'} width={52} height={20} />
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
