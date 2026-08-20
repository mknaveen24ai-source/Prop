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
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-5)', marginBottom: 'var(--space-6)' }}>
      {Array.from({ length: 6 }).map((_, index) => (
        <Card key={index} style={{ padding: 'var(--space-5)' }}>
          <Skeleton height={12} width="60%" style={{ marginBottom: 'var(--space-3)' }} />
          <Skeleton height={28} width="40%" />
        </Card>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 220 }) {
  return (
    <Card style={{ padding: 'var(--space-5)' }}>
      <Skeleton height={14} width="45%" style={{ marginBottom: 'var(--space-4)' }} />
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
        padding: 'var(--space-6)',
        marginBottom: 'var(--space-6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-4)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span style={{ fontSize: 'var(--fs-2xl)' }}>!</span>
        <div>
          <div style={{ color: 'var(--admin-danger)', fontWeight: 600, marginBottom: 'var(--space-1)' }}>
            Dashboard data unavailable
          </div>
          <div style={{ color: 'var(--admin-text-muted)', fontSize: 'var(--fs-base)' }}>{message}</div>
        </div>
      </div>
      <button className="admin-btn admin-btn-ghost" onClick={onRetry} style={{ flexShrink: 0 }}>
        Retry
      </button>
    </div>
  );
}
