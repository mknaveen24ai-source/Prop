import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Card from './ui/Card'
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
  getInputStepString,
  getPriceDecimals,
} from '../utils/instruments'
import {
  calculateEquity,
  calculatePercent,
  calculateRealizedProfit,
  calculateTargetRemaining,
  sumMoney,
} from '../utils/finance'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../utils/accountVisibility'
import { getMemoryItem, setMemoryItem } from '../utils/memoryStore'
import Pagination from './Pagination'
import Button from './ui/Button'

const TRADING_SPLIT_MIN = 50
const TRADING_SPLIT_MAX = 85
const TRADING_SPLIT_DEFAULT = 70
const TRADING_SPLIT_STORAGE_KEY = 'tradingSplitPct'
const WATCHLIST_STORAGE_KEY = 'tradingWatchlist'

// ── Phase timer helpers ────────────────────────────────────────────────────────
function getTimeRemaining(endDateStr) {
  if (!endDateStr) return null
  const diff = new Date(endDateStr) - new Date()
  if (diff <= 0) return { expired: true, display: 'EXPIRED' }
  const days    = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours   = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diff % (1000 * 60)) / 1000)
  return {
    expired: false,
    days, hours, minutes, seconds,
    totalMs: diff,
    display: days > 0
      ? `${days}d ${hours}h ${minutes}m`
      : `${hours}h ${minutes}m ${seconds}s`,
    urgent: diff < 3 * 24 * 60 * 60 * 1000  // less than 3 days
  }
}

