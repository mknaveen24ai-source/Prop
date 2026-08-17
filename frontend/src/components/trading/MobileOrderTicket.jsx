import React, { useEffect, useMemo } from 'react'
import BottomSheet from '../ui/BottomSheet'
import Button from '../ui/Button'
import { formatCurrency } from '../../utils/finance'

/**
 * Mobile order ticket — the bottom-sheet counterpart to the desktop
 * OrderPanel. Both are pure views over useOrderTicket, so they place identical
 * orders; only the layout differs.
 *
 * Design notes that matter on a phone specifically:
 *  - The sheet opens already committed to a direction (the trader tapped BUY or
 *    SELL), so the destructive choice is made on a 56px target with the live
 *    price next to it, not inside a form.
 *  - Lots get a stepper. Typing "0.10" on a numeric keypad while a position is
 *    moving is the slowest possible interaction.
 *  - Risk/reward is stated in currency, above the confirm button, so the trader
 *    reads what they are risking on the same screen as the commit.
 */

const LOT_STEP = 0.01
const LOT_MIN = 0.01

function stepLots(current, delta) {
  const parsed = parseFloat(current)
  const base = Number.isFinite(parsed) ? parsed : 0
  const next = Math.max(LOT_MIN, Math.round((base + delta) * 100) / 100)
  return next.toFixed(2)
}

