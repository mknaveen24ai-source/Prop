import React from 'react'
import BottomSheet from '../ui/BottomSheet'
import Button from '../ui/Button'
import { getInputStepString, getPriceDecimals } from '../../utils/instruments'

/**
 * Modify SL/TP (and pending entry) and partial-close, as bottom sheets.
 *
 * On desktop these are inline rows injected into the positions table with
 * colSpan=9. The mobile terminal renders positions as cards, so the same two
 * flows need a home — dropping them would quietly cost mobile traders the
 * ability to move a stop, which is the one thing you most need to do from a
 * phone. Handlers are the panel's own; this file is layout only.
 */

export function MobileModifySheet({
  trade, open, onClose,
  modifyForm, setModifyForm, modifyError, modifySuccess,
  submitModify, moveTradeToBreakeven,
}) {
  if (!trade) return null

  const dec = getPriceDecimals(trade.instrument)
  const step = getInputStepString(trade.instrument)
  const isPending = trade.status === 'pending'
  const reference = isPending ? trade.pending_price : trade.current_price
  const referenceLabel = reference ? parseFloat(reference).toFixed(dec) : '—'
  const hint = (multiplier) => (reference
    ? `e.g. ${(parseFloat(reference) * multiplier).toFixed(dec)}`
    : '—')
  const downHint = hint(trade.direction === 'buy' ? 0.999 : 1.001)
  const upHint = hint(trade.direction === 'buy' ? 1.001 : 0.999)

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`Modify ${trade.instrument}`}
      subtitle={`${isPending ? trade.order_type.replace(/_/g, ' ') : trade.direction} · ${isPending ? 'Target' : 'Current'} ${referenceLabel}`}
    >
      <div className="mticket">
        {isPending && (
          <div className="mticket__field">
            <label className="mticket__label" htmlFor="mmodify-entry">Pending price</label>
            <input
              id="mmodify-entry"
              className="input-field"
              type="number"
              inputMode="decimal"
              value={modifyForm.pending_price || ''}
              onChange={(e) => setModifyForm((f) => ({ ...f, pending_price: e.target.value }))}
              placeholder="Pending entry"
              step={step}
            />
          </div>
        )}

        <div className="mticket__field">
          <label className="mticket__label" htmlFor="mmodify-sl">
            Stop loss <span className="mticket__label-note">blank removes</span>
          </label>
          <input
            id="mmodify-sl"
            className="input-field"
            type="number"
            inputMode="decimal"
            value={modifyForm.stop_loss}
            onChange={(e) => setModifyForm((f) => ({ ...f, stop_loss: e.target.value }))}
            placeholder={downHint}
            step={step}
          />
        </div>

        <div className="mticket__field">
          <label className="mticket__label" htmlFor="mmodify-tp">
            Take profit <span className="mticket__label-note">blank removes</span>
          </label>
          <input
            id="mmodify-tp"
            className="input-field"
            type="number"
            inputMode="decimal"
            value={modifyForm.take_profit}
            onChange={(e) => setModifyForm((f) => ({ ...f, take_profit: e.target.value }))}
            placeholder={upHint}
            step={step}
          />
        </div>

        {modifyError && <p className="mticket__hint" role="alert">{modifyError}</p>}
        {modifySuccess && <p className="mticket__ok" role="status">{modifySuccess}</p>}

        <div className="mticket__buttons">
          {!isPending && (
            <Button variant="secondary" size="lg" onClick={() => moveTradeToBreakeven(trade)}>
              Move to breakeven
            </Button>
          )}
          <Button variant="primary" size="lg" onClick={() => submitModify(trade)}>
            Save changes
          </Button>
        </div>
      </div>
    </BottomSheet>
  )
}

export function MobilePartialCloseSheet({
  trade, open, onClose,
  partialForm, setPartialForm, handlePartialClose, isClosing,
}) {
  if (!trade) return null

  const currentLots = parseFloat(trade.lot_size)
  const maxCloseable = Math.max(currentLots - 0.01, 0.01).toFixed(2)

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={`Partial close ${trade.instrument}`}
      subtitle={`${currentLots.toFixed(2)} lots open`}
    >
      <div className="mticket">
        {/* Quick fractions first — they are the reason partial close exists, and
            they need no keypad. */}
        <div className="mticket__fractions">
          {[0.25, 0.5, 0.75].map((ratio) => {
            const closeLots = Math.floor(currentLots * ratio * 100) / 100
            const remaining = Math.round((currentLots - closeLots) * 100) / 100
            const invalid = closeLots < 0.01 || remaining < 0.01
            return (
              <button
                key={ratio}
                type="button"
                className="mticket__fraction"
                disabled={invalid || isClosing}
                onClick={() => handlePartialClose(trade.id, trade.lot_size, closeLots.toFixed(2))}
              >
                <span>{Math.round(ratio * 100)}%</span>
                <span className="mticket__fraction-lots">{closeLots.toFixed(2)} lots</span>
              </button>
            )
          })}
        </div>

        <div className="mticket__field">
          <label className="mticket__label" htmlFor="mpartial-lots">
            Or close an exact amount <span className="mticket__label-note">max {maxCloseable}</span>
          </label>
          <input
            id="mpartial-lots"
            className="input-field"
            type="number"
            inputMode="decimal"
            step="0.01"
            max={maxCloseable}
            value={partialForm?.val || ''}
            onChange={(e) => setPartialForm({ ...partialForm, val: e.target.value })}
            placeholder="0.01"
          />
        </div>

        <Button
          variant="danger"
          size="lg"
          full
          className="mticket__confirm"
          disabled={isClosing || !partialForm?.val}
          onClick={() => handlePartialClose(trade.id, trade.lot_size, partialForm.val)}
        >
          {isClosing ? 'Closing…' : 'Confirm partial close'}
        </Button>
      </div>
    </BottomSheet>
  )
}
