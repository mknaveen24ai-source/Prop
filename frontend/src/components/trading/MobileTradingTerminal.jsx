import React, { useMemo, useState } from 'react'
import { ChevronDown, Star } from 'lucide-react'
import BottomSheet from '../ui/BottomSheet'
import TradingViewWidget from '../TradingViewWidget'
import SimulatedTradingDisclaimer from '../SimulatedTradingDisclaimer'
import Sparkline from '../ui/Sparkline'
import MobileOrderTicket from './MobileOrderTicket'
import MobilePositionCard from './MobilePositionCard'
import { MobileModifySheet, MobilePartialCloseSheet } from './MobileTradeActionSheet'
import useOrderTicket from './hooks/useOrderTicket'
import { getPriceDecimals } from '../../utils/instruments'
import { formatCurrency } from '../../utils/finance'

/**
 * The trading terminal, rebuilt for a phone.
 *
 * The desktop terminal is a three-column desk (watchlist rail | chart | order
 * panel). Stacking those columns is not enough: placing or closing a trade then
 * means scrolling away from the price, which is the whole complaint. So mobile
 * gets its own arrangement, the one every mobile broker converged on:
 *
 *   sticky price + risk header   — the number you are trading against, always visible
 *   full-bleed chart / pane      — one pane at a time, not a long scroll
 *   segmented switcher           — Chart · Positions · Orders · Watchlist
 *   pinned SELL / BUY bar        — the commit target, thumb-height, safe-area aware
 *   bottom-sheet ticket          — opens already committed to a direction
 *
 * Order logic is *not* reimplemented here — it comes from useOrderTicket, the
 * same hook the desktop OrderPanel renders. The two surfaces cannot drift.
 */

const PANES = [
  { id: 'chart', label: 'Chart' },
  { id: 'positions', label: 'Positions' },
  { id: 'orders', label: 'Orders' },
  { id: 'watchlist', label: 'Watchlist' },
]

/** Percent move across a buffered price history, or null when too short. */
function percentChange(history) {
  if (!history || history.length < 2) return null
  const first = history[0]?.value
  const last = history[history.length - 1]?.value
  if (!first || !last) return null
  return ((last - first) / first) * 100
}

