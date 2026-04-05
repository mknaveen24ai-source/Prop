import React from 'react';
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts';

export default function AdminChart({ 
  children,
  height = 300,
  title
}) {
  return (
    <div className="admin-card">
      {title && <h3 className="admin-h2" style={{ marginBottom: '24px' }}>{title}</h3>}
      <div style={{ width: '100%', height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Helper props to inject into standard Recharts components
export const chartThemeProps = {
  grid: { stroke: 'rgba(255,255,255,0.06)', strokeDasharray: '3 3', vertical: false },
  xAxis: { stroke: 'var(--admin-text-faint)', tick: { fill: 'var(--admin-text-muted)', fontSize: 11 }, tickLine: false, axisLine: false },
  yAxis: { stroke: 'var(--admin-text-faint)', tick: { fill: 'var(--admin-text-muted)', fontSize: 11 }, tickLine: false, axisLine: false },
  tooltip: {
    contentStyle: { 
      backgroundColor: 'var(--admin-elevated)', 
      borderColor: 'var(--admin-border-strong)', 
      borderRadius: '8px',
      color: 'var(--admin-text)',
      boxShadow: '0 10px 15px -3px rgba(0,0,0,0.5)'
    },
    itemStyle: { color: 'var(--admin-text)', fontSize: '13px' },
    labelStyle: { color: 'var(--admin-text-muted)', marginBottom: '8px', fontSize: '12px', fontWeight: 600 }
  }
};
