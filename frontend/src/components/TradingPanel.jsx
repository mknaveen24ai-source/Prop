import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Card from './ui/Card'
import Sparkline from './ui/Sparkline'
import OrderPanel from './OrderPanel'
import TradingViewWidget from './TradingViewWidget'
import SimulatedTradingDisclaimer from './SimulatedTradingDisclaimer'
import RiskWarningBanner from './RiskWarningBanner'
import api from '../services/api'
import useStore from '../store/useStore'
import { useTheme } from '../ThemeContext'
import { renderIcon } from '../utils/iconMap'
import {
  getAvailableInstrumentList,
  formatPrice,
  INSTRUMENT_GROUPS,
} from '../utils/instruments'

// Shared by the ticker's flex gap and the marquee's wrap arithmetic — they have
// to agree or the loop drifts by a few pixels per revolution.
const SYMBOL_TICKER_GAP_PX = 8

/**
 * How many back-to-back copies of the symbol list the ticker must render for
 * the marquee to have somewhere to scroll.
 *
 * The marquee advances scrollLeft and wraps by one copy's width, which only
 * looks like motion while the rendered content is wider than the visible row.
 * Two copies were hardcoded, which held when the ticker carried all 45
 * instruments but not once it was narrowed to the tradable subset — one copy
 * then fits on screen and the row stops scrolling. Sizing to the container
 * guarantees overflow for any non-empty symbol list.
 *
 * Exported for test/documentation; the component uses it via useLayoutEffect.
 */
export function symbolTickerCopyCount(containerWidth, copyWidth) {
  if (!(copyWidth > 0)) return 2
  // +1 so the trailing copy still fills the viewport at the moment the loop
  // wraps, rather than exposing a gap at the right edge.
  return Math.max(2, Math.ceil(containerWidth / copyWidth) + 1)
}
import {
  calculateEquity,
  calculatePercent,
  calculateRealizedProfit,
  calculateTargetRemaining,
  sumMoney,
} from '../utils/finance'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../utils/accountVisibility'
import Pagination from './Pagination'
import PositionsPanel from './trading/PositionsPanel'
import MobileTradingTerminal from './trading/MobileTradingTerminal'
import useSplitPane from './trading/hooks/useSplitPane'
import useWatchlist from './trading/hooks/useWatchlist'
import usePriceFeedStatus from './trading/hooks/usePriceFeedStatus'
import { buildBatchFeedback, formatBatchActionLabel } from './trading/batchFeedback'
import { useIsMobile } from '../hooks/useBreakpoint'
import './trading/mobile-terminal.css'