export default function MobileTradingTerminal({
  // price + account
  prices,
  theme,
  selectedAccount,
  floatingBalance,
  floatingProfit,
  availableInstruments,
  // order entry
  orderForm,
  setOrderForm,
  handleOpenTrade,
  // positions
  openPositions,
  pendingOrders,
  closingTradeSet,
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
  onCancelOrder,
  // watchlist
  pinnedInstruments,
  priceHistory,
  isPinned,
  togglePin,
}) {
  const [pane, setPane] = useState('chart')
  const [ticketDirection, setTicketDirection] = useState(null)
  // The desktop marquee ticker is not rendered on mobile (18px chips, and a
  // permanent rAF loop), so instrument selection needs its own affordance.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')

  const ticket = useOrderTicket({
    prices,
    selectedAccount,
    floatingBalance,
    availableInstruments,
    onOpenTrade: handleOpenTrade,
    orderForm,
    setOrderForm,
  })

  const { instrument, bid, ask, canTrade, marketStatus } = ticket

  // Session change on the *selected* instrument, from the same buffered history
  // the watchlist rail uses — no extra subscription.
  //
  // Deliberately not memoised: `priceHistory` is useWatchlist's ref container,
  // which is mutated in place and so keeps the same object identity forever. A
  // useMemo keyed on it would compute once and then show a frozen percentage
  // for the life of the page. Two array lookups are cheaper than that bug.
  const changePct = percentChange(priceHistory?.[instrument])

  const equity = Number.isFinite(parseFloat(floatingBalance))
    ? parseFloat(floatingBalance)
    : parseFloat(selectedAccount?.current_balance || 0)

  const counts = { positions: openPositions.length, orders: pendingOrders.length }

  const pickerResults = useMemo(() => {
    const list = availableInstruments || []
    const q = query.trim().toUpperCase()
    return q ? list.filter((s) => s.includes(q)) : list
  }, [availableInstruments, query])

  const allTrades = useMemo(() => [...openPositions, ...pendingOrders], [openPositions, pendingOrders])
  const modifyingTrade = allTrades.find((t) => t.id === modifyingTradeId) || null
  const partialTrade = partialForm ? allTrades.find((t) => t.id === partialForm.id) || null : null

  return (
    <div className="mterm">
      {/* Header and pane switcher pin together as one block. Sticking them
          separately would mean hard-coding the header's height as the tabs'
          `top` offset — and that height changes with the symbol, the price
          length and the user's text size. */}
      <div className="mterm__chrome">
      {/* ── Sticky header: what you are trading, and what it is doing ───────── */}
      <header className="mterm__header">
        <div className="mterm__symbol-row">
          <button
            type="button"
            className="mterm__symbol-btn"
            aria-haspopup="dialog"
            onClick={() => { setQuery(''); setPickerOpen(true) }}
          >
            <span className="mterm__symbol">{instrument}</span>
            <ChevronDown size={16} color="var(--muted)" />
          </button>
          <button
            type="button"
            className="mterm__pin"
            aria-label={isPinned?.(instrument) ? `Unpin ${instrument}` : `Pin ${instrument} to watchlist`}
            aria-pressed={Boolean(isPinned?.(instrument))}
            onClick={() => togglePin?.(instrument)}
          >
            <Star size={16} fill={isPinned?.(instrument) ? 'var(--accent)' : 'none'} color="var(--accent)" />
          </button>
          {changePct != null && (
            <span
              className="mterm__change"
              style={{ color: changePct >= 0 ? 'var(--gain)' : 'var(--loss)' }}
            >
              {changePct >= 0 ? '▲' : '▼'} {Math.abs(changePct).toFixed(2)}%
            </span>
          )}
        </div>
        <div className="mterm__prices">
          <span className="mterm__price"><span>Bid</span> {bid}</span>
          <span className="mterm__price"><span>Ask</span> {ask}</span>
        </div>
        <div className="mterm__risk">
          <span><span>Equity</span> {formatCurrency(equity)}</span>
          <span style={{ color: floatingProfit >= 0 ? 'var(--gain)' : 'var(--loss)' }}>
            {/* signed:true, not a hand-rolled prefix — otherwise a loss reads
                "+-$12.30"/"$-12.30" depending on the branch. */}
            <span>Floating</span> {formatCurrency(floatingProfit, { signed: true })}
          </span>
        </div>
        {/* The market-closed reason used to be repeated here. It now lives with
            the commit bar instead — same information, at the point of action,
            and it keeps this permanently-pinned header to three compact rows. */}
      </header>

      {/* ── Pane switcher ──────────────────────────────────────────────────── */}
      <nav className="mterm__tabs" role="tablist" aria-label="Trading panes">
        {PANES.map((p) => (
          <button
            key={p.id}
            role="tab"
            type="button"
            aria-selected={pane === p.id}
            className="mterm__tab"
            onClick={() => setPane(p.id)}
          >
            {p.label}
            {counts[p.id] > 0 && <span className="mterm__tab-count">{counts[p.id]}</span>}
          </button>
        ))}
      </nav>
      </div>

      {/* ── Active pane ────────────────────────────────────────────────────── */}
      <div className="mterm__pane">
        {pane === 'chart' && (
          <div className="mterm__chart">
            {/* autosize:true on the widget — it fills whatever box it is given,
                so the box is sized in CSS from the viewport rather than pinned
                to a hardcoded pixel height. */}
            <TradingViewWidget symbol={instrument} theme={theme} />
          </div>
        )}

        {pane === 'positions' && (
          <div className="mterm__list">
            {openPositions.length === 0 ? (
              <p className="mterm__empty">No open positions. Use the BUY or SELL bar below to place one.</p>
            ) : openPositions.map((trade) => (
              <MobilePositionCard
                key={trade.id}
                trade={trade}
                dec={getPriceDecimals(trade.instrument)}
                isPending={false}
                isClosing={closingTradeSet.has(trade.id)}
                onModify={() => openModifyForm(trade)}
                onPartial={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}
                onClose={() => handleCloseTrade(trade)}
              />
            ))}
          </div>
        )}

        {pane === 'orders' && (
          <div className="mterm__list">
            {pendingOrders.length === 0 ? (
              <p className="mterm__empty">No pending orders.</p>
            ) : pendingOrders.map((trade) => (
              <MobilePositionCard
                key={trade.id}
                trade={trade}
                dec={getPriceDecimals(trade.instrument)}
                isPending
                isClosing={closingTradeSet.has(trade.id)}
                onModify={() => openModifyForm(trade)}
                onCancelOrder={() => onCancelOrder(trade.id)}
              />
            ))}
          </div>
        )}

        {pane === 'watchlist' && (
          <div className="mterm__list">
            {(!pinnedInstruments || pinnedInstruments.length === 0) ? (
              <p className="mterm__empty">
                Star an instrument from the header to pin it here.
              </p>
            ) : pinnedInstruments.map((symbol) => {
              const data = prices[symbol]
              const history = priceHistory?.[symbol] || []
              const pct = percentChange(history) ?? 0
              const tone = pct >= 0 ? 'var(--gain)' : 'var(--loss)'
              return (
                <button
                  key={symbol}
                  type="button"
                  className="mterm__watch-row"
                  aria-current={symbol === instrument ? 'true' : undefined}
                  onClick={() => {
                    setOrderForm((f) => ({ ...f, instrument: symbol, stop_loss: '', take_profit: '' }))
                    setPane('chart')
                  }}
                >
                  <span className="mterm__watch-symbol">{symbol}</span>
                  <span className="mterm__watch-price">
                    {data ? parseFloat(data.bid).toFixed(getPriceDecimals(symbol)) : '—'}
                  </span>
                  <span className="mterm__watch-change" style={{ color: tone }}>
                    {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                  </span>
                  <span className="mterm__watch-spark">
                    <Sparkline data={history} tone={tone} width={56} height={18} />
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <SimulatedTradingDisclaimer />

      {/* ── Commit bar. Pinned above the trader bottom nav, safe-area aware. ──
          When the bar is disabled it says why, right here. The reason also
          appears in the header, but the header is at the top of a scrolling
          page — a trader tapping a dead BUY button is looking at the bottom of
          the screen, not the top. */}
      {!canTrade && (
        <p className="mterm__actions-reason" role="status">
          {!selectedAccount
            ? 'Select an active account to trade.'
            : !marketStatus.open
              ? marketStatus.reason
              : 'Waiting for a live price on this instrument…'}
        </p>
      )}
      <div className="mterm__actions">
        <button
          type="button"
          className="mterm__action mterm__action--sell"
          disabled={!canTrade}
          onClick={() => setTicketDirection('sell')}
        >
          <span className="mterm__action-label">Sell</span>
          <span className="mterm__action-price">{bid}</span>
        </button>
        <button
          type="button"
          className="mterm__action mterm__action--buy"
          disabled={!canTrade}
          onClick={() => setTicketDirection('buy')}
        >
          <span className="mterm__action-label">Buy</span>
          <span className="mterm__action-price">{ask}</span>
        </button>
      </div>

      {/* Instrument picker */}
      <BottomSheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Select instrument"
        padded={false}
      >
        <div className="mterm__picker-search">
          <input
            className="input-field"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search instruments"
            aria-label="Search instruments"
          />
        </div>
        {pickerResults.length === 0 ? (
          <p className="mterm__empty">No instrument matches “{query}”.</p>
        ) : pickerResults.map((symbol) => {
          const data = prices[symbol]
          return (
            <button
              key={symbol}
              type="button"
              className="mterm__picker-row"
              aria-current={symbol === instrument ? 'true' : undefined}
              onClick={() => {
                setOrderForm((f) => ({ ...f, instrument: symbol, stop_loss: '', take_profit: '' }))
                setPickerOpen(false)
              }}
            >
              <span>{symbol}</span>
              <span className="mterm__picker-price">
                {data ? parseFloat(data.bid).toFixed(getPriceDecimals(symbol)) : '—'}
              </span>
            </button>
          )
        })}
      </BottomSheet>

      <MobileOrderTicket
        open={ticketDirection !== null}
        direction={ticketDirection || 'buy'}
        onClose={() => setTicketDirection(null)}
        ticket={ticket}
        orderForm={orderForm}
      />

      {/* Modify and partial-close are inline table rows on desktop; on mobile
          they get sheets so no capability is lost in card mode. */}
      <MobileModifySheet
        trade={modifyingTrade}
        open={Boolean(modifyingTrade)}
        onClose={cancelModify}
        modifyForm={modifyForm}
        setModifyForm={setModifyForm}
        modifyError={modifyError}
        modifySuccess={modifySuccess}
        submitModify={submitModify}
        moveTradeToBreakeven={moveTradeToBreakeven}
      />

      <MobilePartialCloseSheet
        trade={partialTrade}
        open={Boolean(partialTrade)}
        onClose={() => setPartialForm(null)}
        partialForm={partialForm}
        setPartialForm={setPartialForm}
        handlePartialClose={handlePartialClose}
        isClosing={partialTrade ? closingTradeSet.has(partialTrade.id) : false}
      />
    </div>
  )
}
