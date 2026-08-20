import React from 'react'
import Card from '../ui/Card'
import Button from '../ui/Button'
import { getInputStepString, getPriceDecimals } from '../../utils/instruments'
import { renderIcon } from '../../utils/iconMap'
import TradeRow from './TradeRow'

// The 'Open Positions & Orders' card: batch actions, the open/pending filter,
// and the positions table with its inline modify and partial-close forms.
//
// Split out of TradingPanel, which carried this ~300-line block inline. The
// prop list is wide because the block genuinely reads that much of the panel's
// state; the win is that TradingPanel no longer has to render it.
export default function PositionsPanel({
  openTrades,
  openPositions,
  pendingOrders,
  visibleOpenTrades,
  floatingProfit,
  closingTradeSet,
  positionView,
  setPositionView,
  batchFeedback,
  setBatchFeedback,
  batchActionPending,
  handleBatchAction,
  handleCloseTrade,
  handlePartialClose,
  partialForm,
  setPartialForm,
  modifyingTradeId,
  modifyForm,
  setModifyForm,
  modifyError,
  modifySuccess,
  openModifyForm,
  cancelModify,
  submitModify,
  moveTradeToBreakeven,
  onCancelOrder
}) {
  if (openTrades.length === 0) return null

  return (
    <Card className="trade-section-card">
      <div className="trade-section-pills" style={{ marginBottom: '14px' }}>
        <span className="trade-summary-pill">{openPositions.length} Open</span>
        <span className="trade-summary-pill">{pendingOrders.length} Pending</span>
        <span className="trade-summary-pill" style={{ color: floatingProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {floatingProfit >= 0 ? '+' : ''}${floatingProfit.toFixed(2)} Floating
        </span>
      </div>
      {batchFeedback && (
        <div className={`trade-feedback trade-feedback-${batchFeedback.type}`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
            <div>
              <div className="trade-feedback-title">{batchFeedback.title}</div>
              <div className="trade-feedback-message">{batchFeedback.message}</div>
            </div>
            <button type="button" className="trade-feedback-dismiss" onClick={() => setBatchFeedback(null)}>
              Dismiss
            </button>
          </div>
          {batchFeedback.detail && <div className="trade-feedback-detail">{batchFeedback.detail}</div>}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <h3 style={{ marginBottom: 0, color: 'var(--accent)', fontSize: '15px' }}>
            Open Positions & Orders ({visibleOpenTrades.length})
          </h3>
          <div className="trade-batch-actions">
            <button
              onClick={() => handleBatchAction('close_winning')}
              className="btn trade-action-btn trade-action-btn-success"
              disabled={!!batchActionPending}
            >
              {batchActionPending === 'close_winning' ? 'Closing Winners...' : 'Close Winners'}
            </button>
            <button
              onClick={() => handleBatchAction('close_losing')}
              className="btn trade-action-btn trade-action-btn-danger"
              disabled={!!batchActionPending}
            >
              {batchActionPending === 'close_losing' ? 'Closing Losers...' : 'Close Losers'}
            </button>
            <button
              onClick={() => handleBatchAction('breakeven_winning')}
              className="btn trade-action-btn trade-action-btn-accent"
              disabled={!!batchActionPending}
            >
              {batchActionPending === 'breakeven_winning' ? 'Moving To Breakeven...' : 'Breakeven Winners'}
            </button>
          </div>
        </div>
        <div className="terminal-filter-group">
          {[
            { id: 'all', label: `All (${openTrades.length})` },
            { id: 'open', label: `Open (${openPositions.length})` },
            { id: 'pending', label: `Pending (${pendingOrders.length})` }
          ].map(view => (
            <button
              key={view.id}
              onClick={() => setPositionView(view.id)}
              className="terminal-filter-btn"
              style={{
                background: positionView === view.id ? 'var(--accent)' : 'var(--navy-card)',
                color: positionView === view.id ? 'var(--navy)' : 'var(--text-muted)'
              }}
            >
              {view.label}
            </button>
          ))}
        </div>
      </div>
      <div className="trade-batch-hint">
        Batch close follows your trading rules, including minimum hold time and live market availability.
      </div>
      <div className="table-wrapper trading-table-wrapper trading-table-wrapper--open">
        <table className="data-table trading-table">
          <thead>
            <tr>
              <th>Symbol</th><th>Type</th><th>Lots</th><th>Open / Target</th>
              <th>Current</th><th>SL</th><th>TP</th><th>P&L</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleOpenTrades.map(trade => {
              const dec = getPriceDecimals(trade.instrument)
              const isPending  = trade.status === 'pending'
              const isModifying = modifyingTradeId === trade.id

              return (
                <React.Fragment key={trade.id}>
                  <TradeRow
                    trade={trade}
                    dec={dec}
                    isPending={isPending}
                    isModifying={isModifying}
                    isClosing={closingTradeSet.has(trade.id)}
                    onToggleModify={() => isModifying ? cancelModify() : openModifyForm(trade)}
                    onCancelOrder={() => onCancelOrder(trade.id)}
                    onPartialClick={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}
                    onClose={() => handleCloseTrade(trade)}
                  />

                  {/* Inline Partial Close Form */}
                  {!isPending && partialForm?.id === trade.id && (
                    <tr>
                      <td colSpan="9" style={{ padding: '0' }}>
                        <div style={{ background: 'var(--navy-card)', border: '1px dashed var(--accent)', padding: 'var(--space-3) var(--space-4)', margin: '4px 0 8px 0', display: 'grid', gap: '10px' }}>
                          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>Close Fraction (Current: {parseFloat(trade.lot_size).toFixed(2)}):</span>
                            <input type="number" step="0.01" max={Math.max(parseFloat(trade.lot_size) - 0.01, 0.01).toFixed(2)} value={partialForm.val || ''} onChange={e => setPartialForm({ ...partialForm, val: e.target.value })} style={{ width: '80px', padding: 'var(--space-1) var(--space-2)', fontSize: 'var(--fs-sm)' }} />
                            <button onClick={() => handlePartialClose(trade.id, trade.lot_size, partialForm.val)} disabled={closingTradeSet.has(trade.id)} className="btn btn-accent" style={{ padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--fs-xs)', opacity: closingTradeSet.has(trade.id) ? 0.6 : 1, cursor: closingTradeSet.has(trade.id) ? 'not-allowed' : 'pointer' }}>{closingTradeSet.has(trade.id) ? 'Closing...' : 'Confirm Partial Close'}</button>
                            <Button variant="secondary" size="sm" onClick={() => setPartialForm(null)}>Cancel</Button>
                          </div>
                          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
                            {[0.25, 0.5, 0.75].map((ratio) => {
                              const currentLots = parseFloat(trade.lot_size)
                              const closeLots = Math.floor(currentLots * ratio * 100) / 100
                              const remainingLots = Math.round((currentLots - closeLots) * 100) / 100
                              const invalid = closeLots < 0.01 || remainingLots < 0.01
                              return (
                                <button
                                  key={ratio}
                                  type="button"
                                  disabled={invalid || closingTradeSet.has(trade.id)}
                                  onClick={() => handlePartialClose(trade.id, trade.lot_size, closeLots.toFixed(2))}
                                  style={{
                                    padding: '6px 10px',
                                    borderRadius: 'var(--radius-pill)',
                                    border: '1px solid var(--navy-border)',
                                    background: invalid || closingTradeSet.has(trade.id) ? 'var(--glass)' : 'rgba(var(--brand-primary-rgb),0.08)',
                                    color: invalid || closingTradeSet.has(trade.id) ? 'var(--text-dim)' : 'var(--accent)',
                                    cursor: invalid || closingTradeSet.has(trade.id) ? 'not-allowed' : 'pointer',
                                    fontSize: 'var(--fs-xs)',
                                    fontWeight: '700'
                                  }}
                                >
                                  Close {Math.round(ratio * 100)}%
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}

                  {isPending && isModifying && (
                    <tr>
                      <td colSpan="9" style={{ padding: '0' }}>
                        <div style={{ background: 'var(--navy-card)', border: '1px solid var(--accent)', padding: 'var(--space-4)', margin: '4px 0 8px 0' }}>
                          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--accent)', marginBottom: 'var(--space-3)', fontWeight: '600' }}>
                            Modify {trade.instrument} {trade.order_type.replace(/_/g, ' ').toUpperCase()} - Target: {trade.pending_price ? parseFloat(trade.pending_price).toFixed(dec) : '-'}
                          </div>
                          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <div>
                              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)' }}>Pending Price</label>
                              <input
                                type="number"
                                value={modifyForm.pending_price || ''}
                                onChange={e => setModifyForm(f => ({ ...f, pending_price: e.target.value }))}
                                placeholder="Pending entry"
                                step={getInputStepString(trade.instrument)}
                                style={{ width: '140px', fontSize: 'var(--fs-base)', padding: '7px 10px' }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)' }}>
                                Stop Loss <span style={{ color: 'var(--text-dim)' }}>(blank removes)</span>
                              </label>
                              <input
                                type="number"
                                value={modifyForm.stop_loss}
                                onChange={e => setModifyForm(f => ({ ...f, stop_loss: e.target.value }))}
                                placeholder={`e.g. ${trade.pending_price ? (parseFloat(trade.pending_price) * (trade.direction === 'buy' ? 0.999 : 1.001)).toFixed(dec) : '-'}`}
                                step={getInputStepString(trade.instrument)}
                                style={{ width: '140px', fontSize: 'var(--fs-base)', padding: '7px 10px' }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)' }}>
                                Take Profit <span style={{ color: 'var(--text-dim)' }}>(blank removes)</span>
                              </label>
                              <input
                                type="number"
                                value={modifyForm.take_profit}
                                onChange={e => setModifyForm(f => ({ ...f, take_profit: e.target.value }))}
                                placeholder={`e.g. ${trade.pending_price ? (parseFloat(trade.pending_price) * (trade.direction === 'buy' ? 1.001 : 0.999)).toFixed(dec) : '-'}`}
                                step={getInputStepString(trade.instrument)}
                                style={{ width: '140px', fontSize: 'var(--fs-base)', padding: '7px 10px' }}
                              />
                            </div>
                            <button className="btn btn-accent" onClick={() => submitModify(trade)} style={{ padding: '7px 20px', fontSize: 'var(--fs-sm)' }}>
                              Save
                            </button>
                            <Button variant="secondary" size="sm" onClick={cancelModify}>Cancel</Button>
                          </div>
                          {modifyError && (
                            <div style={{ color: 'var(--red)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)' }}>{modifyError}</div>
                          )}
                          {modifySuccess && (
                            <div style={{ color: 'var(--green)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {renderIcon('approve', { size: 12, color: 'var(--accent-green)' })}
                              <span>{modifySuccess}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}

                  {/* Inline Modify SL/TP Form */}
                  {!isPending && isModifying && (
                    <tr>
                      <td colSpan="9" style={{ padding: '0' }}>
                        <div style={{
                          background: 'var(--navy-card)',
                          border: '1px solid var(--accent)',
                          borderRadius: '0',
                          padding: 'var(--space-4)',
                          margin: '4px 0 8px 0'
                        }}>
                          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--accent)', marginBottom: 'var(--space-3)', fontWeight: '600' }}>
                            ✏️ Modify {trade.instrument} {trade.direction.toUpperCase()} — Current Price:{' '}
                            {trade.current_price ? parseFloat(trade.current_price).toFixed(dec) : '—'}
                          </div>
                          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                            <div>
                              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)' }}>
                                Stop Loss <span style={{ color: 'var(--text-dim)' }}>(leave blank to remove)</span>
                              </label>
                              <input
                                type="number"
                                value={modifyForm.stop_loss}
                                onChange={e => setModifyForm(f => ({ ...f, stop_loss: e.target.value }))}
                                placeholder={`e.g. ${trade.current_price ? (parseFloat(trade.current_price) * (trade.direction === 'buy' ? 0.999 : 1.001)).toFixed(dec) : '—'}`}
                                step={getInputStepString(trade.instrument)}
                                style={{ width: '140px', fontSize: 'var(--fs-base)', padding: '7px 10px' }}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 'var(--space-1)' }}>
                                Take Profit <span style={{ color: 'var(--text-dim)' }}>(leave blank to remove)</span>
                              </label>
                              <input
                                type="number"
                                value={modifyForm.take_profit}
                                onChange={e => setModifyForm(f => ({ ...f, take_profit: e.target.value }))}
                                placeholder={`e.g. ${trade.current_price ? (parseFloat(trade.current_price) * (trade.direction === 'buy' ? 1.001 : 0.999)).toFixed(dec) : '—'}`}
                                step={getInputStepString(trade.instrument)}
                                style={{ width: '140px', fontSize: 'var(--fs-base)', padding: '7px 10px' }}
                              />
                            </div>
                            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                              <button
                                className="btn btn-accent"
                                onClick={() => submitModify(trade)}
                                style={{ padding: '7px 20px', fontSize: 'var(--fs-sm)' }}>
                                Save
                              </button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => moveTradeToBreakeven(trade)}
                                style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
                                Move To BE
                              </Button>
                              <Button variant="secondary" size="sm" onClick={cancelModify}>Cancel</Button>
                            </div>
                          </div>
                          {modifyError && (
                            <div style={{ color: 'var(--red)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)' }}>{modifyError}</div>
                          )}
                          {modifySuccess && (
                            <div style={{ color: 'var(--green)', fontSize: 'var(--fs-sm)', marginTop: 'var(--space-2)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {renderIcon('approve', { size: 12, color: 'var(--accent-green)' })}
                              <span>{modifySuccess}</span>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              )
            })}
            {visibleOpenTrades.length === 0 && (
              <tr>
                <td colSpan="9" style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '22px 10px' }}>
                  {positionView === 'open' && 'No open positions right now.'}
                  {positionView === 'pending' && 'No pending orders right now.'}
                  {positionView === 'all' && 'No active positions or orders right now.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
