import React from 'react'
import Button from '../ui/Button'

// Memoized so a price tick affecting one instrument doesn't force every open
// trade's row to re-render — only re-renders when this specific trade's own
// price-derived/editable fields (or its pending action state) actually change.
function areTradeRowPropsEqual(prev, next) {
  if (prev.isPending !== next.isPending) return false
  if (prev.isModifying !== next.isModifying) return false
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

export default React.memo(function TradeRow({
  trade, dec, isPending, isModifying, isClosing,
  onToggleModify, onCancelOrder, onPartialClick, onClose
}) {
  return (
    <tr style={{ opacity: isPending ? 0.75 : 1 }}>
      <td style={{ fontWeight: '600' }}>
        {trade.instrument}
        {isPending && (
          <span style={{
            marginLeft: '6px', fontSize: 'var(--fs-3xs)', padding: '2px 5px',
            background: 'color-mix(in srgb, var(--muted) 15%, transparent)', border: '1px solid var(--accent)',
            color: 'var(--accent)', verticalAlign: 'middle'
          }}>
            PENDING
          </span>
        )}
      </td>
      <td style={{ color: trade.direction === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: '600' }}>
        {isPending
          ? trade.order_type.replace(/_/g, ' ').toUpperCase()
          : trade.direction.toUpperCase()
        }
      </td>
      <td>{parseFloat(trade.lot_size).toFixed(2)}</td>
      <td>
        {isPending
          ? (trade.pending_price ? parseFloat(trade.pending_price).toFixed(dec) : '—')
          : (trade.open_price != null ? parseFloat(trade.open_price).toFixed(dec) : '—')
        }
      </td>
      <td style={{ color: 'var(--accent)' }}>
        {isPending ? '—' : (trade.current_price ? parseFloat(trade.current_price).toFixed(dec) : '—')}
      </td>
      <td style={{ color: 'var(--red)' }}>
        {trade.stop_loss ? parseFloat(trade.stop_loss).toFixed(dec) : '—'}
      </td>
      <td style={{ color: 'var(--green)' }}>
        {trade.take_profit ? parseFloat(trade.take_profit).toFixed(dec) : '—'}
      </td>
      <td style={{
        color: isPending
          ? 'var(--text-muted)'
          : ((trade.floating_pnl ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'),
        fontWeight: 'bold'
      }}>
        {isPending
          ? '—'
          : `${(trade.floating_pnl ?? 0) >= 0 ? '+' : ''}$${(trade.floating_pnl ?? 0).toFixed(2)}`
        }
      </td>
      <td>
        <div className="trade-actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {isPending ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={onToggleModify}
              >
                {isModifying ? 'Cancel' : 'Modify'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onCancelOrder}
              >
                Cancel Order
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={onToggleModify}
              >
                {isModifying ? 'Cancel' : 'Modify'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={onPartialClick}
              >
                Partial
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={onClose}
                disabled={isClosing}
              >
                {isClosing ? 'Closing...' : 'Close'}
              </Button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}, areTradeRowPropsEqual)