function formatBatchActionLabel(actionType) {
  if (actionType === 'close_winning') return 'Close Winners'
  if (actionType === 'close_losing') return 'Close Losers'
  if (actionType === 'breakeven_winning') return 'Breakeven Winners'
  return actionType.replace(/_/g, ' ')
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function buildBatchFeedback(actionType, data) {
  const skipped = data?.skipped || {}
  const details = []

  if (typeof data?.affected === 'number') details.push(`${data.affected} updated`)
  if (skipped.min_hold) details.push(`${skipped.min_hold} waiting for ${formatDuration(data?.minHoldSeconds || 0)} hold`)
  if (skipped.no_match) details.push(`${skipped.no_match} unmatched`)
  if (skipped.price_unavailable) details.push(`${skipped.price_unavailable} no live price`)
  if (skipped.locked) details.push(`${skipped.locked} busy`)

  return {
    type: data?.affected > 0 ? 'success' : 'warning',
    title: formatBatchActionLabel(actionType),
    message: data?.message || 'Batch action completed.',
    detail: details.join(' • ')
  }
}

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

const TradeRow = React.memo(function TradeRow({
  trade, dec, isPending, isModifying, isClosing,
  onToggleModify, onCancelOrder, onPartialClick, onClose
}) {
  return (
    <tr style={{ opacity: isPending ? 0.75 : 1 }}>
      <td style={{ fontWeight: '600' }}>
        {trade.instrument}
        {isPending && (
          <span style={{
            marginLeft: '6px', fontSize: '9px', padding: '2px 5px',
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
        <div className="trade-actions" style={{ display: 'flex', gap: '6px' }}>
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
  } = useStore()
  const { theme } = useTheme()
  const [positionView, setPositionView] = useState('all')
  const [partialForm, setPartialForm] = useState(null)
  const [batchActionPending, setBatchActionPending] = useState('')
  const [batchFeedback, setBatchFeedback] = useState(null)
  const [knownAvailableInstruments, setKnownAvailableInstruments] = useState([])

  // ── Resizable chart/order-panel split ──────────────────────────────────────
  const tradingLayoutRef = useRef(null)
  const [splitPct, setSplitPct] = useState(() => {
    const saved = parseFloat(getMemoryItem(TRADING_SPLIT_STORAGE_KEY))
    return Number.isFinite(saved) && saved >= TRADING_SPLIT_MIN && saved <= TRADING_SPLIT_MAX
      ? saved
      : TRADING_SPLIT_DEFAULT
  })

  const handleSplitDragStart = useCallback((e) => {
    e.preventDefault()
    const container = tradingLayoutRef.current
    if (!container) return
    const startX = e.clientX
    const startPct = splitPct
    const containerWidth = container.getBoundingClientRect().width

    function onMouseMove(moveEvent) {
      const deltaPct = ((moveEvent.clientX - startX) / containerWidth) * 100
      const nextPct = Math.max(TRADING_SPLIT_MIN, Math.min(TRADING_SPLIT_MAX, startPct + deltaPct))
      setSplitPct(nextPct)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setSplitPct((current) => {
        setMemoryItem(TRADING_SPLIT_STORAGE_KEY, String(Math.round(current)))
        return current
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitPct])

  // ── Watchlist (pinned instruments) ──────────────────────────────────────────
  const [pinnedInstruments, setPinnedInstruments] = useState(() => {
    try {
      const saved = JSON.parse(getMemoryItem(WATCHLIST_STORAGE_KEY) || '[]')
      return Array.isArray(saved) ? saved : []
    } catch {
      return []
    }
  })
  const togglePin = useCallback((instrument) => {
    setPinnedInstruments((current) => {
      const next = current.includes(instrument)
        ? current.filter((sym) => sym !== instrument)
        : [...current, instrument]
      setMemoryItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const prices = Object.keys(storePrices || {}).length > 0 ? storePrices : (propPrices || {})
  const liveAvailableInstruments = useMemo(() => getAvailableInstrumentList(prices), [prices])
  const closingTradeSet = useMemo(() => new Set(closingTradeIds), [closingTradeIds])
  const availableInstruments = knownAvailableInstruments.length > 0
    ? knownAvailableInstruments
    : liveAvailableInstruments
  const sortedInstruments = useMemo(() => {
    const pinnedSet = new Set(pinnedInstruments)
    return [...availableInstruments].sort((a, b) => (pinnedSet.has(b) ? 1 : 0) - (pinnedSet.has(a) ? 1 : 0))
  }, [availableInstruments, pinnedInstruments])

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
  const [priceStatus, setPriceStatus] = useState({ healthy: true, instruments: {} })

  // Fetch price feed status on mount
  useEffect(() => {
    async function fetchPriceStatus() {
      try {
        const res = await api.get('/api/price-status')
        setPriceStatus(res.data)
      } catch (err) {
        setPriceStatus({ healthy: false, message: 'Unable to check price feed status' })
      }
    }
    fetchPriceStatus()
    const interval = setInterval(fetchPriceStatus, 5000)
    return () => clearInterval(interval)
  }, [])

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

  // ── Live phase countdown timer ─────────────────────────────────────────────
  const [timeRemaining, setTimeRemaining] = useState(null)

  useEffect(() => {
    const endDate = selectedAccount?.phase_end_date
    const isFunded = selectedAccount?.account_type === 'funded'
    if (!endDate || isFunded) {
      setTimeRemaining(null)
      return
    }
    // Update immediately then every second
    setTimeRemaining(getTimeRemaining(endDate))
    const interval = setInterval(() => {
      setTimeRemaining(getTimeRemaining(endDate))
    }, 1000)
    return () => clearInterval(interval)
  }, [selectedAccount?.phase_end_date, selectedAccount?.account_type])

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


  const currentBalance = stats ? Number(stats.account?.current_balance || 0) : 0
  const floatingProfit = openTrades
    .filter(trade => trade.status === 'open')
    .reduce((sum, trade) => sumMoney([sum, trade.floating_pnl || 0]), 0)
  const floatingBalance = calculateEquity(currentBalance, floatingProfit)
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
        {[0, 1].flatMap(copy => sortedInstruments.map(instrument => {
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
                boxShadow:   isSelected ? '0 0 12px color-mix(in srgb, var(--muted) 20%, transparent)' : 'none',
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
        <div className='trading-layout' ref={tradingLayoutRef} style={{ '--trading-split': `${splitPct}%` }}>

          {/* Left — Chart + Positions */}
          <div className='trading-main-column'>

            {/* FIX Step 3: SimulatedTradingDisclaimer — shown above the chart on active accounts */}
            <SimulatedTradingDisclaimer />

            {/* Balance Bar */}
            {stats && (
              <div className='trading-stats-grid' style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginBottom: '16px', alignItems: 'stretch' }}>
                {[
                  { label: 'Balance', value: `$${currentBalance.toFixed(2)}` },
                  { label: 'Floating P&L', value: `${floatingProfit >= 0 ? '+' : ''}$${floatingProfit.toFixed(2)}`, color: floatingProfit >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: 'Floating Balance', value: `$${floatingBalance.toFixed(2)}`, color: floatingBalance >= currentBalance ? 'var(--green)' : 'var(--red)' },
                  { label: 'Profit',   value: `${stats.stats.profit_pct >= 0 ? '+' : ''}${stats.stats.profit_pct}%`, color: stats.stats.profit_pct >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: 'Drawdown', value: `-${stats.stats.drawdown_pct}%`, color: stats.stats.drawdown_pct > 7 ? 'var(--red)' : 'var(--accent)' },
                  { label: 'Days Left',value: stats.stats.days_remaining ?? '∞' },
                ].map(s => (
                  <div key={s.label} className="stat-card" style={{ padding: '14px 18px' }}>
                    <div className="stat-value" style={{ fontSize: '22px', fontWeight: '800', color: s.color || 'var(--accent)' }}>{s.value}</div>
                    <div className="stat-label">{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* ── Live Drawdown Warning Gauge ── */}

            {stats && profitTargetAmount > 0 && (
              <div style={{
                background: 'color-mix(in srgb, var(--muted) 6%, transparent)',
                border: '1px solid color-mix(in srgb, var(--muted) 24%, transparent)',
                padding: '10px 14px',
                marginBottom: '16px'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text)' }}>
                    Profit Target Progress
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {targetProgressPct.toFixed(1)}%
                  </div>
                </div>
                <div style={{ height: '8px', background: 'var(--navy-border)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${targetProgressPct}%`,
                    transition: 'width 0.5s ease',
                    background: targetProgressPct >= 100
                      ? 'var(--green)'
                      : targetProgressPct >= 75
                        ? 'var(--warn)'
                        : targetProgressPct >= 50
                          ? 'var(--accent)'
                          : 'var(--muted)'
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '11px' }}>
                  <span style={{ color: realizedProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    Realized: {realizedProfit >= 0 ? '+' : ''}${realizedProfit.toFixed(2)}
                  </span>
                  <span style={{ color: equityProfit >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    Equity: {equityProfit >= 0 ? '+' : ''}${equityProfit.toFixed(2)}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    Remaining: ${targetRemaining.toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            {stats && (() => {
              const drawdownPct    = parseFloat(stats.stats.drawdown_pct || 0)
              const maxDrawdownPct = parseFloat(stats.account.max_drawdown_pct || 10)
              const usedPct        = Math.min((drawdownPct / maxDrawdownPct) * 100, 100)
              const remaining      = Math.max(0, maxDrawdownPct - drawdownPct).toFixed(2)

              // Only show when drawdown > 0
              if (drawdownPct <= 0) return null

              const level = usedPct >= 90 ? 'critical' : usedPct >= 75 ? 'high' : usedPct >= 50 ? 'medium' : 'low'
              const levelColors = {
                critical: { bg: 'color-mix(in srgb, var(--loss) 15%, transparent)', border: 'var(--loss)', bar: 'var(--loss)', text: 'var(--loss)', icon: 'risk-alerts' },
                high:     { bg: 'color-mix(in srgb, var(--loss) 8%, transparent)', border: 'color-mix(in srgb, var(--warn) 40%, var(--loss) 60%)', bar: 'color-mix(in srgb, var(--warn) 40%, var(--loss) 60%)', text: 'color-mix(in srgb, var(--warn) 40%, var(--loss) 60%)', icon: 'warning' },
                medium:   { bg: 'color-mix(in srgb, var(--warn) 10%, transparent)', border: 'var(--warn)', bar: 'var(--warn)', text: 'var(--warn)', icon: 'analytics' },
                low:      { bg: 'color-mix(in srgb, var(--accent) 6%, transparent)', border: 'color-mix(in srgb, var(--accent) 30%, transparent)', bar: 'var(--accent)', text: 'var(--text-muted)', icon: 'floating_down' },
              }
              const c = levelColors[level]

              return (
                <div style={{
                  background: c.bg, border: `1px solid ${c.border}`,
                  padding: '10px 14px',
                  marginBottom: '16px'
                }}>
                  {/* Header row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span style={{ display: 'inline-flex' }}>
                        {renderIcon(c.icon, { size: 14, color: c.text })}
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: c.text }}>
                        Drawdown {level === 'critical' ? '— CRITICAL' : level === 'high' ? '— HIGH' : level === 'medium' ? '— WARNING' : ''}
                      </span>
                    </div>
                <div style={{ display: 'flex', gap: '16px', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                      <span style={{ color: c.text }}>Used: {drawdownPct.toFixed(2)}%</span>
                      <span style={{ color: 'var(--text-muted)' }}>Remaining: {remaining}%</span>
                      <span style={{ color: 'var(--text-dim)' }}>Limit: {maxDrawdownPct}%</span>
                    </div>
                  </div>

                  {/* Drawdown gauge bar */}
                  <div style={{ height: '6px', background: 'var(--navy-border)', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${usedPct}%`,
                      background: `linear-gradient(90deg, var(--accent), ${c.bar})`,
                      transition: 'width 0.5s ease',
                      boxShadow: level === 'critical' ? `0 0 8px ${c.bar}` : 'none'
                    }} />
                  </div>

                  {/* Critical message */}
                  {level === 'critical' && (
                    <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--red)', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {renderIcon('warning', { size: 12, color: 'var(--accent-red)' })}
                      <span>Account will fail if drawdown reaches {maxDrawdownPct}%. Close losing trades immediately.</span>
                    </div>
                  )}
                </div>
              )
            })()}


              <div style={{ width: '100%', height: '500px', marginBottom: '16px' }}>
                <TradingViewWidget symbol={orderForm.instrument} theme={theme} />
              </div>

            {/* ── Phase Countdown Timer ── */}
            {timeRemaining && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '10px 16px', marginBottom: '16px',
                background: timeRemaining.urgent
                  ? 'color-mix(in srgb, var(--muted) 12%, transparent)'
                  : 'color-mix(in srgb, var(--muted) 6%, transparent)',
                border: `1px solid ${timeRemaining.urgent ? 'var(--red)' : 'color-mix(in srgb, var(--muted) 25%, transparent)'}`
              }}>
                <span style={{ display: 'inline-flex' }}>
                  {renderIcon(
                    timeRemaining.expired ? 'timer' : timeRemaining.urgent ? 'warning' : 'timer',
                    {
                      size: 18,
                      color: timeRemaining.expired || timeRemaining.urgent ? 'var(--accent-red)' : 'var(--accent)'
                    }
                  )}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {selectedAccount.account_type.toUpperCase()} Phase Time Remaining
                  </div>
                  <div style={{
                    fontSize: '16px', fontWeight: '700',
                      fontFamily: 'var(--font-mono)',
                    color: timeRemaining.expired ? 'var(--red)'
                      : timeRemaining.urgent ? 'var(--red)'
                      : 'var(--accent)'
                  }}>
                    {timeRemaining.display}
                  </div>
                </div>
                {/* Mini progress bar for time used */}
                {!timeRemaining.expired && selectedAccount.phase_start_date && (
                  <div style={{ width: '80px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '4px', textAlign: 'right' }}>
                      {timeRemaining.days}d left
                    </div>
                    {(() => {
                      const total = new Date(selectedAccount.phase_end_date) - new Date(selectedAccount.phase_start_date)
                      const used  = new Date() - new Date(selectedAccount.phase_start_date)
                      const pct   = Math.min(Math.max((used / total) * 100, 0), 100)
                      return (
                        <div style={{ height: '4px', background: 'var(--navy-border)' }}>
                          <div style={{
                            height: '100%',
                            width: `${pct}%`,
                            background: pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--muted)' : 'var(--accent)',
                            transition: 'width 1s linear'
                          }} />
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
            <div className="trade-desk-stack">
            {openTrades.length > 0 && (
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
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
                          color: positionView === view.id ? 'var(--navy)' : 'var(--text-muted)',
                          boxShadow: positionView === view.id ? '0 10px 24px rgba(var(--brand-primary-rgb), 0.22)' : 'none'
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
                                  <div style={{ background: 'var(--navy-card)', border: '1px dashed var(--accent)', padding: '12px 16px', margin: '4px 0 8px 0', display: 'grid', gap: '10px' }}>
                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '12px', color: 'var(--text)' }}>Close Fraction (Current: {parseFloat(trade.lot_size).toFixed(2)}):</span>
                                      <input type="number" step="0.01" max={Math.max(parseFloat(trade.lot_size) - 0.01, 0.01).toFixed(2)} value={partialForm.val || ''} onChange={e => setPartialForm({ ...partialForm, val: e.target.value })} style={{ width: '80px', padding: '4px 8px', fontSize: '12px' }} />
                                      <button onClick={() => handlePartialClose(trade.id, trade.lot_size, partialForm.val)} disabled={closingTradeSet.has(trade.id)} className="btn btn-accent" style={{ padding: '4px 12px', fontSize: '11px', opacity: closingTradeSet.has(trade.id) ? 0.6 : 1, cursor: closingTradeSet.has(trade.id) ? 'not-allowed' : 'pointer' }}>{closingTradeSet.has(trade.id) ? 'Closing...' : 'Confirm Partial Close'}</button>
                                      <button onClick={() => setPartialForm(null)} className="btn" style={{ padding: '4px 12px', fontSize: '11px', background: 'transparent', border: '1px solid var(--navy-border)' }}>Cancel</button>
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
                                              fontSize: '11px',
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
                                  <div style={{ background: 'var(--navy-card)', border: '1px solid var(--accent)', padding: '16px', margin: '4px 0 8px 0' }}>
                                    <div style={{ fontSize: '12px', color: 'var(--accent)', marginBottom: '12px', fontWeight: '600' }}>
                                      Modify {trade.instrument} {trade.order_type.replace(/_/g, ' ').toUpperCase()} - Target: {trade.pending_price ? parseFloat(trade.pending_price).toFixed(dec) : '-'}
                                    </div>
                                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>Pending Price</label>
                                        <input
                                          type="number"
                                          value={modifyForm.pending_price || ''}
                                          onChange={e => setModifyForm(f => ({ ...f, pending_price: e.target.value }))}
                                          placeholder="Pending entry"
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Stop Loss <span style={{ color: 'var(--text-dim)' }}>(blank removes)</span>
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.stop_loss}
                                          onChange={e => setModifyForm(f => ({ ...f, stop_loss: e.target.value }))}
                                          placeholder={`e.g. ${trade.pending_price ? (parseFloat(trade.pending_price) * (trade.direction === 'buy' ? 0.999 : 1.001)).toFixed(dec) : '-'}`}
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Take Profit <span style={{ color: 'var(--text-dim)' }}>(blank removes)</span>
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.take_profit}
                                          onChange={e => setModifyForm(f => ({ ...f, take_profit: e.target.value }))}
                                          placeholder={`e.g. ${trade.pending_price ? (parseFloat(trade.pending_price) * (trade.direction === 'buy' ? 1.001 : 0.999)).toFixed(dec) : '-'}`}
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <button className="btn btn-accent" onClick={() => submitModify(trade)} style={{ padding: '7px 20px', fontSize: '12px' }}>
                                        Save
                                      </button>
                                      <button className="btn" onClick={cancelModify} style={{ padding: '7px 16px', fontSize: '12px', border: '1px solid var(--navy-border)' }}>
                                        Cancel
                                      </button>
                                    </div>
                                    {modifyError && (
                                      <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '8px' }}>{modifyError}</div>
                                    )}
                                    {modifySuccess && (
                                      <div style={{ color: 'var(--green)', fontSize: '12px', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
                                    padding: '16px',
                                    margin: '4px 0 8px 0'
                                  }}>
                                    <div style={{ fontSize: '12px', color: 'var(--accent)', marginBottom: '12px', fontWeight: '600' }}>
                                      ✏️ Modify {trade.instrument} {trade.direction.toUpperCase()} — Current Price:{' '}
                                      {trade.current_price ? parseFloat(trade.current_price).toFixed(dec) : '—'}
                                    </div>
                                    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Stop Loss <span style={{ color: 'var(--text-dim)' }}>(leave blank to remove)</span>
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.stop_loss}
                                          onChange={e => setModifyForm(f => ({ ...f, stop_loss: e.target.value }))}
                                          placeholder={`e.g. ${trade.current_price ? (parseFloat(trade.current_price) * (trade.direction === 'buy' ? 0.999 : 1.001)).toFixed(dec) : '—'}`}
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Take Profit <span style={{ color: 'var(--text-dim)' }}>(leave blank to remove)</span>
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.take_profit}
                                          onChange={e => setModifyForm(f => ({ ...f, take_profit: e.target.value }))}
                                          placeholder={`e.g. ${trade.current_price ? (parseFloat(trade.current_price) * (trade.direction === 'buy' ? 1.001 : 0.999)).toFixed(dec) : '—'}`}
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div style={{ display: 'flex', gap: '8px' }}>
                                        <button
                                          className="btn btn-accent"
                                          onClick={() => submitModify(trade)}
                                          style={{ padding: '7px 20px', fontSize: '12px' }}>
                                          Save
                                        </button>
                                        <button
                                          className="btn"
                                          onClick={() => moveTradeToBreakeven(trade)}
                                          style={{ padding: '7px 16px', fontSize: '12px', border: '1px solid var(--accent)', color: 'var(--accent)' }}>
                                          Move To BE
                                        </button>
                                        <button
                                          className="btn"
                                          onClick={cancelModify}
                                          style={{ padding: '7px 16px', fontSize: '12px', border: '1px solid var(--navy-border)' }}>
                                          Cancel
                                        </button>
                                      </div>
                                    </div>
                                    {modifyError && (
                                      <div style={{ color: 'var(--red)', fontSize: '12px', marginTop: '8px' }}>{modifyError}</div>
                                    )}
                                    {modifySuccess && (
                                      <div style={{ color: 'var(--green)', fontSize: '12px', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
            )}

            </div>
          </div>

          {/* Drag handle to resize chart/order-panel split */}
          <div
            className='trading-split-handle'
            onMouseDown={handleSplitDragStart}
            onDoubleClick={() => {
              setSplitPct(TRADING_SPLIT_DEFAULT)
              setMemoryItem(TRADING_SPLIT_STORAGE_KEY, String(TRADING_SPLIT_DEFAULT))
            }}
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

