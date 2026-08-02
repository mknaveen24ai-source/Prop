import React from 'react';

export default function TradingPanelHeader({ priceStatus }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 0, fontSize: '22px' }}>
        Trading Terminal
      </h2>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 14px',
          background: priceStatus.healthy ? 'color-mix(in srgb, var(--gain) 10%, transparent)' : 'color-mix(in srgb, var(--loss) 10%, transparent)',
          border: `1px solid ${priceStatus.healthy ? 'color-mix(in srgb, var(--gain) 30%, transparent)' : 'color-mix(in srgb, var(--loss) 30%, transparent)'}`,
          fontSize: '12px',
        }}
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: priceStatus.healthy ? 'var(--green)' : 'var(--red)',
            animation: priceStatus.healthy ? 'none' : 'pulse 1.5s infinite',
          }}
        />
        <span style={{ color: priceStatus.healthy ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>
          {priceStatus.healthy ? '● Live' : '● Delayed'}
        </span>
        {!priceStatus.healthy && priceStatus.message && (
          <span style={{ color: 'var(--text-muted)', marginLeft: '4px', fontSize: '11px' }}>
            {priceStatus.message}
          </span>
        )}
      </div>
    </div>
  );
}
