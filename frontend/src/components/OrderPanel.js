import React, { useState } from 'react'

const SUPPORTED_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']

function getDecimals(instrument) {
  if (instrument === 'XAUUSD' || instrument === 'XAGUSD') return 2
  return 5
}

function getStep(instrument) {
  if (instrument === 'XAUUSD' || instrument === 'XAGUSD') return '0.01'
  return '0.00001'
}

function getMarketStatus() {
  const now    = new Date()
  const day    = now.getUTCDay()
  const hour   = now.getUTCHours()
  const min    = now.getUTCMinutes()
  const total  = hour * 60 + min

  if (day === 6) return { open: false, reason: 'Market closed — weekend. Opens Sunday 22:00 UTC.' }
  if (day === 5 && total >= 22 * 60) return { open: false, reason: 'Market closed — weekend. Opens Sunday 22:00 UTC.' }
  if (day === 0 && total < 22 * 60) {
    const minsLeft = 22 * 60 - total
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${Math.floor(minsLeft/60)}h ${minsLeft%60}m).` }
  }
  if (total >= 21 * 60 + 55 && total < 22 * 60 + 5) {
    return { open: false, reason: 'Daily rollover 21:55–22:05 UTC. Try again shortly.' }
  }
  return { open: true, reason: '' }
}

export default function OrderPanel({ prices, selectedAccount, floatingBalance, onOpenTrade, orderForm, setOrderForm }) {
  const [orderMode, setOrderMode]     = useState('market')
  const [pendingType, setPendingType] = useState('buy_limit')
  const [pendingPrice, setPendingPrice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false) // FIX 1: submission guard

  const instrument = orderForm.instrument
  const priceData  = prices[instrument]
  const decimals   = getDecimals(instrument)
  const step       = getStep(instrument)
  const accountBalanceNum = selectedAccount ? parseFloat(selectedAccount.current_balance || 0) : 0
  const floatingBalanceNum = Number.isFinite(parseFloat(floatingBalance))
    ? parseFloat(floatingBalance)
    : accountBalanceNum

  const marketStatus = getMarketStatus()
  const bid    = priceData ? parseFloat(priceData.bid).toFixed(decimals) : '—'
  const ask    = priceData ? parseFloat(priceData.ask).toFixed(decimals) : '—'
  const spread = priceData
    ? ((parseFloat(priceData.ask) - parseFloat(priceData.bid)) * (instrument.includes('XAU') || instrument.includes('XAG') ? 100 : 100000)).toFixed(1)
    : '—'

  // FIX 1: wrap onOpenTrade with submitting guard to prevent duplicate orders
  async function submitOrder(payload) {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      await onOpenTrade(payload)
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleMarketOrder(direction) {
    submitOrder({
      direction,
      orderType: 'market',
      pendingPrice: null
    })
  }

  function handlePendingOrder() {
    // FIX 2: validate pendingPrice is a real positive number
    const price = parseFloat(pendingPrice)
    if (!pendingPrice || isNaN(price) || price <= 0) return

    const direction = pendingType.startsWith('buy') ? 'buy' : 'sell'
    submitOrder({
      direction,
      orderType: pendingType,
      pendingPrice: price
    })
    setPendingPrice('')
  }

  return (
    <div className="card" style={{ padding: '20px' }}>

      {/* Market Closed Banner */}
      {!marketStatus.open && (
        <div style={{
          background: 'rgba(97, 97, 97, 0.12)',
          border: '1px solid var(--red)',
          borderRadius: '8px',
          padding: '10px 14px',
          marginBottom: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ fontSize: '16px' }}>🔴</span>
          <div>
            <div style={{ fontSize: '12px', fontWeight: '700', color: 'var(--red)' }}>MARKET CLOSED</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{marketStatus.reason}</div>
          </div>
        </div>
      )}

      {/* Market Open indicator */}
      {marketStatus.open && (
        <div style={{
          background: 'rgba(74, 74, 74, 0.1)',
          border: '1px solid rgba(74, 74, 74, 0.3)',
          borderRadius: '8px',
          padding: '7px 12px',
          marginBottom: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--green-light)', boxShadow: '0 0 6px var(--green-light)', display: 'inline-block', flexShrink: 0 }} />
          <span style={{ fontSize: '11px', color: 'var(--green-light)', fontWeight: '600' }}>MARKET OPEN</span>
        </div>
      )}

      {/* Instrument Selector */}
      <div style={{ marginBottom: '16px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>INSTRUMENT</label>
        <select
          value={instrument}
          onChange={e => setOrderForm(f => ({ ...f, instrument: e.target.value, stop_loss: '', take_profit: '' }))}
          style={{ width: '100%', fontSize: '14px', fontWeight: '600' }}
        >
          {SUPPORTED_INSTRUMENTS.map(i => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>

      {/* Live Price Display */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        gap: '8px', marginBottom: '16px',
        background: 'var(--navy)', borderRadius: '8px', padding: '12px'
      }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--red)', marginBottom: '2px' }}>BID</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--text)', fontFamily: 'DM Mono, monospace' }}>{bid}</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--green)', marginBottom: '2px' }}>ASK</div>
          <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--text)', fontFamily: 'DM Mono, monospace' }}>{ask}</div>
        </div>
        <div style={{ gridColumn: '1/-1', textAlign: 'center', fontSize: '10px', color: 'var(--text-muted)' }}>
          Spread: {spread} pts
        </div>
      </div>

      {/* Order Mode Toggle */}
      <div style={{ display: 'flex', marginBottom: '16px', borderRadius: '6px', overflow: 'hidden', border: '1px solid var(--navy-border)' }}>
        <button
          onClick={() => setOrderMode('market')}
          style={{
            flex: 1, padding: '8px', fontSize: '12px', fontWeight: '600',
            background: orderMode === 'market' ? 'var(--accent)' : 'var(--navy-card)',
            color: orderMode === 'market' ? 'var(--navy)' : 'var(--text-muted)',
            border: 'none', cursor: 'pointer'
          }}>
          Market
        </button>
        <button
          onClick={() => setOrderMode('pending')}
          style={{
            flex: 1, padding: '8px', fontSize: '12px', fontWeight: '600',
            background: orderMode === 'pending' ? 'var(--accent)' : 'var(--navy-card)',
            color: orderMode === 'pending' ? 'var(--navy)' : 'var(--text-muted)',
            border: 'none', cursor: 'pointer'
          }}>
          Pending
        </button>
      </div>

      {/* Lot Size */}
      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          LOT SIZE{' '}
          <span style={{ color: 'var(--text-dim)' }}>(min 0.01 · steps of 0.01)</span>
        </label>
        <input
          type="number"
          value={orderForm.lots}
          onChange={e => {
            const val = e.target.value
            // Warn if below minimum — backend will also reject
            setOrderForm(f => ({ ...f, lots: val }))
          }}
          min="0.01"
          step="0.01"
          placeholder="0.01"
          style={{
            width: '100%',
            fontSize: '14px',
            borderColor: parseFloat(orderForm.lots) < 0.01 && orderForm.lots !== '' ? 'var(--red)' : ''
          }}
        />
        {/* Inline warning if lot size too small */}
        {orderForm.lots !== '' && parseFloat(orderForm.lots) < 0.01 && (
          <div style={{ fontSize: '11px', color: 'var(--red)', marginTop: '4px' }}>
            ⚠ Minimum lot size is 0.01
          </div>
        )}
      </div>

      {/* Stop Loss */}
      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          STOP LOSS <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
        </label>
        <input
          type="number"
          value={orderForm.stop_loss}
          onChange={e => setOrderForm(f => ({ ...f, stop_loss: e.target.value }))}
          placeholder="e.g. 1.08500"
          step={step}
          style={{ width: '100%', fontSize: '14px' }}
        />
      </div>

      {/* Take Profit */}
      <div style={{ marginBottom: '14px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
          TAKE PROFIT <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
        </label>
        <input
          type="number"
          value={orderForm.take_profit}
          onChange={e => setOrderForm(f => ({ ...f, take_profit: e.target.value }))}
          placeholder="e.g. 1.09500"
          step={step}
          style={{ width: '100%', fontSize: '14px' }}
        />
      </div>

      {/* ── Risk / Reward Calculator ── */}
      {(() => {
        const lots    = parseFloat(orderForm.lots)
        const sl      = parseFloat(orderForm.stop_loss)
        const tp      = parseFloat(orderForm.take_profit)
        const bidNum  = priceData ? parseFloat(priceData.bid) : null
        const askNum  = priceData ? parseFloat(priceData.ask) : null

        // Need at least lots + one of SL or TP to show anything
        if (!lots || lots < 0.01 || (!sl && !tp) || !bidNum) return null

        const CONTRACT_SIZES = { EURUSD: 100000, GBPUSD: 100000, XAUUSD: 100, XAGUSD: 5000 }
        const contractSize   = CONTRACT_SIZES[instrument] || 100000

        // Use ask as entry for BUY (most common), bid for SELL
        const entryBuy  = askNum
        // eslint-disable-next-line no-unused-vars
        const entrySell = bidNum

        // Calculate risk and reward in USD for a BUY trade
        const riskPips  = sl  && entryBuy  ? Math.abs(entryBuy  - sl) : null
        const rewardPips = tp && entryBuy  ? Math.abs(tp - entryBuy)  : null

        const riskUSD   = riskPips   != null ? parseFloat((riskPips   * lots * contractSize).toFixed(2)) : null
        const rewardUSD = rewardPips != null ? parseFloat((rewardPips * lots * contractSize).toFixed(2)) : null
        const rr        = riskUSD && rewardUSD && riskUSD > 0
          ? parseFloat((rewardUSD / riskUSD).toFixed(2))
          : null

        const rrColor = rr == null ? 'var(--text-dim)'
          : rr >= 2   ? 'var(--green)'
          : rr >= 1   ? '#8b8b8b'
          : 'var(--red)'

        return (
          <div style={{
            background: 'rgba(148, 148, 148, 0.04)',
            border: '1px solid rgba(148, 148, 148, 0.15)',
            borderRadius: '8px',
            padding: '10px 12px',
            marginBottom: '16px',
            fontSize: '12px'
          }}>
            <div style={{ fontSize: '10px', color: 'var(--text-dim)', letterSpacing: '0.1em', marginBottom: '8px' }}>
              R:R CALCULATOR (BUY)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>RISK</div>
                <div style={{ color: 'var(--red)', fontWeight: '700', fontFamily: 'DM Mono, monospace' }}>
                  {riskUSD != null ? `-$${riskUSD}` : '—'}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>REWARD</div>
                <div style={{ color: 'var(--green)', fontWeight: '700', fontFamily: 'DM Mono, monospace' }}>
                  {rewardUSD != null ? `+$${rewardUSD}` : '—'}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--text-dim)', fontSize: '10px', marginBottom: '2px' }}>R:R RATIO</div>
                <div style={{ color: rrColor, fontWeight: '700', fontFamily: 'DM Mono, monospace' }}>
                  {rr != null ? `1:${rr}` : '—'}
                </div>
              </div>
            </div>
            {rr != null && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: rrColor }}>
                {rr >= 2 ? '✓ Good R:R' : rr >= 1 ? '~ Acceptable R:R' : '✗ Poor R:R — risk exceeds potential reward'}
              </div>
            )}
          </div>
        )
      })()}

      {/* ── MARKET ORDER BUTTONS ── */}
      {orderMode === 'market' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <button
            className="btn"
            onClick={() => handleMarketOrder('sell')}
            // FIX 1: disabled also when isSubmitting to prevent double orders
            disabled={!selectedAccount || !priceData || !marketStatus.open || isSubmitting}
            style={{
              padding: '14px', fontSize: '13px', fontWeight: '700',
              background: 'rgba(97, 97, 97, 0.15)',
              border: '1px solid var(--red)',
              color: 'var(--red)',
              borderRadius: '8px',
              opacity: isSubmitting ? 0.6 : 1,
              cursor: isSubmitting ? 'not-allowed' : 'pointer'
            }}>
            <div style={{ fontSize: '10px', marginBottom: '2px', opacity: 0.7 }}>SELL</div>
            <div style={{ fontFamily: 'DM Mono, monospace' }}>{isSubmitting ? '...' : bid}</div>
          </button>
          <button
            className="btn"
            onClick={() => handleMarketOrder('buy')}
            // FIX 1: disabled also when isSubmitting to prevent double orders
            disabled={!selectedAccount || !priceData || !marketStatus.open || isSubmitting}
            style={{
              padding: '14px', fontSize: '13px', fontWeight: '700',
              background: 'rgba(74, 74, 74, 0.15)',
              border: '1px solid var(--green)',
              color: 'var(--green)',
              borderRadius: '8px',
              opacity: isSubmitting ? 0.6 : 1,
              cursor: isSubmitting ? 'not-allowed' : 'pointer'
            }}>
            <div style={{ fontSize: '10px', marginBottom: '2px', opacity: 0.7 }}>BUY</div>
            <div style={{ fontFamily: 'DM Mono, monospace' }}>{isSubmitting ? '...' : ask}</div>
          </button>
        </div>
      )}

      {/* ── PENDING ORDER UI ── */}
      {orderMode === 'pending' && (
        <div>
          <div style={{ marginBottom: '14px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>ORDER TYPE</label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
              {[
                { value: 'buy_limit',  label: 'Buy Limit',  desc: 'Buy below market', color: 'var(--green)' },
                { value: 'sell_limit', label: 'Sell Limit', desc: 'Sell above market', color: 'var(--red)' },
                { value: 'buy_stop',   label: 'Buy Stop',   desc: 'Buy above market', color: 'var(--green)' },
                { value: 'sell_stop',  label: 'Sell Stop',  desc: 'Sell below market', color: 'var(--red)' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setPendingType(opt.value)}
                  style={{
                    padding: '10px 8px',
                    borderRadius: '6px',
                    border: pendingType === opt.value
                      ? `1px solid ${opt.color}`
                      : '1px solid var(--navy-border)',
                    background: pendingType === opt.value
                      ? `rgba(${opt.color === 'var(--green)' ? '26,122,74' : '192,57,43'},0.15)`
                      : 'var(--navy-card)',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: opt.color }}>{opt.label}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{opt.desc}</div>
                </button>
              ))}
            </div>
          </div>

          <div style={{
            background: 'var(--navy)', borderRadius: '6px',
            padding: '10px 12px', marginBottom: '14px',
            fontSize: '11px', color: 'var(--text-muted)', lineHeight: '1.5'
          }}>
            {pendingType === 'buy_limit'  && <>📉 <strong style={{color:'var(--green)'}}>Buy Limit</strong> — Set price <strong>below</strong> current ask ({ask}). Order fills when market drops to your price.</>}
            {pendingType === 'sell_limit' && <>📈 <strong style={{color:'var(--red)'}}>Sell Limit</strong> — Set price <strong>above</strong> current bid ({bid}). Order fills when market rises to your price.</>}
            {pendingType === 'buy_stop'   && <>📈 <strong style={{color:'var(--green)'}}>Buy Stop</strong> — Set price <strong>above</strong> current ask ({ask}). Order fills when market breaks up to your price.</>}
            {pendingType === 'sell_stop'  && <>📉 <strong style={{color:'var(--red)'}}>Sell Stop</strong> — Set price <strong>below</strong> current bid ({bid}). Order fills when market breaks down to your price.</>}
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px', display: 'block' }}>
              ORDER PRICE
            </label>
            <input
              type="number"
              value={pendingPrice}
              onChange={e => setPendingPrice(e.target.value)}
              placeholder={`e.g. ${priceData ? (parseFloat(priceData.ask) * 0.999).toFixed(decimals) : '—'}`}
              step={step}
              style={{ width: '100%', fontSize: '14px' }}
            />
          </div>

          <button
            className="btn"
            onClick={handlePendingOrder}
            // FIX 1 + FIX 2: disabled when submitting or price invalid
            disabled={!selectedAccount || !priceData || !pendingPrice || parseFloat(pendingPrice) <= 0 || !marketStatus.open || isSubmitting}
            style={{
              width: '100%', padding: '14px', fontSize: '13px', fontWeight: '700',
              background: pendingType.startsWith('buy')
                ? 'rgba(74, 74, 74, 0.15)' : 'rgba(97, 97, 97, 0.15)',
              border: `1px solid ${pendingType.startsWith('buy') ? 'var(--green)' : 'var(--red)'}`,
              color: pendingType.startsWith('buy') ? 'var(--green)' : 'var(--red)',
              borderRadius: '8px',
              opacity: isSubmitting ? 0.6 : 1,
              cursor: isSubmitting ? 'not-allowed' : 'pointer'
            }}>
            {/* FIX 3: replaceAll instead of replace to fix 'sell_stop' → 'SELL STOP' */}
            {isSubmitting ? 'Placing...' : `Place ${pendingType.replaceAll('_', ' ').toUpperCase()} @ ${pendingPrice || '—'}`}
          </button>
        </div>
      )}

      {/* Account info */}
      {selectedAccount && (
        <div style={{
          marginTop: '16px', paddingTop: '16px',
          borderTop: '1px solid var(--navy-border)',
          fontSize: '12px', color: 'var(--text-muted)'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span style={{ fontSize: '12px' }}>Balance</span>
            <span style={{ color: 'var(--accent)', fontFamily: 'DM Mono, monospace', fontSize: '15px', fontWeight: '700' }}>
              ${accountBalanceNum.toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
            <span style={{ fontSize: '12px' }}>Floating Balance</span>
            <span style={{ color: floatingBalanceNum >= accountBalanceNum ? 'var(--green)' : 'var(--red)', fontFamily: 'DM Mono, monospace', fontSize: '15px', fontWeight: '700' }}>
              ${floatingBalanceNum.toFixed(2)}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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
