import React, { useEffect, useMemo, useState } from 'react'
import { renderIcon } from '../utils/iconMap'
import Button from './ui/Button'
import {
  CONTRACT_SIZES,
  INSTRUMENT_GROUPS,
  getInputStepString,
  getPriceDecimals,
  getSpreadPoints,
  getTradableInstruments,
  getUsdRateForInstrument,
  isTradableInstrument,
} from '../utils/instruments'
import { calculateRiskRewardRatio, formatCurrency, toDecimal, toMoneyNumber } from '../utils/finance'

function getMarketStatus() {
  const now = new Date()
  const day = now.getUTCDay()
  const hour = now.getUTCHours()
  const min = now.getUTCMinutes()
  const total = hour * 60 + min

  if (day === 6) return { open: false, reason: 'Market closed - weekend. Opens Sunday 22:00 UTC.' }
  if (day === 5 && total >= 22 * 60) return { open: false, reason: 'Market closed - weekend. Opens Sunday 22:00 UTC.' }
  if (day === 0 && total < 22 * 60) {
    const minsLeft = 22 * 60 - total
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m).` }
  }
  if (day >= 1 && day <= 5 && total >= 21 * 60 + 55 && total < 22 * 60 + 5) {
    return { open: false, reason: 'Daily rollover 21:55-22:05 UTC. Try again shortly.' }
  }

  return { open: true, reason: '' }
}

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
  const [orderMode, setOrderMode] = useState('market')
  const [marketPreviewDirection, setMarketPreviewDirection] = useState('buy')
  const [pendingType, setPendingType] = useState('buy_limit')
  const [pendingPrice, setPendingPrice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [symbolCategory, setSymbolCategory] = useState('all')

  const updateForm = (patch) => setOrderForm((current) => ({ ...current, ...patch }))

  const filteredInstruments = useMemo(() => {
    if (symbolCategory === 'all') return availableInstruments
    const group = INSTRUMENT_GROUPS[symbolCategory] || []
    return availableInstruments.filter((item) => group.includes(item))
  }, [symbolCategory, availableInstruments])

  useEffect(() => {
    if (filteredInstruments.length === 0) return
    if (!filteredInstruments.includes(orderForm.instrument)) {
      updateForm({ instrument: filteredInstruments[0], stop_loss: '', take_profit: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredInstruments])

  const instrument = orderForm.instrument
  const priceData = prices[instrument]
  const decimals = getPriceDecimals(instrument)
  const step = getInputStepString(instrument)
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  const accountBalanceNum = selectedAccount ? parseFloat(selectedAccount.current_balance || 0) : 0
  const floatingBalanceNum = Number.isFinite(parseFloat(floatingBalance))
    ? parseFloat(floatingBalance)
    : accountBalanceNum
  const bidNum = priceData ? parseFloat(priceData.bid) : null
  const askNum = priceData ? parseFloat(priceData.ask) : null
  const bid = Number.isFinite(bidNum) ? bidNum.toFixed(decimals) : '-'
  const ask = Number.isFinite(askNum) ? askNum.toFixed(decimals) : '-'
  const spread = priceData
    ? getSpreadPoints(parseFloat(priceData.ask) - parseFloat(priceData.bid), instrument).toFixed(1)
    : '-'

  const weekendCutoffNow = new Date()
  const weekendCutoffTotal = weekendCutoffNow.getUTCHours() * 60 + weekendCutoffNow.getUTCMinutes()
  const marketStatus = (
    weekendCutoffNow.getUTCDay() === 5 && weekendCutoffTotal >= 21 * 60
  )
    ? { open: false, reason: 'New trades stop after Friday 21:00 UTC to avoid weekend gap risk.' }
    : getMarketStatus()

  const pendingDirection = pendingType.startsWith('buy') ? 'buy' : 'sell'
  const pendingPriceNum = Number.isFinite(parseFloat(pendingPrice)) ? parseFloat(pendingPrice) : null
  const stopLossNum = Number.isFinite(parseFloat(orderForm.stop_loss)) ? parseFloat(orderForm.stop_loss) : null
  const takeProfitNum = Number.isFinite(parseFloat(orderForm.take_profit)) ? parseFloat(orderForm.take_profit) : null

  const previewDirection = orderMode === 'pending' ? pendingDirection : marketPreviewDirection
  const previewEntry = orderMode === 'pending'
    ? pendingPriceNum
    : previewDirection === 'buy'
      ? askNum
      : bidNum
  const rrSummary = useMemo(() => {
    const lots = Number.isFinite(parseFloat(orderForm.lots)) ? parseFloat(orderForm.lots) : null
    if (!lots || lots < 0.01 || !Number.isFinite(previewEntry) || (!stopLossNum && !takeProfitNum)) return null

    // C-01: distance * lots * contractSize lands in the instrument's QUOTE
    // currency, so calling it USD needs the same QUOTE/USD rate the server
    // applies. A null rate means we cannot state a dollar figure — show nothing
    // rather than a number that is wrong by the rate (~150x on the JPY pairs).
    if (!isTradableInstrument(instrument)) return null
    const usdRate = getUsdRateForInstrument(prices, instrument)
    if (usdRate == null) return null

    const riskDistance = stopLossNum ? Math.abs(previewEntry - stopLossNum) : null
    const rewardDistance = takeProfitNum ? Math.abs(takeProfitNum - previewEntry) : null

    const toUSD = (distance) => toMoneyNumber(
      toDecimal(distance).mul(toDecimal(lots)).mul(toDecimal(contractSize)).mul(toDecimal(usdRate))
    )

    const riskUSD = riskDistance != null ? toUSD(riskDistance) : null
    const rewardUSD = rewardDistance != null ? toUSD(rewardDistance) : null
    const rr = riskUSD != null && rewardUSD != null
      ? calculateRiskRewardRatio(riskUSD, rewardUSD)
      : null

    return { riskUSD, rewardUSD, rr }
  }, [contractSize, instrument, orderForm.lots, previewEntry, prices, stopLossNum, takeProfitNum])

  async function submitOrder(payload) {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      await onOpenTrade(payload)
    } finally {
      setIsSubmitting(false)
    }
  }

  function buildBasePayload(direction) {
    return { direction }
  }

  function handleMarketOrder(direction) {
    setMarketPreviewDirection(direction)
    submitOrder({
      ...buildBasePayload(direction),
      orderType: 'market',
      pendingPrice: null
    })
  }

  function handlePendingOrder() {
    const price = parseFloat(pendingPrice)
    if (!pendingPrice || Number.isNaN(price) || price <= 0) return

    const ocoEnabled = Boolean(orderForm.oco_enabled && orderForm.oco_order_type && orderForm.oco_pending_price)
    const ocoSibling = ocoEnabled
      ? {
          order_type: orderForm.oco_order_type,
          pending_price: parseFloat(orderForm.oco_pending_price)
        }
      : null

    const direction = pendingDirection
    submitOrder({
      ...buildBasePayload(direction),
      direction,
      orderType: pendingType,
      pendingPrice: price,
      ocoSibling
    })
    setPendingPrice('')
  }

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
          style={{ width: '100%', fontSize: '14px', fontWeight: '700' }}
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
          value={orderForm.lots}
          onChange={(e) => updateForm({ lots: e.target.value })}
          min="0.01"
          step="0.01"
          placeholder="0.01"
          style={{
            width: '100%',
            fontSize: '14px',
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
          value={orderForm.stop_loss}
          onChange={(e) => updateForm({ stop_loss: e.target.value })}
          placeholder="e.g. 1.08500"
          step={step}
          style={{ width: '100%', fontSize: '14px' }}
        />
      </div>

      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          TAKE PROFIT <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
        </label>
        <input
          className="input-field"
          type="number"
          value={orderForm.take_profit}
          onChange={(e) => updateForm({ take_profit: e.target.value })}
          placeholder="e.g. 1.09500"
          step={step}
          style={{ width: '100%', fontSize: '14px' }}
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
          <div className="order-panel-rr-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
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
            <div className="order-panel-type-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
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
              value={pendingPrice}
              onChange={(e) => setPendingPrice(e.target.value)}
              placeholder={`e.g. ${priceData ? (parseFloat(priceData.ask) * 0.999).toFixed(decimals) : '-'}`}
              step={step}
              style={{ width: '100%', fontSize: '14px' }}
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
