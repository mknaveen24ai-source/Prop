import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
} from '../utils/instruments'
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
import useSplitPane from './trading/hooks/useSplitPane'
import useWatchlist from './trading/hooks/useWatchlist'
import usePriceFeedStatus from './trading/hooks/usePriceFeedStatus'
import { buildBatchFeedback, formatBatchActionLabel } from './trading/batchFeedback'


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

  // ── Auto-scrolling symbol ticker ────────────────────────────────────────────
  const symbolRowRef = useRef(null)
  const symbolMarqueePausedRef = useRef(false)
  const symbolMarqueeResumeTimeoutRef = useRef(null)

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

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined

    let frameId
    const SCROLL_SPEED_PX_PER_FRAME = 0.6

    function step() {
      const el = symbolRowRef.current
      if (el && !symbolMarqueePausedRef.current) {
        // The symbol list is rendered twice back-to-back (see the symbol row
        // below), so scrollWidth covers both copies — halfWidth is exactly
        // one copy's width. Subtracting it (instead of resetting to 0) once
        // scrollLeft crosses that point lands on the pixel-identical spot in
        // the second copy, so the loop has no visible jump.
        const halfWidth = el.scrollWidth / 2
        if (halfWidth > el.clientWidth) {
          const next = el.scrollLeft + SCROLL_SPEED_PX_PER_FRAME
          el.scrollLeft = next >= halfWidth ? next - halfWidth : next
        }
      }
      frameId = requestAnimationFrame(step)
    }
    frameId = requestAnimationFrame(step)

    return () => {
      cancelAnimationFrame(frameId)
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
      <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: 0, fontSize: '22px' }}>
          Trading Terminal
        </h2>
        {/* Price Feed Status Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 14px',
          background: priceFeedBackground,
          border: `1px solid ${priceFeedBorder}`,
          fontSize: '12px'
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
            <span style={{ color: 'var(--text-muted)', marginLeft: '4px', fontSize: '11px' }}>
              {priceStatus.message}
            </span>
          )}
        </div>
      </div>

      {/* FIX Step 3: Risk warning banner — shown at top of trading terminal */}
      <RiskWarningBanner />

      {/* Account Selector */}
      {accounts.length > 0 && (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', flexWrap: 'wrap' }}>
          {accounts.map(acc => (
            <button key={acc.id} className={`btn ${selectedAccount?.id === acc.id ? '' : 'glass-panel'}`} onClick={() => setSelectedAccount(acc)}
              style={{
                background: selectedAccount?.id === acc.id ? 'var(--accent)' : undefined,
                color:      selectedAccount?.id === acc.id ? 'var(--navy)' : 'var(--text)',
                border: '1px solid var(--accent)',
                borderRadius: '0',
                fontSize: '12px',
                padding: '8px 14px'
              }}>
              {acc.account_type === 'competition' && acc.competition_title ? acc.competition_title.toUpperCase() : acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString()}
              <span style={{ marginLeft: '6px', fontSize: '10px', color: selectedAccount?.id === acc.id ? 'var(--navy)' : getStatusColor(acc.status) }}>
                ● {acc.status.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Symbol Selector category filter chips */}
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
            onClick={() => setTickerCategory(tab.key)}
            style={{
              padding: '3px 9px',
              fontSize: '10px',
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

      {/* Symbol Selector — auto-scrolling live ticker (pauses on hover/touch) */}
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
        gap: '8px',
        marginBottom: '20px',
        paddingBottom: '4px'
      }}>
        {/* Rendered twice back-to-back so the auto-scroll loop can reset at the
            halfway point with no visible jump — see the rAF loop above. */}
        {[0, 1].flatMap(copy => tickerInstruments.map(instrument => {
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
                padding:     '10px 12px',
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
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: '4px' }}>{instrument}</div>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                {bidText}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                {askText}
              </div>
            </div>
          )
        }))}
      </div>

      {/* No account yet */}
      {accounts.length === 0 && (
        <Card style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('trade', { size: 48, color: 'var(--accent)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Trading Account</h3>
          <p style={{ color: 'var(--text-muted)' }}>Go to Dashboard to create your challenge account first.</p>
        </Card>
      )}

      {/* Locked account */}
      {selectedAccount?.status === 'locked' && (
        <Card style={{ textAlign: 'center', padding: '32px', border: '1px solid var(--muted)', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
            {renderIcon('lock', { size: 40, color: 'var(--text-secondary)' })}
          </div>
          <h3 style={{ color: 'var(--muted)', marginBottom: '8px' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support.</p>
        </Card>
      )}

      {/* Loading state */}
      {accountLoading && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
          {renderIcon('timer', { size: 16, color: 'var(--text-secondary)' })}
          <span>Loading account data...</span>
        </div>
      )}

      {/* Main Trading Layout — active accounts only */}
      {!accountLoading && selectedAccount && selectedAccount.status === 'active' && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '16px' }}>
          {/* Watchlist rail (Modern Gazette handoff spec, isTrade block): pinned
              instruments with live price + sparkline. Added alongside the
              existing resizable chart/order-panel split, not replacing it —
              the ⭐ toggle on the symbol ticker below already pins instruments
              here. */}
          <div className="watchlist-rail" style={{ width: '212px', flex: '0 0 212px', position: 'sticky', top: '84px', maxHeight: '500px' }}>
            <Card ruled flush title="Watchlist" style={{ display: 'flex', flexDirection: 'column', maxHeight: '500px' }}>
              <div style={{ overflowY: 'auto' }}>
                {pinnedInstruments.length === 0 ? (
                  <div style={{ padding: '14px 16px', fontSize: '11.5px', color: 'var(--muted)', lineHeight: 1.5 }}>
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
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', width: '100%',
                        padding: '9px 14px', border: 'none', borderBottom: '1px solid var(--rule-soft)',
                        background: isSelected ? 'var(--accent-dim)' : 'transparent', cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '13px', color: 'var(--ink)' }}>{instrument}</div>
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
              <div style={{ width: '100%', height: '500px', marginBottom: '16px' }}>
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
          textAlign: 'center', padding: '48px',
          border: `1px solid ${selectedAccount.status === 'passed' ? 'var(--green)' : 'var(--red)'}`
        }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
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
          <h3 style={{ color: selectedAccount.status === 'passed' ? 'var(--green)' : 'var(--red)', marginBottom: '12px' }}>
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

