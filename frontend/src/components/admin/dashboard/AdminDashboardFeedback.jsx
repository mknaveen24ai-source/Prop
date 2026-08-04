import React from 'react';
import Card from '../../ui/Card';

export function Skeleton({ height = 40, width = '100%', radius = 8, style = {} }) {
  return (
    <div
      style={{
        height,
        width,
        borderRadius: radius,
        background: 'linear-gradient(90deg, var(--admin-surface) 25%, var(--admin-bg) 50%, var(--admin-surface) 75%)',
        backgroundSize: '200% 100%',
        animation: 'adminShimmer 1.5s infinite',
        ...style,
      }}
    />
  );
}

export function StatsSkeleton() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '24px' }}>
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index} style={{ padding: '20px' }}>
          <Skeleton height={12} width="60%" style={{ marginBottom: '12px' }} />
          <Skeleton height={28} width="40%" />
        </Card>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 220 }) {
  return (
    <Card style={{ padding: '20px' }}>
      <Skeleton height={14} width="45%" style={{ marginBottom: '16px' }} />
      <Skeleton height={height} radius={6} />
    </Card>
  );
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <div
      style={{
        background: 'color-mix(in srgb, var(--admin-danger) 8%, transparent)',
        border: '1px solid color-mix(in srgb, var(--admin-danger) 30%, transparent)',
        padding: '24px',
        marginBottom: '24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
        <span style={{ fontSize: '20px' }}>!</span>
        <div>
          <div style={{ color: 'var(--admin-danger)', fontWeight: 600, marginBottom: '4px' }}>
            Dashboard data unavailable
          </div>
          <div style={{ color: 'var(--admin-text-muted)', fontSize: '13px' }}>{message}</div>
        </div>
      </div>
      <button className="admin-btn admin-btn-ghost" onClick={onRetry} style={{ flexShrink: 0 }}>
        Retry
      </button>
    </div>
  );
}
