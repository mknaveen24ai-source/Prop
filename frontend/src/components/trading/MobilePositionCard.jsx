import React, { useState } from 'react'
import Button from '../ui/Button'
import { formatCurrency } from '../../utils/finance'

/**
 * One open position or pending order, as a card.
 *
 * The desktop table has nine nowrap columns and needs ~735px; on a 375px phone
 * that is a 107px window onto a two-axis scroll region nested inside a
 * vertically scrolling page — the classic iOS scroll-capture trap. A card
 * carries the same nine fields without any horizontal scroll at all.
 *
 * Close is a two-tap confirm rather than a modal: closing a position is
 * irreversible, and a mis-tap on a phone is far likelier than on a mouse.
 */

function areEqual(prev, next) {
  if (prev.isPending !== next.isPending) return false
  if (prev.isClosing !== next.isClosing) return false
  if (prev.dec !== next.dec) return false
  const a = prev.trade
  const b = next.trade
  return (
    a.id === b.id &&
    a.status === b.status &&
    a.current_price === b.current_price &&
    a.floating_pnl === b.floating_pnl &&
    a.stop_loss === b.stop_loss &&
    a.take_profit === b.take_profit &&
    a.pending_price === b.pending_price &&
    a.lot_size === b.lot_size
  )
}

function Figure({ label, value, tone }) {
  return (
    <div className="mtrade-card__figure">
      <div className="mtrade-card__figure-label">{label}</div>
      <div className="mtrade-card__figure-value" style={tone ? { color: tone } : undefined}>
        {value}
      </div>
    </div>
  )
}

export default React.memo(function MobilePositionCard({
  trade, dec, isPending, isClosing,
  onModify, onPartial, onClose, onCancelOrder,
}) {
  const [confirmingClose, setConfirmingClose] = useState(false)

  const pnl = trade.floating_pnl ?? 0
  const isUp = pnl >= 0
  const directionLabel = isPending
    ? trade.order_type.replace(/_/g, ' ').toUpperCase()
    : trade.direction.toUpperCase()
  const directionTone = trade.direction === 'buy' ? 'var(--green)' : 'var(--red)'
  const fmt = (v) => (v != null && v !== '' ? parseFloat(v).toFixed(dec) : '—')

  return (
    <article className="mtrade-card" style={{ opacity: isPending ? 0.8 : 1 }}>
      <header className="mtrade-card__head">
        <div className="mtrade-card__ident">
          <span className="mtrade-card__symbol">{trade.instrument}</span>
          <span className="mtrade-card__direction" style={{ color: directionTone }}>
            {directionLabel}
          </span>
          <span className="mtrade-card__lots">{parseFloat(trade.lot_size).toFixed(2)} lots</span>
        </div>
        {/* P&L always carries an explicit +/- sign, never colour alone.
            formatCurrency puts the sign before the currency symbol and adds
            thousands separators — hand-rolling it produced "$-1234.56". */}
        <div
          className="mtrade-card__pnl"
          style={{ color: isPending ? 'var(--text-muted)' : (isUp ? 'var(--green)' : 'var(--red)') }}
        >
          {isPending ? '—' : formatCurrency(pnl, { signed: true })}
        </div>
      </header>

      <div className="mtrade-card__figures">
        <Figure label={isPending ? 'Trigger' : 'Entry'} value={fmt(isPending ? trade.pending_price : trade.open_price)} />
        <Figure label="Current" value={isPending ? '—' : fmt(trade.current_price)} tone="var(--accent)" />
        <Figure label="Stop loss" value={fmt(trade.stop_loss)} tone="var(--red)" />
        <Figure label="Take profit" value={fmt(trade.take_profit)} tone="var(--green)" />
      </div>

      <footer className="mtrade-card__actions">
        {isPending ? (
          <>
            <Button variant="secondary" size="sm" onClick={onModify}>Modify</Button>
            <Button variant="danger" size="sm" onClick={onCancelOrder}>Cancel order</Button>
          </>
        ) : confirmingClose ? (
          <>
            <span className="mtrade-card__confirm-label">Close this position?</span>
            <Button variant="secondary" size="sm" onClick={() => setConfirmingClose(false)}>
              Keep
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={isClosing}
              onClick={() => { setConfirmingClose(false); onClose() }}
            >
              {isClosing ? 'Closing…' : 'Confirm close'}
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onModify}>Modify</Button>
            <Button variant="secondary" size="sm" onClick={onPartial}>Partial</Button>
            <Button
              variant="danger"
              size="sm"
              disabled={isClosing}
              onClick={() => setConfirmingClose(true)}
            >
              {isClosing ? 'Closing…' : 'Close'}
            </Button>
          </>
        )}
      </footer>
    </article>
  )
}, areEqual)
