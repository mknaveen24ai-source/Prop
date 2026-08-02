import React from 'react';
import { getDecimals, SUPPORTED_INSTRUMENTS } from './tradingPanelUtils';

export default function TradingPriceTicker({ prices, orderForm, setOrderForm }) {
  return (
    <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', overflowX: 'auto', paddingBottom: '4px' }}>
      {SUPPORTED_INSTRUMENTS.map((instrument) => {
        const data = prices[instrument];
        if (!data) return null;

        const decimals = getDecimals(instrument);
        const isSelected = orderForm.instrument === instrument;

        return (
          <div
            key={instrument}
            onClick={() => setOrderForm((form) => ({ ...form, instrument, stop_loss: '', take_profit: '' }))}
            style={{
              background: 'var(--navy-card)',
              border: isSelected ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
              padding: '10px 14px',
              cursor: 'pointer',
              minWidth: '110px',
              flexShrink: 0,
              transition: 'all 0.15s',
              boxShadow: isSelected ? '0 0 12px color-mix(in srgb, var(--muted) 20%, transparent)' : 'none',
            }}
          >
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: '4px' }}>{instrument}</div>
            <div style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
              {parseFloat(data.bid).toFixed(decimals)}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
              {parseFloat(data.ask).toFixed(decimals)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
