import React from 'react'
import { renderIcon } from '../utils/iconMap'
import Button from './ui/Button'
import { getTradableInstruments } from '../utils/instruments'
import { formatCurrency } from '../utils/finance'
import useOrderTicket from './trading/hooks/useOrderTicket'

function renderPendingExplanation(pendingType, ask, bid) {
  if (pendingType === 'buy_limit') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        {renderIcon('floating_down', { size: 12, color: 'var(--accent-green)' })}
        <span><strong style={{ color: 'var(--green)' }}>Buy Limit</strong> - Set price <strong>below</strong> current ask ({ask}). Order fills when market drops to your price.</span>
      </span>
    )
  }

  if (pendingType === 'sell_limit') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        {renderIcon('floating_up', { size: 12, color: 'var(--accent-red)' })}
        <span><strong style={{ color: 'var(--red)' }}>Sell Limit</strong> - Set price <strong>above</strong> current bid ({bid}). Order fills when market rises to your price.</span>
      </span>
    )
  }

  if (pendingType === 'buy_stop') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
        {renderIcon('floating_up', { size: 12, color: 'var(--accent-green)' })}
        <span><strong style={{ color: 'var(--green)' }}>Buy Stop</strong> - Set price <strong>above</strong> current ask ({ask}). Order fills when market breaks up to your price.</span>
      </span>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      {renderIcon('floating_down', { size: 12, color: 'var(--accent-red)' })}
      <span><strong style={{ color: 'var(--red)' }}>Sell Stop</strong> - Set price <strong>below</strong> current bid ({bid}). Order fills when market breaks down to your price.</span>
    </span>
  )
}

