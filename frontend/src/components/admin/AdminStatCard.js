import React from 'react';

export default function AdminStatCard({ 
  icon, 
  label, 
  value, 
  trend, 
  trendDirection = 'neutral', // 'up', 'down', 'neutral'
  onClick 
}) {
  return (
    <div className="admin-stat-card" onClick={onClick} style={{ cursor: onClick ? 'pointer' : 'default' }}>
      <div className="admin-stat-header">
        <div className="admin-stat-icon-wrap">
          {icon}
        </div>
        {trend && (
          <div className={`admin-stat-trend ${trendDirection}`}>
            {trendDirection === 'up' && '↗'}
            {trendDirection === 'down' && '↘'}
            {trendDirection === 'neutral' && '→'}
            <span style={{ marginLeft: '4px' }}>{trend}</span>
          </div>
        )}
      </div>
      <div>
        <div className="admin-stat-value">{value}</div>
        <div className="admin-stat-label">{label}</div>
      </div>
    </div>
  );
}