export default function MobileOrderTicket({ open, direction, onClose, ticket, orderForm }) {
  const {
    instrument, step, bid, ask, spread,
    updateForm, rrSummary, canTrade, marketStatus,
    isSubmitting, handleMarketOrder,
    orderMode, setOrderMode,
    pendingType, setPendingType,
    pendingPrice, setPendingPrice,
    handlePendingOrder,
  } = ticket

  const isBuy = direction === 'buy'
  const tone = isBuy ? 'var(--green)' : 'var(--red)'
  const entry = isBuy ? ask : bid
  const lotsValid = parseFloat(orderForm.lots) >= LOT_MIN
  const isPending = orderMode === 'pending'

  // The sheet is opened from the SELL/BUY bar, so the direction is already
  // decided. Only the two pending types matching that direction are offered —
  // showing all four would let the trader silently flip the side they tapped.
  // Memoised because the effect below depends on it, and a fresh array every
  // render (prices tick constantly here) would re-run it on every tick.
  const pendingChoices = useMemo(() => (isBuy
    ? [
        { value: 'buy_limit', label: 'Buy Limit', hint: `Below ${ask}` },
        { value: 'buy_stop', label: 'Buy Stop', hint: `Above ${ask}` },
      ]
    : [
        { value: 'sell_limit', label: 'Sell Limit', hint: `Above ${bid}` },
        { value: 'sell_stop', label: 'Sell Stop', hint: `Below ${bid}` },
      ]), [isBuy, ask, bid])

  // Keep the selected pending type on the side the trader committed to.
  useEffect(() => {
    if (!open) return
    if (!pendingChoices.some((c) => c.value === pendingType)) {
      setPendingType(pendingChoices[0].value)
    }
  }, [open, pendingType, pendingChoices, setPendingType])

  const pendingPriceValid = parseFloat(pendingPrice) > 0
  const canSubmit = canTrade && lotsValid && !isSubmitting && (!isPending || pendingPriceValid)

  async function confirm() {
    if (isPending) await handlePendingOrder()
    else await handleMarketOrder(direction)
    onClose()
  }

  const activeChoice = pendingChoices.find((c) => c.value === pendingType) || pendingChoices[0]

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`${isBuy ? 'Buy' : 'Sell'} ${instrument}`}
      subtitle={`${isBuy ? 'Ask' : 'Bid'} ${entry} · Spread ${spread}`}
    >
      <div className="mticket">
        {!marketStatus.open && (
          <p className="mticket__closed" role="status">
            <strong>Market closed.</strong> {marketStatus.reason}
          </p>
        )}

        {/* Market vs pending. Desktop has this as a Button pair in the side
            panel; without it here a phone could only ever place market orders,
            which is the one capability the mobile terminal was missing. */}
        <div className="mticket__modes" role="tablist" aria-label="Order type">
          {[
            { id: 'market', label: 'Market' },
            { id: 'pending', label: 'Pending' },
          ].map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={orderMode === m.id}
              className="mticket__mode"
              onClick={() => setOrderMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>

        {isPending && (
          <>
            <div className="mticket__types">
              {pendingChoices.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className="mticket__type"
                  aria-pressed={pendingType === c.value}
                  onClick={() => setPendingType(c.value)}
                >
                  <span className="mticket__type-label">{c.label}</span>
                  <span className="mticket__type-hint">{c.hint}</span>
                </button>
              ))}
            </div>

            <div className="mticket__field">
              <label className="mticket__label" htmlFor="mticket-trigger">
                Trigger price <span className="mticket__label-note">{activeChoice.hint.toLowerCase()}</span>
              </label>
              <input
                id="mticket-trigger"
                className="input-field"
                type="number"
                inputMode="decimal"
                value={pendingPrice}
                onChange={(e) => setPendingPrice(e.target.value)}
                placeholder={entry}
                step={step}
              />
            </div>

            <label className="mticket__check">
              <input
                type="checkbox"
                checked={Boolean(orderForm.oco_enabled)}
                onChange={(e) => updateForm({ oco_enabled: e.target.checked })}
              />
              <span>Add an OCO sibling order</span>
            </label>

            {orderForm.oco_enabled && (
              <div className="mticket__row">
                <div className="mticket__field">
                  <label className="mticket__label" htmlFor="mticket-oco-type">OCO type</label>
                  <select
                    id="mticket-oco-type"
                    className="select-field"
                    value={orderForm.oco_order_type || ''}
                    onChange={(e) => updateForm({ oco_order_type: e.target.value })}
                  >
                    <option value="">Select…</option>
                    <option value="buy_limit">Buy Limit</option>
                    <option value="sell_limit">Sell Limit</option>
                    <option value="buy_stop">Buy Stop</option>
                    <option value="sell_stop">Sell Stop</option>
                  </select>
                </div>
                <div className="mticket__field">
                  <label className="mticket__label" htmlFor="mticket-oco-price">OCO price</label>
                  <input
                    id="mticket-oco-price"
                    className="input-field"
                    type="number"
                    inputMode="decimal"
                    value={orderForm.oco_pending_price || ''}
                    onChange={(e) => updateForm({ oco_pending_price: e.target.value })}
                    placeholder={entry}
                    step={step}
                  />
                </div>
              </div>
            )}
          </>
        )}

        <label className="mticket__label" htmlFor="mticket-lots">Lot size</label>
        <div className="mticket__stepper">
          <button
            type="button"
            className="mticket__step"
            aria-label="Decrease lot size"
            onClick={() => updateForm({ lots: stepLots(orderForm.lots, -LOT_STEP) })}
          >
            −
          </button>
          <input
            id="mticket-lots"
            className="input-field mticket__lots"
            type="number"
            inputMode="decimal"
            value={orderForm.lots}
            onChange={(e) => updateForm({ lots: e.target.value })}
            min={LOT_MIN}
            step={LOT_STEP}
            placeholder="0.01"
          />
          <button
            type="button"
            className="mticket__step"
            aria-label="Increase lot size"
            onClick={() => updateForm({ lots: stepLots(orderForm.lots, LOT_STEP) })}
          >
            +
          </button>
        </div>

        <div className="mticket__row">
          <div className="mticket__field">
            <label className="mticket__label" htmlFor="mticket-sl">Stop loss</label>
            <input
              id="mticket-sl"
              className="input-field"
              type="number"
              inputMode="decimal"
              value={orderForm.stop_loss}
              onChange={(e) => updateForm({ stop_loss: e.target.value })}
              placeholder="Optional"
              step={step}
            />
          </div>
          <div className="mticket__field">
            <label className="mticket__label" htmlFor="mticket-tp">Take profit</label>
            <input
              id="mticket-tp"
              className="input-field"
              type="number"
              inputMode="decimal"
              value={orderForm.take_profit}
              onChange={(e) => updateForm({ take_profit: e.target.value })}
              placeholder="Optional"
              step={step}
            />
          </div>
        </div>

        {rrSummary && (
          <dl className="mticket__rr">
            <div>
              <dt>Risk</dt>
              <dd style={{ color: 'var(--red)' }}>
                {rrSummary.riskUSD != null ? `−${formatCurrency(rrSummary.riskUSD)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Reward</dt>
              <dd style={{ color: 'var(--green)' }}>
                {rrSummary.rewardUSD != null ? `+${formatCurrency(rrSummary.rewardUSD)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>R:R</dt>
              <dd>{rrSummary.rr != null ? `1:${rrSummary.rr}` : '—'}</dd>
            </div>
          </dl>
        )}

        <Button
          variant="primary"
          size="lg"
          full
          className="mticket__confirm"
          style={{ background: tone, borderColor: tone, color: 'var(--paper)' }}
          disabled={!canSubmit}
          onClick={confirm}
        >
          {isSubmitting
            ? 'Placing…'
            : isPending
              ? `Place ${activeChoice.label} ${lotsValid ? parseFloat(orderForm.lots).toFixed(2) : ''}`.trim()
              : `Confirm ${isBuy ? 'BUY' : 'SELL'} ${lotsValid ? parseFloat(orderForm.lots).toFixed(2) : ''}`.trim()}
        </Button>

        {!lotsValid && (
          <p className="mticket__hint">Lot size must be at least {LOT_MIN.toFixed(2)}.</p>
        )}
        {isPending && lotsValid && !pendingPriceValid && (
          <p className="mticket__hint">Enter a trigger price to place this order.</p>
        )}
      </div>
    </BottomSheet>
  )
}