export default function OrderPanel({
  prices,
  selectedAccount,
  floatingBalance,
  // C-01 containment: default to what may actually be opened, not the whole
  // catalogue — otherwise this panel offers instruments the server will reject.
  availableInstruments = getTradableInstruments(),
  onOpenTrade,
  orderForm,
  setOrderForm
}) {
  // All order state, derivations and submission live in the shared hook so the
  // mobile order ticket places byte-identical orders. This component is the
  // desktop *view* only.
  const {
    orderMode, setOrderMode,
    marketPreviewDirection, setMarketPreviewDirection,
    pendingType, setPendingType,
    pendingPrice, setPendingPrice,
    symbolCategory, setSymbolCategory,
    isSubmitting,
    updateForm, filteredInstruments,
    instrument, priceData, decimals, step,
    bid, ask, spread,
    accountBalanceNum, floatingBalanceNum,
    marketStatus,
    previewDirection,
    rrSummary,
    handleMarketOrder, handlePendingOrder,
  } = useOrderTicket({
    prices,
    selectedAccount,
    floatingBalance,
    availableInstruments,
    onOpenTrade,
    orderForm,
    setOrderForm,
  })

  return (
    <div className="order-panel" style={{ padding: '20px' }}>
      {!marketStatus.open && (
        <div style={{
          background: 'var(--danger-bg)',
          border: '1px solid var(--red)',
          borderRadius: '0',
          padding: '10px 14px',
          marginBottom: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon('warning', { size: 16, color: 'var(--accent-red)' })}
          </span>
          <div>
            <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--red)' }}>MARKET CLOSED</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{marketStatus.reason}</div>
          </div>
        </div>
      )}

      {marketStatus.open && (
        <div style={{
          background: 'var(--success-bg)',
          border: '1px solid var(--green)',
          borderRadius: '0',
          padding: '10px 14px',
          marginBottom: '16px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px'
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--green-light)', boxShadow: '0 0 6px var(--green-light)', display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: '12px', color: 'var(--green-light)', fontWeight: '700', letterSpacing: '0.08em' }}>MARKET OPEN</span>
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>INSTRUMENT</label>
        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
          {[
            { key: 'all', label: 'All', color: 'var(--accent)' },
            { key: 'FOREX_MAJORS', label: 'FX Majors', color: 'var(--accent)' },
            { key: 'FOREX_MINORS', label: 'FX Minors', color: 'var(--accent)' },
            { key: 'COMMODITY_METALS', label: 'Metals', color: 'var(--accent-gold)' },
            { key: 'ENERGIES', label: 'Energies', color: 'var(--accent-gold)' },
            { key: 'INDICES_SPOT', label: 'Indices Spot', color: 'var(--accent-green)' },
            { key: 'INDICES_MAJOR', label: 'Indices Major', color: 'var(--accent-green)' },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setSymbolCategory(tab.key)}
              style={{
                padding: '3px 9px',
                fontSize: '10px',
                fontWeight: 700,
                borderRadius: 'var(--radius-pill)',
                cursor: 'pointer',
                border: `1px solid ${symbolCategory === tab.key ? tab.color : 'var(--navy-border)'}`,
                background: symbolCategory === tab.key
                  ? `color-mix(in srgb, ${tab.color} 15%, transparent)`
                  : 'transparent',
                color: symbolCategory === tab.key ? tab.color : 'var(--text-muted)',
                transition: 'all 0.15s',
                letterSpacing: '0.04em'
              }}
            >{tab.label}</button>
          ))}
        </div>
        <select
          className="select-field order-panel-select"
          value={instrument}
          onChange={(e) => updateForm({ instrument: e.target.value, stop_loss: '', take_profit: '' })}
          disabled={availableInstruments.length === 0}
          style={{ width: '100%', fontWeight: '700' }}
        >
          {filteredInstruments.map((item) => (
            <option key={item} value={item}>{item}</option>
          ))}
        </select>
        {availableInstruments.length === 0 && (
          <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '6px' }}>
            No live instruments are currently available on this feed.
          </div>
        )}
      </div>

      <div className="order-panel-price-card">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--red)', marginBottom: '4px', letterSpacing: '0.08em' }}>BID</div>
          <div style={{ fontSize: '24px', fontWeight: '800', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{bid}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--green)', marginBottom: '4px', letterSpacing: '0.08em' }}>ASK</div>
          <div style={{ fontSize: '24px', fontWeight: '800', color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{ask}</div>
        </div>
        <div style={{ gridColumn: '1/-1', textAlign: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
          Spread: {spread} pts
        </div>
      </div>

      <div className="order-panel-mode-toggle" style={{ display: 'flex', gap: '6px' }}>
        <Button
          variant={orderMode === 'market' ? 'primary' : 'ghost'}
          size="sm"
          full
          onClick={() => {
            setOrderMode('market')
            setMarketPreviewDirection('buy')
          }}
        >
          Market
        </Button>
        <Button
          variant={orderMode === 'pending' ? 'primary' : 'ghost'}
          size="sm"
          full
          onClick={() => setOrderMode('pending')}
        >
          Pending
        </Button>
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          LOT SIZE <span style={{ color: 'var(--text-dim)' }}>(min 0.01 - steps of 0.01)</span>
        </label>
        <input
          className="input-field"
          type="number"
          inputMode="decimal"
          value={orderForm.lots}
          onChange={(e) => updateForm({ lots: e.target.value })}
          min="0.01"
          step="0.01"
          placeholder="0.01"
          style={{
            width: '100%',
            borderColor: parseFloat(orderForm.lots) < 0.01 && orderForm.lots !== '' ? 'var(--red)' : ''
          }}
        />
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          STOP LOSS <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
        </label>
        <input
          className="input-field"
          type="number"
          inputMode="decimal"
          value={orderForm.stop_loss}
          onChange={(e) => updateForm({ stop_loss: e.target.value })}
          placeholder="e.g. 1.08500"
          step={step}
          style={{ width: '100%' }}
        />
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          TAKE PROFIT <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
        </label>
        <input
          className="input-field"
          type="number"
          inputMode="decimal"
          value={orderForm.take_profit}
          onChange={(e) => updateForm({ take_profit: e.target.value })}
          placeholder="e.g. 1.09500"
          step={step}
          style={{ width: '100%' }}
        />
      </div>

      {rrSummary && (
        <div style={{
          background: 'color-mix(in srgb, var(--muted) 4%, transparent)',
          border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
          borderRadius: '0',
          padding: '10px 12px',
          marginBottom: '16px',
          fontSize: '12px'
        }}>
          <div style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '8px' }}>
            R:R CALCULATOR ({previewDirection.toUpperCase()} PREVIEW)
          </div>
          {orderMode === 'market' && (
            <div style={{ display: 'inline-flex', gap: '6px', marginBottom: '10px' }}>
              {[
                { value: 'buy', label: 'Preview BUY', color: 'var(--green)' },
                { value: 'sell', label: 'Preview SELL', color: 'var(--red)' }
              ].map((option) => {
                const active = marketPreviewDirection === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMarketPreviewDirection(option.value)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 'var(--radius-pill)',
                      border: `1px solid ${active ? option.color : 'color-mix(in srgb, var(--muted) 20%, transparent)'}`,
                      background: active ? `color-mix(in srgb, ${option.color} 12%, transparent)` : 'transparent',
                      color: active ? option.color : 'var(--text-muted)',
                      fontSize: '10px',
                      fontWeight: '700',
                      letterSpacing: '0.04em',
                      cursor: 'pointer'
                    }}
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
          )}
          {/* Columns come from .order-panel-rr-grid in App.css, not an inline
              style — three currency figures do not fit in ~85px each at 375px,
              and a media query cannot widen an inline grid. */}
          <div className="order-panel-rr-grid">
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>RISK</div>
              <div style={{ color: 'var(--red)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                {rrSummary.riskUSD != null ? `-${formatCurrency(rrSummary.riskUSD)}` : '-'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>REWARD</div>
              <div style={{ color: 'var(--green)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                {rrSummary.rewardUSD != null ? `+${formatCurrency(rrSummary.rewardUSD)}` : '-'}
              </div>
            </div>
            <div>
              <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>R:R RATIO</div>
              <div style={{ color: rrSummary.rr >= 2 ? 'var(--green)' : rrSummary.rr >= 1 ? 'var(--muted)' : 'var(--red)', fontWeight: '700', fontFamily: 'var(--font-mono)' }}>
                {rrSummary.rr != null ? `1:${rrSummary.rr}` : '-'}
              </div>
            </div>
          </div>
        </div>
      )}

      {orderMode === 'pending' && (
        <div style={{ marginBottom: '16px' }}>
          <div style={{ marginBottom: '14px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>ORDER TYPE</label>
            {/* Columns live in .order-panel-type-grid (App.css) so the mobile
                query can collapse them; an inline grid would outrank it. */}
            <div className="order-panel-type-grid">
              {[
                { value: 'buy_limit', label: 'Buy Limit', desc: 'Buy below market', color: 'var(--green)' },
                { value: 'sell_limit', label: 'Sell Limit', desc: 'Sell above market', color: 'var(--red)' },
                { value: 'buy_stop', label: 'Buy Stop', desc: 'Buy above market', color: 'var(--green)' },
                { value: 'sell_stop', label: 'Sell Stop', desc: 'Sell below market', color: 'var(--red)' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPendingType(opt.value)}
                  style={{
                    padding: '10px 8px',
                    borderRadius: '0',
                    border: pendingType === opt.value ? `1px solid ${opt.color}` : '1px solid var(--navy-border)',
                    background: pendingType === opt.value ? `color-mix(in srgb, ${opt.color} 10%, transparent)` : 'var(--navy-card)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <div style={{ fontSize: '12px', fontWeight: '600', color: opt.color }}>{opt.label}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{
            background: 'var(--navy)',
            borderRadius: '0',
            padding: '10px 12px',
            marginBottom: '14px',
            fontSize: '11px',
            color: 'var(--text-muted)',
            lineHeight: '1.5'
          }}>
            {renderPendingExplanation(pendingType, ask, bid)}
          </div>

          <div style={{ marginBottom: '14px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>ORDER PRICE</label>
            <input
              className="input-field"
              type="number"
              inputMode="decimal"
              value={pendingPrice}
              onChange={(e) => setPendingPrice(e.target.value)}
              placeholder={`e.g. ${priceData ? (parseFloat(priceData.ask) * 0.999).toFixed(decimals) : '-'}`}
              step={step}
              style={{ width: '100%' }}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={Boolean(orderForm.oco_enabled)}
              onChange={(e) => updateForm({ oco_enabled: e.target.checked })}
            />
            <span>Enable OCO sibling order</span>
          </label>

          {orderForm.oco_enabled && (
            <div style={{
              background: 'color-mix(in srgb, var(--muted) 4%, transparent)',
              border: '1px solid color-mix(in srgb, var(--muted) 15%, transparent)',
              borderRadius: '0',
              padding: '12px',
              marginBottom: '14px'
            }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>OCO SIBLING ORDER</div>
              <select
                className="select-field"
                value={orderForm.oco_order_type || 'sell_stop'}
                onChange={(e) => updateForm({ oco_order_type: e.target.value })}
                style={{ width: '100%', marginBottom: '10px' }}
              >
                <option value="buy_limit">Buy Limit</option>
                <option value="sell_limit">Sell Limit</option>
                <option value="buy_stop">Buy Stop</option>
                <option value="sell_stop">Sell Stop</option>
              </select>
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                value={orderForm.oco_pending_price || ''}
                onChange={(e) => updateForm({ oco_pending_price: e.target.value })}
                placeholder="Sibling trigger price"
                step={step}
                style={{ width: '100%' }}
              />
            </div>
          )}
        </div>
      )}

      {orderMode === 'market' && (
        <div className="order-submit-grid">
          <Button
            variant="secondary"
            onClick={() => handleMarketOrder('sell')}
            onMouseEnter={() => setMarketPreviewDirection('sell')}
            onFocus={() => setMarketPreviewDirection('sell')}
            disabled={!selectedAccount || !priceData || !marketStatus.open || isSubmitting}
            style={{ flexDirection: 'column', padding: '16px 14px', fontWeight: 800, borderColor: 'var(--loss)', color: 'var(--loss)' }}
          >
            <div style={{ fontSize: '10px', marginBottom: '4px', opacity: 0.7, letterSpacing: '0.1em' }}>SELL</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '18px' }}>{isSubmitting ? '...' : bid}</div>
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleMarketOrder('buy')}
            onMouseEnter={() => setMarketPreviewDirection('buy')}
            onFocus={() => setMarketPreviewDirection('buy')}
            disabled={!selectedAccount || !priceData || !marketStatus.open || isSubmitting}
            style={{ flexDirection: 'column', padding: '16px 14px', fontWeight: 800, borderColor: 'var(--gain)', color: 'var(--gain)' }}
          >
            <div style={{ fontSize: '10px', marginBottom: '4px', opacity: 0.7, letterSpacing: '0.1em' }}>BUY</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: '18px' }}>{isSubmitting ? '...' : ask}</div>
          </Button>
        </div>
      )}

      {orderMode === 'pending' && (
        <Button
          variant="secondary"
          full
          onClick={handlePendingOrder}
          disabled={!selectedAccount || !priceData || !pendingPrice || parseFloat(pendingPrice) <= 0 || !marketStatus.open || isSubmitting}
          style={{
            padding: '14px',
            fontWeight: 700,
            borderColor: pendingType.startsWith('buy') ? 'var(--gain)' : 'var(--loss)',
            color: pendingType.startsWith('buy') ? 'var(--gain)' : 'var(--loss)',
          }}
        >
          {isSubmitting ? 'Placing...' : `Place ${pendingType.replaceAll('_', ' ').toUpperCase()} @ ${pendingPrice || '-'}`}
        </Button>
      )}

      {selectedAccount && (
        <div className="order-panel-summary" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          <div className="order-panel-summary-row">
            <span style={{ fontSize: '12px' }}>Balance</span>
            <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: '700' }}>
              ${accountBalanceNum.toFixed(2)}
            </span>
          </div>
          <div className="order-panel-summary-row">
            <span style={{ fontSize: '12px' }}>Floating Balance</span>
            <span style={{ color: floatingBalanceNum >= accountBalanceNum ? 'var(--green)' : 'var(--red)', fontFamily: 'var(--font-mono)', fontSize: '15px', fontWeight: '700' }}>
              ${floatingBalanceNum.toFixed(2)}
            </span>
          </div>
          <div className="order-panel-summary-row">
            <span style={{ fontSize: '11px' }}>Account</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
              {selectedAccount.account_type.toUpperCase()} ${parseFloat(selectedAccount.account_size).toLocaleString()}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