export default function TradingPanel({
  prices: propPrices,
  selectedAccount: propSelectedAccount,
  accounts: propAccounts,
  setSelectedAccount: propSetSelectedAccount,
  openTrades: propOpenTrades,
  tradeHistory,
  orderForm,
  setOrderForm,
  onOpenTrade, onCloseTrade, closingTradeIds = [], onCancelOrder, getStatusColor, stats,
  onTradeModified, accountLoading
}) {
  const {
    prices: storePrices,
    openPositions: storeOpenPositions,
    activeAccount: storeActiveAccount,
    allAccounts: storeAccounts,
    setActiveAccount,
    liveEquity: liveEquityMap,
  } = useStore()
  const { theme } = useTheme()
  const [positionView, setPositionView] = useState('all')
  const [partialForm, setPartialForm] = useState(null)
  const [batchActionPending, setBatchActionPending] = useState('')
  const [batchFeedback, setBatchFeedback] = useState(null)
  const [knownAvailableInstruments, setKnownAvailableInstruments] = useState([])

  const { tradingLayoutRef, splitPct, handleSplitDragStart, resetSplit } = useSplitPane()

  // Below `md` the desk layout is replaced wholesale by MobileTradingTerminal —
  // stacking the three desktop columns still leaves the order ticket a scroll
  // away from the price, which is the thing that makes trading on a phone hard.
  const isMobile = useIsMobile()

  const prices = Object.keys(storePrices || {}).length > 0 ? storePrices : (propPrices || {})

  const liveAvailableInstruments = useMemo(() => getAvailableInstrumentList(prices), [prices])
  const closingTradeSet = useMemo(() => new Set(closingTradeIds), [closingTradeIds])
  const availableInstruments = knownAvailableInstruments.length > 0
    ? knownAvailableInstruments
    : liveAvailableInstruments
  const {
    pinnedInstruments,
    togglePin,
    tickerCategory,
    setTickerCategory,
    priceHistoryRef,
    tickerInstruments
  } = useWatchlist(prices, availableInstruments)

  // Only offer a category that has something in it. `availableInstruments` is
  // already narrowed to what the server will actually let you open, and two of
  // these groups survive that filter with nothing left — every FX minor is a
  // cross, and DE40/FRA40/EUSTX50 are all EUR-quoted — so those chips used to
  // select an empty ticker row.
  const symbolCategoryTabs = useMemo(() => {
    const ALL_TABS = [
      { key: 'all', label: 'All', color: 'var(--accent)' },
      { key: 'FOREX_MAJORS', label: 'FX Majors', color: 'var(--accent)' },
      { key: 'FOREX_MINORS', label: 'FX Minors', color: 'var(--accent)' },
      { key: 'COMMODITY_METALS', label: 'Metals', color: 'var(--accent-gold)' },
      { key: 'ENERGIES', label: 'Energies', color: 'var(--accent-gold)' },
      { key: 'INDICES_SPOT', label: 'Indices Spot', color: 'var(--accent-green)' },
      { key: 'INDICES_MAJOR', label: 'Indices Major', color: 'var(--accent-green)' },
    ]
    const available = new Set(availableInstruments)
    return ALL_TABS.filter((tab) => (
      tab.key === 'all' || (INSTRUMENT_GROUPS[tab.key] || []).some((symbol) => available.has(symbol))
    ))
  }, [availableInstruments])

  // If the selected category disappears (price feed narrowed, FX conversion
  // toggled), fall back to All rather than leaving the ticker empty.
  useEffect(() => {
    if (tickerCategory === 'all') return
    if (symbolCategoryTabs.some((tab) => tab.key === tickerCategory)) return
    setTickerCategory('all')
  }, [symbolCategoryTabs, tickerCategory, setTickerCategory])

  // ── Auto-scrolling symbol ticker ────────────────────────────────────────────
  const symbolRowRef = useRef(null)
  const symbolCopyRef = useRef(null)
  const symbolMarqueePausedRef = useRef(false)
  const symbolMarqueeResumeTimeoutRef = useRef(null)
  // Width of ONE copy of the symbol list, including its trailing gap. The loop
  // wraps on this rather than scrollWidth/2 (see below).
  const symbolCopyWidthRef = useRef(0)
  const [symbolCopyCount, setSymbolCopyCount] = useState(2)

  const pauseSymbolMarquee = useCallback(() => {
    symbolMarqueePausedRef.current = true
  }, [])

  const resumeSymbolMarquee = useCallback(() => {
    symbolMarqueePausedRef.current = false
  }, [])

  const resumeSymbolMarqueeDelayed = useCallback(() => {
    clearTimeout(symbolMarqueeResumeTimeoutRef.current)
    symbolMarqueeResumeTimeoutRef.current = setTimeout(() => {
      symbolMarqueePausedRef.current = false
    }, 1500)
  }, [])

  // How many back-to-back copies of the symbol list to render.
  //
  // This used to be a hardcoded two, and the loop only advanced while one copy
  // was wider than the container. That held when the ticker carried all 45
  // instruments, but it is now fed getTradableInstruments() — 14 USD-quoted
  // symbols unless VITE_FX_CONVERSION_ENABLED is on — and a category chip
  // narrows that to three or four. One copy then fits on screen, the overflow
  // test goes false, and the marquee silently stops. Sizing the copy count to
  // the container instead means it always overflows and always scrolls, however
  // few symbols survive filtering.
  useLayoutEffect(() => {
    const row = symbolRowRef.current
    const copy = symbolCopyRef.current
    if (!row || !copy) return undefined

    function measure() {
      const copyWidth = copy.getBoundingClientRect().width
      if (copyWidth <= 0) return
      // + the flex gap that follows this copy, so wrapping by exactly this
      // amount lands on the pixel-identical spot in the next copy.
      symbolCopyWidthRef.current = copyWidth + SYMBOL_TICKER_GAP_PX
      setSymbolCopyCount(symbolTickerCopyCount(row.clientWidth, symbolCopyWidthRef.current))
    }

    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(copy)
    return () => observer.disconnect()
  }, [tickerInstruments, symbolCopyCount])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frameId = null
    const SCROLL_SPEED_PX_PER_FRAME = 0.6

    function step() {
      const el = symbolRowRef.current
      const copyWidth = symbolCopyWidthRef.current
      if (el && copyWidth > 0 && !symbolMarqueePausedRef.current) {
        // Wrap on one measured copy rather than scrollWidth / copies: the
        // latter divides in the gaps *between* copies too, which is what put a
        // few pixels of visible jump into every loop.
        const next = el.scrollLeft + SCROLL_SPEED_PX_PER_FRAME
        el.scrollLeft = next >= copyWidth ? next - copyWidth : next
      }
      frameId = requestAnimationFrame(step)
    }

    // Re-read the preference instead of sampling it once at mount: previously a
    // machine with OS animations turned off got no marquee for the lifetime of
    // the page, even after the user turned them back on.
    function sync() {
      if (motionQuery.matches) {
        if (frameId !== null) cancelAnimationFrame(frameId)
        frameId = null
        return
      }
      if (frameId === null) frameId = requestAnimationFrame(step)
    }

    sync()
    motionQuery.addEventListener('change', sync)

    return () => {
      motionQuery.removeEventListener('change', sync)
      if (frameId !== null) cancelAnimationFrame(frameId)
      clearTimeout(symbolMarqueeResumeTimeoutRef.current)
    }
  }, [])
  const openTrades = storeOpenPositions.length > 0 ? storeOpenPositions : (propOpenTrades || [])
  const rawAccounts = storeAccounts.length > 0 ? storeAccounts : (propAccounts || [])
  const accounts = useMemo(() => filterVisibleTraderAccounts(rawAccounts), [rawAccounts])
  const selectedAccountCandidate = storeActiveAccount || propSelectedAccount
  const selectedAccount = selectedAccountCandidate && isTraderAccountVisible(selectedAccountCandidate)
    ? selectedAccountCandidate
    : accounts[0]
  const setSelectedAccount = useCallback((account) => {
    if (!account) return
    setActiveAccount(account)
    if (typeof propSetSelectedAccount === 'function') {
      propSetSelectedAccount(account)
    }
  }, [propSetSelectedAccount, setActiveAccount])

  async function handleBatchAction(actionType) {
    if (!window.confirm('Are you sure you want to execute batch action: ' + actionType.replace('_', ' ') + '?')) return
    try {
      setBatchActionPending(actionType)
      setBatchFeedback(null)
      const res = await api.post('/api/trades/batch-action', { action: actionType, account_id: selectedAccount.id })
      setBatchFeedback(buildBatchFeedback(actionType, res.data))
      if (onTradeModified && res.data?.affected > 0) onTradeModified()
    } catch (err) {
      setBatchFeedback({
        type: 'error',
        title: formatBatchActionLabel(actionType),
        message: err.response?.data?.error || 'Batch action failed',
        detail: ''
      })
    } finally {
      setBatchActionPending('')
    }
  }

  async function handlePartialClose(tradeId, currentLots, closeLots) {
    try {
      const closeLotsNum = parseFloat(closeLots)
      const currentLotsNum = parseFloat(currentLots)
      const remainingLotsNum = Math.round((currentLotsNum - closeLotsNum) * 100) / 100
      if (!closeLots || closeLotsNum <= 0 || closeLotsNum > currentLotsNum) return alert('Invalid lot fraction')
      if (remainingLotsNum < 0.01) return alert('Use Close for a full exit. Partial close must leave at least 0.01 lots open.')
      if (closingTradeSet.has(tradeId)) return
      const success = await onCloseTrade(tradeId, { closeLots: closeLotsNum })
      if (!success) return
      setPartialForm(null)
    } catch (err) {
      alert(err.response?.data?.error || 'Partial close failed')
    }
  }
  const [modifyingTradeId, setModifyingTradeId] = useState(null)
  const [modifyForm, setModifyForm] = useState({
    pending_price: '',
    stop_loss: '',
    take_profit: ''
  })
  const [modifyError, setModifyError] = useState('')
  const [modifySuccess, setModifySuccess] = useState('')
  const priceStatus = usePriceFeedStatus()

  useEffect(() => {
    setBatchFeedback(null)
    setBatchActionPending('')
  }, [selectedAccount?.id])

  useEffect(() => {
    if (liveAvailableInstruments.length > 0) {
      setKnownAvailableInstruments(liveAvailableInstruments)
    }
  }, [liveAvailableInstruments])

  useEffect(() => {
    if (!Array.isArray(availableInstruments) || availableInstruments.length === 0) return
    if (availableInstruments.includes(orderForm?.instrument)) return

    setOrderForm((current) => ({
      ...current,
      instrument: availableInstruments[0],
      stop_loss: '',
      take_profit: ''
    }))
  }, [availableInstruments, orderForm?.instrument, setOrderForm])


  function openModifyForm(trade) {
    setModifyingTradeId(trade.id)
    setModifyForm({
      pending_price: trade.pending_price ? parseFloat(trade.pending_price).toString() : '',
      stop_loss:   trade.stop_loss   ? parseFloat(trade.stop_loss).toString()   : '',
      take_profit: trade.take_profit ? parseFloat(trade.take_profit).toString() : ''
    })
    setModifyError('')
    setModifySuccess('')
  }

  function cancelModify() {
    setModifyingTradeId(null)
    setModifyForm({
      pending_price: '',
      stop_loss: '',
      take_profit: ''
    })
    setModifyError('')
    setModifySuccess('')
  }

  async function submitModify(trade) {
    try {
      setModifyError('')
      const payload = { trade_id: trade.id }
      if (trade.status === 'pending') {
        payload.pending_price = modifyForm.pending_price === '' ? undefined : parseFloat(modifyForm.pending_price)
      }
      payload.stop_loss   = modifyForm.stop_loss   === '' ? null : parseFloat(modifyForm.stop_loss)
      payload.take_profit = modifyForm.take_profit === '' ? null : parseFloat(modifyForm.take_profit)

      await api.patch(trade.status === 'pending' ? '/api/trades/modify-pending' : '/api/trades/modify', payload)

      setModifySuccess('Updated!')
      setTimeout(() => {
        setModifyingTradeId(null)
        setModifySuccess('')
        if (onTradeModified) onTradeModified()
      }, 1000)
    } catch (err) {
      setModifyError(err.response?.data?.error || 'Could not update trade')
    }
  }

  async function moveTradeToBreakeven(trade) {
    try {
      setModifyError('')
      await api.patch('/api/trades/modify', {
        trade_id: trade.id,
        move_to_breakeven: true
      })
      setModifySuccess('Moved to breakeven')
      setTimeout(() => {
        setModifySuccess('')
        if (onTradeModified) onTradeModified()
      }, 900)
    } catch (err) {
      setModifyError(err.response?.data?.error || 'Could not move trade to breakeven')
    }
  }

  async function handleCloseTrade(trade) {
    if (closingTradeSet.has(trade.id)) return
    await onCloseTrade(trade.id)
  }

  async function handleOpenTrade(payload) {
    await onOpenTrade(payload)
  }

  // Live equity pushed by the backend engine (ENGINE_MODE=event). Preferred
  // while fresh so the account bar and drawdown gauge move with the feed rather
  // than only on refetch; falls back to the locally-derived values under
  // ENGINE_MODE=interval or if pushes stop arriving.
  const pushedEquity = selectedAccount ? liveEquityMap[selectedAccount.id] : null
  const hasFreshPushedEquity = !!pushedEquity && (Date.now() - pushedEquity.received_at) < 5000

  const currentBalance = hasFreshPushedEquity
    ? Number(pushedEquity.current_balance || 0)
    : (stats ? Number(stats.account?.current_balance || 0) : 0)
  const derivedFloatingProfit = openTrades
    .filter(trade => trade.status === 'open')
    .reduce((sum, trade) => sumMoney([sum, trade.floating_pnl || 0]), 0)
  const floatingProfit = hasFreshPushedEquity
    ? Number(pushedEquity.floating_pnl || 0)
    : derivedFloatingProfit
  const floatingBalance = hasFreshPushedEquity
    ? Number(pushedEquity.equity || 0)
    : calculateEquity(currentBalance, floatingProfit)
  const startingBalance = stats ? Number(stats.account?.starting_balance || selectedAccount?.starting_balance || 0) : 0
  const profitTargetAmount = stats ? Number(stats.account?.profit_target || 0) : 0
  const realizedProfit = calculateRealizedProfit(currentBalance, startingBalance)
  const equityProfit = calculateRealizedProfit(floatingBalance, startingBalance)
  const targetProgressPct = calculatePercent(realizedProfit, profitTargetAmount, {
    clampMin: 0,
    clampMax: 100,
    decimalPlaces: 1
  })
  const targetRemaining = calculateTargetRemaining(profitTargetAmount, realizedProfit)
  const openPositions = openTrades.filter(trade => trade.status === 'open')
  const pendingOrders = openTrades.filter(trade => trade.status === 'pending')
  // Closed-trade log moved to the dedicated Trade History screen
  // (pages/DashboardTradeHistoryPage.jsx) — the prototype's Trade screen
  // itself only ever shows open positions alongside the order ticket.
  const visibleOpenTrades = positionView === 'open'
    ? openPositions
    : positionView === 'pending'
      ? pendingOrders
      : openTrades
  const priceStatusState = priceStatus?.status || (priceStatus?.healthy ? 'healthy' : 'unhealthy')
  const priceFeedLive = priceStatusState === 'healthy'
  const priceFeedDegraded = priceStatusState === 'degraded'
  const priceFeedColor = priceFeedLive ? 'var(--green)' : (priceFeedDegraded ? 'var(--warn)' : 'var(--red)')
  const priceFeedBackground = priceFeedLive
    ? 'var(--success-bg)'
    : (priceFeedDegraded ? 'var(--warning-bg)' : 'var(--danger-bg)')
  const priceFeedBorder = priceFeedLive
    ? 'var(--green)'
    : (priceFeedDegraded ? 'var(--warn)' : 'var(--red)')
  const priceFeedLabel = priceFeedLive ? 'Live' : (priceFeedDegraded ? 'Degraded' : 'Delayed')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-5)' }}>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 0, fontSize: 'var(--fs-3xl)' }}>
          Trading Terminal
        </h2>
        {/* Price Feed Status Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3-5)',
          background: priceFeedBackground,
          border: `1px solid ${priceFeedBorder}`,
          fontSize: 'var(--fs-sm)'
        }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: priceFeedColor,
            animation: priceFeedLive ? 'none' : 'pulse 1.5s infinite'
          }} />
          <span style={{ color: priceFeedColor, fontWeight: 500 }}>
            {`● ${priceFeedLabel}`}
          </span>
          {!priceFeedLive && priceStatus.message && (
            <span style={{ color: 'var(--text-muted)', marginLeft: 'var(--space-1)', fontSize: 'var(--fs-xs)' }}>
              {priceStatus.message}
            </span>
          )}
        </div>
      </div>

      {/* FIX Step 3: Risk warning banner — shown at top of trading terminal */}
      <RiskWarningBanner />

      {/* Account Selector */}
      {accounts.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-2-5)', marginBottom: 'var(--space-5)', flexWrap: 'wrap' }}>
          {accounts.map(acc => (
            <button key={acc.id} className={`btn ${selectedAccount?.id === acc.id ? '' : 'glass-panel'}`} onClick={() => setSelectedAccount(acc)}
              style={{
                background: selectedAccount?.id === acc.id ? 'var(--accent)' : undefined,
                color:      selectedAccount?.id === acc.id ? 'var(--navy)' : 'var(--text)',
                border: '1px solid var(--accent)',
                borderRadius: '0',
                fontSize: 'var(--fs-sm)',
                padding: 'var(--space-2) var(--space-3-5)'
              }}>
              {acc.account_type === 'competition' && acc.competition_title ? acc.competition_title.toUpperCase() : acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString()}
              <span style={{ marginLeft: 'var(--space-1-5)', fontSize: 'var(--fs-2xs)', color: selectedAccount?.id === acc.id ? 'var(--navy)' : getStatusColor(acc.status) }}>
                ● {acc.status.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Symbol Selector category filter chips.
          Desktop only: on a phone the ticker's 18px chips and its continuous
          requestAnimationFrame marquee are both wrong — the mobile terminal
          selects instruments through its own picker and watchlist pane, and
          skipping this subtree stops the rAF loop from running at all there. */}
      {!isMobile && (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' }}>
        {symbolCategoryTabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setTickerCategory(tab.key)}
            style={{
              padding: '3px 9px',
              fontSize: 'var(--fs-2xs)',
              fontWeight: 700,
              borderRadius: 'var(--radius-pill)',
              cursor: 'pointer',
              border: `1px solid ${tickerCategory === tab.key ? tab.color : 'var(--navy-border)'}`,
              background: tickerCategory === tab.key
                ? `color-mix(in srgb, ${tab.color} 15%, transparent)`
                : 'transparent',
              color: tickerCategory === tab.key ? tab.color : 'var(--text-muted)',
              transition: 'all 0.15s',
              letterSpacing: '0.04em'
            }}
          >{tab.label}</button>
        ))}
      </div>
      )}

      {/* Symbol Selector — auto-scrolling live ticker (pauses on hover/touch) */}
      {!isMobile && (
      <div
        ref={symbolRowRef}
        onMouseEnter={pauseSymbolMarquee}
        onMouseLeave={resumeSymbolMarquee}
        onTouchStart={pauseSymbolMarquee}
        onTouchEnd={resumeSymbolMarqueeDelayed}
        style={{
        display: 'flex',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        width: '100%',
        maxWidth: '100%',
        gap: `${SYMBOL_TICKER_GAP_PX}px`,
        marginBottom: 'var(--space-5)',
        paddingBottom: 'var(--space-1)'
      }}>
        {/* Rendered as N identical copies back-to-back so the auto-scroll loop
            can wrap on one copy's width with no visible jump. N is measured
            against the container (see the layout effect above) rather than
            fixed at two, so the row overflows — and therefore scrolls — even
            when a category filter leaves only three symbols. */}
        {Array.from({ length: symbolCopyCount }, (_, copy) => (
        <div
          key={`copy-${copy}`}
          ref={copy === 0 ? symbolCopyRef : undefined}
          style={{ display: 'flex', flexWrap: 'nowrap', gap: `${SYMBOL_TICKER_GAP_PX}px`, flexShrink: 0 }}
        >
        {tickerInstruments.map(instrument => {
          const data = prices[instrument]
          const isSelected = orderForm.instrument === instrument
          const isPinned = pinnedInstruments.includes(instrument)
          const bidText = data ? formatPrice(data.bid, instrument) : '--'
          const askText = data ? formatPrice(data.ask, instrument) : '--'
          return (
            <div
              key={`${instrument}-${copy}`}
              className="glass-panel"
              onClick={() => setOrderForm(f => ({ ...f, instrument, stop_loss: '', take_profit: '' }))}
              style={{
                border:      isSelected ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
                padding: 'var(--space-2-5) var(--space-3)',
                cursor:      'pointer',
                transition:  'all 0.15s',
                minHeight:   '78px',
                flexShrink:  0,
                minWidth:    '96px',
                position:    'relative'
              }}
            >
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); togglePin(instrument) }}
                aria-label={isPinned ? `Remove ${instrument} from watchlist` : `Add ${instrument} to watchlist`}
                title={isPinned ? 'Remove from watchlist' : 'Add to watchlist'}
                style={{
                  position: 'absolute', top: '4px', right: '4px',
                  background: 'transparent', border: 'none', padding: '2px',
                  cursor: 'pointer', display: 'flex', lineHeight: 0
                }}
              >
                {renderIcon('star', {
                  size: 12,
                  color: isPinned ? 'var(--accent)' : 'var(--text-dim)',
                  style: { fill: isPinned ? 'currentColor' : 'none' }
                })}
              </button>
              <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: 'var(--space-1)' }}>{instrument}</div>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                {bidText}
              </div>
              <div style={{ fontSize: 'var(--fs-2xs)', color: 'var(--text-dim)', marginTop: '2px' }}>
                {askText}
              </div>
            </div>
          )
        })}
        </div>
        ))}
      </div>
      )}

      {/* No account yet */}
      {accounts.length === 0 && (
        <Card style={{ textAlign: 'center', padding: 'var(--space-9)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
            {renderIcon('trade', { size: 48, color: 'var(--accent)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: 'var(--space-3)' }}>No Trading Account</h3>
          <p style={{ color: 'var(--text-muted)' }}>Go to Dashboard to create your challenge account first.</p>
        </Card>
      )}

      {/* Locked account */}
      {selectedAccount?.status === 'locked' && (
        <Card style={{ textAlign: 'center', padding: 'var(--space-7)', border: '1px solid var(--muted)', marginBottom: 'var(--space-5)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-3)' }}>
            {renderIcon('lock', { size: 40, color: 'var(--text-secondary)' })}
          </div>
          <h3 style={{ color: 'var(--muted)', marginBottom: 'var(--space-2)' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support.</p>
        </Card>
      )}

      {/* Loading state */}
      {accountLoading && (
        <div style={{ textAlign: 'center', padding: 'var(--space-8)', color: 'var(--text-muted)', fontSize: 'var(--fs-md)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 'var(--space-2)' }}>
          {renderIcon('timer', { size: 16, color: 'var(--text-secondary)' })}
          <span>Loading account data...</span>
        </div>
      )}

      {/* Main Trading Layout — active accounts only.
          Mobile gets its own terminal; the desk below is the desktop layout. */}
      {!accountLoading && selectedAccount && selectedAccount.status === 'active' && isMobile && (
        <MobileTradingTerminal
          prices={prices}
          theme={theme}
          selectedAccount={selectedAccount}
          floatingBalance={floatingBalance}
          floatingProfit={floatingProfit}
          availableInstruments={availableInstruments}
          orderForm={orderForm}
          setOrderForm={setOrderForm}
          handleOpenTrade={handleOpenTrade}
          openPositions={openPositions}
          pendingOrders={pendingOrders}
          closingTradeSet={closingTradeSet}
          handleCloseTrade={handleCloseTrade}
          handlePartialClose={handlePartialClose}
          partialForm={partialForm}
          setPartialForm={setPartialForm}
          modifyingTradeId={modifyingTradeId}
          modifyForm={modifyForm}
          setModifyForm={setModifyForm}
          modifyError={modifyError}
          modifySuccess={modifySuccess}
          openModifyForm={openModifyForm}
          cancelModify={cancelModify}
          submitModify={submitModify}
          moveTradeToBreakeven={moveTradeToBreakeven}
          onCancelOrder={onCancelOrder}
          pinnedInstruments={pinnedInstruments}
          priceHistory={priceHistoryRef.current}
          isPinned={(symbol) => pinnedInstruments.includes(symbol)}
          togglePin={togglePin}
        />
      )}

      {!accountLoading && selectedAccount && selectedAccount.status === 'active' && !isMobile && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
          {/* Watchlist rail (Modern Gazette handoff spec, isTrade block): pinned
              instruments with live price + sparkline. Added alongside the
              existing resizable chart/order-panel split, not replacing it —
              the ⭐ toggle on the symbol ticker below already pins instruments
              here. */}
          <div className="watchlist-rail" style={{ width: '212px', flex: '0 0 212px', position: 'sticky', top: '84px', maxHeight: '500px' }}>
            <Card ruled flush title="Watchlist" style={{ display: 'flex', flexDirection: 'column', maxHeight: '500px' }}>
              <div style={{ overflowY: 'auto' }}>
                {pinnedInstruments.length === 0 ? (
                  <div style={{ padding: 'var(--space-3-5) var(--space-4)', fontSize: '11.5px', color: 'var(--muted)', lineHeight: 1.5 }}>
                    Star an instrument below to pin it here.
                  </div>
                ) : pinnedInstruments.map((instrument) => {
                  const data = prices[instrument]
                  const isSelected = orderForm.instrument === instrument
                  const history = priceHistoryRef.current[instrument] || []
                  const first = history[0]?.value
                  const last = history[history.length - 1]?.value
                  const changePct = first ? ((last - first) / first) * 100 : 0
                  const tone = changePct >= 0 ? 'var(--gain)' : 'var(--loss)'
                  return (
                    <button
                      key={instrument}
                      onClick={() => setOrderForm((f) => ({ ...f, instrument, stop_loss: '', take_profit: '' }))}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)', width: '100%',
                        padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--rule-soft)',
                        background: isSelected ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 'var(--fs-base)', color: 'var(--ink)' }}>{instrument}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: 'var(--muted)', marginTop: '2px' }}>
                          {data ? formatPrice(data.bid, instrument) : '—'}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '11.5px', color: tone }}>{changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%</div>
                        <div style={{ width: '52px', height: '18px', marginTop: '3px' }}>
                          <Sparkline data={history} tone={tone} width={52} height={18} />
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            </Card>
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
        <div className='trading-layout' ref={tradingLayoutRef} style={{ '--trading-split': `${splitPct}%` }}>

          {/* Left — Chart + Positions */}
          <div className='trading-main-column'>

            {/* FIX Step 3: SimulatedTradingDisclaimer — shown above the chart on active accounts */}
            <SimulatedTradingDisclaimer />

            {/* Balance grid, profit-target progress, drawdown gauge, and phase
                countdown timer were removed here (Modern Gazette handoff
                spec: the prototype's Trade screen is watchlist + chart +
                open positions + order ticket only — no risk dashboard).
                This same information lives on the Dashboard's Risk Budget
                block and Rules' Live Status card instead of being
                duplicated here. */}
              {/* .trading-chart-shell (App.css) sizes this fluidly —
                  clamp(340px, 52vw, 480px) with a tablet step-down. It replaces
                  a hardcoded inline 500px, which no media query could reach. */}
              <div className="trading-chart-shell">
                <TradingViewWidget symbol={orderForm.instrument} theme={theme} />
              </div>
            <div className="trade-desk-stack">
            <PositionsPanel
              openTrades={openTrades}
              openPositions={openPositions}
              pendingOrders={pendingOrders}
              visibleOpenTrades={visibleOpenTrades}
              floatingProfit={floatingProfit}
              closingTradeSet={closingTradeSet}
              positionView={positionView}
              setPositionView={setPositionView}
              batchFeedback={batchFeedback}
              setBatchFeedback={setBatchFeedback}
              batchActionPending={batchActionPending}
              handleBatchAction={handleBatchAction}
              handleCloseTrade={handleCloseTrade}
              handlePartialClose={handlePartialClose}
              partialForm={partialForm}
              setPartialForm={setPartialForm}
              modifyingTradeId={modifyingTradeId}
              modifyForm={modifyForm}
              setModifyForm={setModifyForm}
              modifyError={modifyError}
              modifySuccess={modifySuccess}
              openModifyForm={openModifyForm}
              cancelModify={cancelModify}
              submitModify={submitModify}
              moveTradeToBreakeven={moveTradeToBreakeven}
              onCancelOrder={onCancelOrder}
            />

            </div>

          </div>

          {/* Drag handle to resize chart/order-panel split */}
          <div
            className='trading-split-handle'
            onMouseDown={handleSplitDragStart}
            onDoubleClick={resetSplit}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chart and order panel columns (double-click to reset)"
          />

          {/* Right — Order Panel */}
          <div className='trading-side-column order-panel-sticky'>
            <OrderPanel
              prices={prices}
              selectedAccount={selectedAccount}
              floatingBalance={floatingBalance}
              availableInstruments={availableInstruments}
              onOpenTrade={handleOpenTrade}
              orderForm={orderForm}
              setOrderForm={setOrderForm}
            />
          </div>
        </div>
          </div>
        </div>
      )}

      {/* Passed / Failed / Expired account message */}
      {!accountLoading && selectedAccount && ['passed', 'failed', 'expired'].includes(selectedAccount.status) && (
        <Card style={{
          textAlign: 'center', padding: 'var(--space-9)',
          border: `1px solid ${selectedAccount.status === 'passed' ? 'var(--green)' : 'var(--red)'}`
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-4)' }}>
            {renderIcon(
              selectedAccount.status === 'passed'
                ? 'leaderboard'
                : selectedAccount.status === 'expired'
                  ? 'timer'
                  : 'reject',
              {
                size: 48,
                color: selectedAccount.status === 'passed' ? 'var(--accent-gold)' : 'var(--accent-red)'
              }
            )}
          </div>
          <h3 style={{ color: selectedAccount.status === 'passed' ? 'var(--green)' : 'var(--red)', marginBottom: 'var(--space-3)' }}>
            {selectedAccount.status === 'passed'  && 'Challenge Passed!'}
            {selectedAccount.status === 'failed'  && 'Challenge Failed'}
            {selectedAccount.status === 'expired' && 'Challenge Expired'}
          </h3>
          <p style={{ color: 'var(--text-muted)' }}>
            {selectedAccount.status === 'passed'  && 'Congratulations! Your funded account will be activated shortly.'}
            {selectedAccount.status === 'failed'  && 'You have breached the drawdown limit. Start a new challenge from the Dashboard.'}
            {selectedAccount.status === 'expired' && 'You did not reach the profit target within 30 days. Start a new challenge from the Dashboard.'}
          </p>
        </Card>
      )}
    </div>
  )
}

