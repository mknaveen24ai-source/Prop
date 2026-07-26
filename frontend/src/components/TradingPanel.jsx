import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import OrderPanel from './OrderPanel'
import SimulatedTradingDisclaimer from './SimulatedTradingDisclaimer'
import RiskWarningBanner from './RiskWarningBanner'
import api from '../services/api'
import useStore from '../store/useStore'
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
import Pagination from './Pagination'
import Button from './ui/Button'

const MultiChartGrid = lazy(() => import('./MultiChartGrid'))

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

// ── CSV export helper ──────────────────────────────────────────────────────────
function exportTradesToCSV(trades, accountType, accountSize) {
  if (!trades || trades.length === 0) return
  const headers = ['ID','Instrument','Direction','Lots','Open Price','Close Price','Open Time','Close Time','P&L','Close Reason','Order Type']
  const rows = trades.map(t => [
    t.id,
    t.instrument,
    t.direction,
    parseFloat(t.lot_size).toFixed(2),
    t.open_price  ? formatPrice(t.open_price, t.instrument)  : '',
    t.close_price ? formatPrice(t.close_price, t.instrument) : '',
    t.open_time   ? new Date(t.open_time).toISOString()  : '',
    t.close_time  ? new Date(t.close_time).toISOString() : '',
    t.demo_pnl    ? parseFloat(t.demo_pnl).toFixed(2)    : '0.00',
    t.close_reason || 'Manual',
    t.order_type  || 'market'
  ])
  // Fix CSV formula injection vulnerability
  function csvSafeValue(val) {
    let str = String(val).replace(/"/g, '""')
    if (/^[=+\-@\t\r]/.test(str)) str = "'" + str
    return `"${str}"`
  }
  const csvContent = [headers, ...rows]
    .map(row => row.map(v => csvSafeValue(v)).join(','))
    .join('\n')
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url  = URL.createObjectURL(blob)
  const link = document.createElement('a')
  // FIX (MEDIUM #15): Sanitize filename components to prevent injection
  const safeAccountType = String(accountType || 'account').replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeAccountSize = String(accountSize || '').replace(/[^a-zA-Z0-9_.]/g, '_')
  link.href     = url
  link.download = `trade_history_${safeAccountType}_${safeAccountSize}_${new Date().toISOString().slice(0,10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
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

function ChartFallback() {
  return (
    <div
      className="card"
      style={{
        minHeight: '400px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--text-muted)',
        background: 'rgba(255,255,255,0.02)'
      }}
    >
      Loading chart workspace...
    </div>
  )
}

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
  const [positionView, setPositionView] = useState('all')
  const [partialForm, setPartialForm] = useState(null)
  const [batchActionPending, setBatchActionPending] = useState('')
  const [batchFeedback, setBatchFeedback] = useState(null)
  const [knownAvailableInstruments, setKnownAvailableInstruments] = useState([])

  const prices = Object.keys(storePrices || {}).length > 0 ? storePrices : (propPrices || {})
  const liveAvailableInstruments = useMemo(() => getAvailableInstrumentList(prices), [prices])
  const closingTradeSet = useMemo(() => new Set(closingTradeIds), [closingTradeIds])
  const availableInstruments = knownAvailableInstruments.length > 0
    ? knownAvailableInstruments
    : liveAvailableInstruments
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
    take_profit: '',
    trailing_step_pips: '',
    trailing_activation_price: '',
    breakeven_trigger_pips: ''
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

  // ── Trade journal notes ────────────────────────────────────────────────────
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [noteText, setNoteText]           = useState('')
  const [noteTags, setNoteTags]           = useState('')
  const [noteStrategyTag, setNoteStrategyTag] = useState('')
  const [noteSaved, setNoteSaved]         = useState(false)
  const [noteSaving, setNoteSaving]       = useState(false)  // FIX: guard against double-save
 
  // FIX: reset noteSaved when user opens a different trade's note editor,
  // so "✓ Saved" from a previous save never bleeds into the new trade's form.
  React.useEffect(() => {
    setNoteSaved(false)
  }, [editingNoteId])
 
  async function saveNote(tradeId) {
    if (noteSaving) return  // FIX: prevent double-save on rapid clicks
    setNoteSaving(true)
    try {
      await api.patch('/api/trades/note', {
        trade_id: tradeId,
        note: noteText,
        tags: noteTags,
        strategy_tag: noteStrategyTag
      })
      setNoteSaved(true)
      // Update the trade in-place so the 📝 icon reflects the new note state
      if (onTradeModified) onTradeModified()
    } catch (err) {
      console.error('Save note error:', err.response?.data?.error || err.message)
    } finally {
      setNoteSaving(false)
    }
  }
 

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
      take_profit: trade.take_profit ? parseFloat(trade.take_profit).toString() : '',
      trailing_step_pips: trade.trailing_step_pips ? String(trade.trailing_step_pips) : '',
      trailing_activation_price: trade.trailing_activation_price ? parseFloat(trade.trailing_activation_price).toString() : '',
      breakeven_trigger_pips: trade.breakeven_trigger_pips ? parseFloat(trade.breakeven_trigger_pips).toString() : ''
    })
    setModifyError('')
    setModifySuccess('')
  }

  function cancelModify() {
    setModifyingTradeId(null)
    setModifyForm({
      pending_price: '',
      stop_loss: '',
      take_profit: '',
      trailing_step_pips: '',
      trailing_activation_price: '',
      breakeven_trigger_pips: ''
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
      if (trade.status !== 'pending') {
        payload.trailing_step_pips = modifyForm.trailing_step_pips === '' ? null : parseInt(modifyForm.trailing_step_pips, 10)
        payload.trailing_activation_price = modifyForm.trailing_activation_price === '' ? null : parseFloat(modifyForm.trailing_activation_price)
        payload.breakeven_trigger_pips = modifyForm.breakeven_trigger_pips === '' ? null : parseFloat(modifyForm.breakeven_trigger_pips)
      }

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

  function openNoteEditor(trade) {
    setEditingNoteId(trade.id)
    setNoteText(trade.trader_note || '')
    setNoteTags(Array.isArray(trade.tags) ? trade.tags.join(', ') : (trade.tags || ''))
    setNoteStrategyTag(trade.strategy_tag || '')
    setNoteSaved(false)
  }

  function closeNoteEditor() {
    setEditingNoteId(null)
    setNoteText('')
    setNoteTags('')
    setNoteStrategyTag('')
    setNoteSaved(false)
  }

  const handleTradeLineAdjust = useCallback(async (tradeId, changeSet) => {
    try {
      await api.patch('/api/trades/modify', { trade_id: tradeId, ...changeSet })
      if (onTradeModified) onTradeModified()
    } catch (err) {
      setModifyError(err.response?.data?.error || 'Could not update trade from chart')
    }
  }, [onTradeModified])

  async function handleCloseTrade(trade) {
    if (closingTradeSet.has(trade.id)) return
    await onCloseTrade(trade.id)
  }

  async function handleOpenTrade(payload) {
    await onOpenTrade(payload)
  }

  function getTradeTags(trade) {
    if (Array.isArray(trade?.tags)) {
      return trade.tags.filter(Boolean)
    }
    if (typeof trade?.tags === 'string') {
      return trade.tags.split(',').map((tag) => tag.trim()).filter(Boolean)
    }
    return []
  }

  function renderTradeMetaBadges(trade) {
    const tags = getTradeTags(trade).slice(0, 2)
    const badges = []

    if (trade.strategy_tag) {
      badges.push({
        key: 'strategy',
        label: trade.strategy_tag,
        color: 'var(--accent)',
        background: 'rgba(var(--brand-primary-rgb), 0.14)',
        border: 'rgba(var(--brand-primary-rgb), 0.28)'
      })
    }

    tags.forEach((tag, index) => {
      badges.push({
        key: `tag-${index}`,
        label: `#${tag}`,
        color: 'var(--text-muted)',
        background: 'rgba(148, 148, 148, 0.08)',
        border: 'rgba(148, 148, 148, 0.18)'
      })
    })

    if (trade.trailing_step_pips) {
      badges.push({
        key: 'trail',
        label: `Trail ${trade.trailing_step_pips}p`,
        color: 'var(--green)',
        background: 'rgba(0, 200, 153, 0.1)',
        border: 'rgba(0, 200, 153, 0.25)'
      })
    }

    if (trade.breakeven_trigger_pips) {
      badges.push({
        key: 'be',
        label: `BE ${trade.breakeven_trigger_pips}p`,
        color: 'var(--accent-gold, #fbbf24)',
        background: 'rgba(251, 191, 36, 0.1)',
        border: 'rgba(251, 191, 36, 0.25)'
      })
    }

    if (badges.length === 0) return null

    return (
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
        {badges.map((badge) => (
          <span
            key={badge.key}
            style={{
              padding: '2px 7px',
              borderRadius: '999px',
              fontSize: '10px',
              fontWeight: '700',
              letterSpacing: '0.03em',
              color: badge.color,
              background: badge.background,
              border: `1px solid ${badge.border}`
            }}
          >
            {badge.label}
          </span>
        ))}
      </div>
    )
  }

  function renderTradeNoteEditor(trade, colSpan = 8) {
    return (
      <tr>
        <td colSpan={colSpan} style={{ padding: '0', borderBottom: '1px solid var(--navy-border)' }}>
          <div style={{
            padding: '12px 16px',
            background: 'rgba(148, 148, 148, 0.04)',
            borderTop: '1px solid rgba(148, 148, 148, 0.15)'
          }}>
            <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px', letterSpacing: '0.08em' }}>
              TRADE JOURNAL — {trade.instrument} {trade.direction?.toUpperCase()} {parseFloat(trade.lot_size).toFixed(2)} lots
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
              <input
                type="text"
                placeholder="Strategy tag"
                value={noteStrategyTag}
                onChange={(e) => { setNoteStrategyTag(e.target.value); setNoteSaved(false) }}
                style={{ width: '100%', fontSize: '13px', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--text)' }}
              />
              <input
                type="text"
                placeholder="Tags (comma separated, e.g. A+ Setup, Revenge)"
                value={noteTags}
                onChange={(e) => { setNoteTags(e.target.value); setNoteSaved(false) }}
                style={{ width: '100%', fontSize: '13px', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--accent)', fontFamily: 'var(--font-ui)' }}
              />
            </div>
            <textarea
              value={noteText}
              onChange={(e) => { setNoteText(e.target.value); setNoteSaved(false) }}
              placeholder="Add your trade notes here — strategy used, lessons learned, market context..."
              maxLength={1000}
              rows={3}
              style={{
                width: '100%', fontSize: '13px', resize: 'vertical',
                background: 'var(--navy)', border: '1px solid var(--navy-border)',
                borderRadius: '6px', padding: '8px 12px',
                color: 'var(--text)', fontFamily: 'var(--font-ui)',
                lineHeight: '1.5', marginBottom: '8px'
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{noteText.length}/1000</span>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                {noteSaved && (
                  <span style={{ fontSize: '11px', color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {renderIcon('approve', { size: 11, color: 'var(--accent-green)' })}
                    <span>Saved</span>
                  </span>
                )}
                <button
                  onClick={() => saveNote(trade.id)}
                  disabled={noteSaving}
                  style={{
                    background: noteSaving ? 'var(--navy-border)' : 'var(--accent)',
                    color: noteSaving ? 'var(--text-muted)' : 'var(--navy)',
                    border: 'none', borderRadius: '6px',
                    padding: '6px 16px', fontSize: '12px',
                    fontWeight: '700',
                    cursor: noteSaving ? 'not-allowed' : 'pointer',
                    fontFamily: 'var(--font-ui)'
                  }}
                >
                  {noteSaving ? 'Saving...' : 'Save Note'}
                </button>
                <button
                  onClick={closeNoteEditor}
                  style={{
                    background: 'transparent', border: '1px solid var(--navy-border)',
                    borderRadius: '6px', padding: '6px 12px',
                    fontSize: '12px', color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </td>
      </tr>
    )
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
  const closedTrades = tradeHistory.filter(trade => trade.status === 'closed')
  const cancelledTrades = tradeHistory.filter(trade => trade.status === 'cancelled')
  const realizedHistoryPnl = closedTrades.reduce((sum, trade) => sum + parseFloat(trade.demo_pnl || 0), 0)
  const [tradeHistoryPage, setTradeHistoryPage] = useState(1)
  const TRADE_HIST_PAGE_SIZE = 20

  // FIX (AUDIT): tradeHistoryPage was never reset on account switch — a
  // trader on page 3 of Account A's history would land on Account B with
  // fewer trades and slice past the array end, showing a silently blank
  // table with no visible pagination controls to explain why.
  useEffect(() => {
    setTradeHistoryPage(1)
  }, [selectedAccount?.id])
  const visibleOpenTrades = positionView === 'open'
    ? openPositions
    : positionView === 'pending'
      ? pendingOrders
      : openTrades
  const priceStatusState = priceStatus?.status || (priceStatus?.healthy ? 'healthy' : 'unhealthy')
  const priceFeedLive = priceStatusState === 'healthy'
  const priceFeedDegraded = priceStatusState === 'degraded'
  const priceFeedColor = priceFeedLive ? 'var(--green)' : (priceFeedDegraded ? 'var(--warning, #f59e0b)' : 'var(--red)')
  const priceFeedBackground = priceFeedLive
    ? 'rgba(0, 200, 153, 0.1)'
    : (priceFeedDegraded ? 'rgba(245, 158, 11, 0.12)' : 'rgba(255, 71, 87, 0.1)')
  const priceFeedBorder = priceFeedLive
    ? 'rgba(0, 200, 153, 0.3)'
    : (priceFeedDegraded ? 'rgba(245, 158, 11, 0.28)' : 'rgba(255, 71, 87, 0.3)')
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
          borderRadius: '8px',
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
            <button key={acc.id} className="btn" onClick={() => setSelectedAccount(acc)}
              style={{
                background: selectedAccount?.id === acc.id ? 'var(--accent)' : 'var(--navy-card)',
                color:      selectedAccount?.id === acc.id ? 'var(--navy)' : 'var(--text)',
                border: '1px solid var(--accent)',
                fontSize: '12px',
                padding: '8px 14px'
              }}>
              {acc.account_type.toUpperCase()} ${parseFloat(acc.account_size).toLocaleString()}
              <span style={{ marginLeft: '6px', fontSize: '10px', color: selectedAccount?.id === acc.id ? 'var(--navy)' : getStatusColor(acc.status) }}>
                ● {acc.status.toUpperCase()}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Symbol Selector */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))',
        gap: '8px',
        marginBottom: '20px'
      }}>
        {availableInstruments.map(instrument => {
          const data = prices[instrument]
          const isSelected = orderForm.instrument === instrument
          const bidText = data ? formatPrice(data.bid, instrument) : '--'
          const askText = data ? formatPrice(data.ask, instrument) : '--'
          return (
            <div
              key={instrument}
              onClick={() => setOrderForm(f => ({ ...f, instrument, stop_loss: '', take_profit: '' }))}
              style={{
                background:  'var(--navy-card)',
                border:      isSelected ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
                borderRadius:'8px',
                padding:     '10px 12px',
                cursor:      'pointer',
                transition:  'all 0.15s',
                boxShadow:   isSelected ? '0 0 12px rgba(148, 148, 148, 0.2)' : 'none',
                minHeight:   '78px'
              }}
            >
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: '4px' }}>{instrument}</div>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                {bidText}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                {askText}
              </div>
            </div>
          )
        })}
      </div>

      {/* No account yet */}
      {accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            {renderIcon('trade', { size: 48, color: 'var(--accent)' })}
          </div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Trading Account</h3>
          <p style={{ color: 'var(--text-muted)' }}>Go to Dashboard to create your challenge account first.</p>
        </div>
      )}

      {/* Locked account */}
      {selectedAccount?.status === 'locked' && (
        <div className="card" style={{ textAlign: 'center', padding: '32px', border: '1px solid var(--muted)', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '12px' }}>
            {renderIcon('lock', { size: 40, color: 'var(--text-secondary)' })}
          </div>
          <h3 style={{ color: 'var(--muted)', marginBottom: '8px' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support.</p>
        </div>
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
        <div className='trading-layout' style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '20px', alignItems: 'start' }}>

          {/* Left — Chart + Positions */}
          <div>

            {/* FIX Step 3: SimulatedTradingDisclaimer — shown above the chart on active accounts */}
            <SimulatedTradingDisclaimer />

            {/* Balance Bar */}
            {stats && (
              <div className='trading-stats-grid' style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
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
                background: 'rgba(148, 148, 148, 0.06)',
                border: '1px solid rgba(148, 148, 148, 0.24)',
                borderRadius: '8px',
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
                <div style={{ height: '8px', borderRadius: '4px', background: 'var(--navy-border)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${targetProgressPct}%`,
                    transition: 'width 0.5s ease',
                    background: targetProgressPct >= 100
                      ? 'var(--green)'
                      : targetProgressPct >= 75
                        ? 'var(--muted)'
                        : targetProgressPct >= 50
                          ? 'var(--muted)'
                          : 'var(--accent)'
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
                critical: { bg: 'rgba(97, 97, 97, 0.15)', border: 'var(--red)',   bar: 'var(--muted)', text: 'var(--red)',   icon: 'risk-alerts' },
                high:     { bg: 'rgba(122, 122, 122, 0.10)', border: 'var(--muted)',      bar: 'var(--muted)', text: 'var(--muted)',     icon: 'warning' },
                medium:   { bg: 'rgba(139, 139, 139, 0.10)', border: 'var(--muted)',     bar: 'var(--muted)', text: 'var(--muted)',     icon: 'analytics' },
                low:      { bg: 'rgba(148, 148, 148, 0.06)', border: 'rgba(148, 148, 148, 0.3)', bar: 'var(--accent)', text: 'var(--text-muted)', icon: 'floating_down' },
              }
              const c = levelColors[level]

              return (
                <div style={{
                  background: c.bg, border: `1px solid ${c.border}`,
                  borderRadius: '8px', padding: '10px 14px',
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
                  <div style={{ height: '6px', background: 'var(--navy-border)', borderRadius: '3px', overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', borderRadius: '3px',
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


              <div style={{ width: '100%', height: '400px', marginBottom: '16px' }}>
                <Suspense fallback={<ChartFallback />}>
                  <MultiChartGrid
                    selectedInstrument={orderForm.instrument}
                    availableInstruments={availableInstruments}
                    openTrades={openTrades}
                    tradeHistory={tradeHistory}
                    prices={prices}
                    selectedAccount={selectedAccount}
                    stats={stats}
                    onTradeLineAdjust={handleTradeLineAdjust}
                    onPrimaryInstrumentChange={(instrument) => setOrderForm((current) => ({
                      ...current,
                      instrument,
                      stop_loss: '',
                      take_profit: ''
                    }))}
                  />
                </Suspense>
              </div>

            {/* ── Phase Countdown Timer ── */}
            {timeRemaining && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                padding: '10px 16px', marginBottom: '16px',
                background: timeRemaining.urgent
                  ? 'rgba(97, 97, 97, 0.12)'
                  : 'rgba(148, 148, 148, 0.06)',
                border: `1px solid ${timeRemaining.urgent ? 'var(--red)' : 'rgba(148, 148, 148, 0.25)'}`,
                borderRadius: '8px'
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
                        <div style={{ height: '4px', background: 'var(--navy-border)', borderRadius: '2px' }}>
                          <div style={{
                            height: '100%', borderRadius: '2px',
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
              <div className="card trade-section-card">
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
                <div className="table-wrapper trading-table-wrapper">
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
                            <tr style={{ opacity: isPending ? 0.75 : 1 }}>
                              <td style={{ fontWeight: '600' }}>
                                {trade.instrument}
                                {isPending && (
                                  <span style={{
                                    marginLeft: '6px', fontSize: '9px', padding: '2px 5px',
                                    background: 'rgba(148, 148, 148, 0.15)', border: '1px solid var(--accent)',
                                    borderRadius: '3px', color: 'var(--accent)', verticalAlign: 'middle'
                                  }}>
                                    PENDING
                                  </span>
                                )}
                                {renderTradeMetaBadges(trade)}
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
                                        onClick={() => isModifying ? cancelModify() : openModifyForm(trade)}
                                      >
                                        {isModifying ? 'Cancel' : 'Modify'}
                                      </Button>
                                      <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() => onCancelOrder(trade.id)}
                                      >
                                        Cancel Order
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => isModifying ? cancelModify() : openModifyForm(trade)}
                                      >
                                        {isModifying ? 'Cancel' : 'Modify'}
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => editingNoteId === trade.id ? closeNoteEditor() : openNoteEditor(trade)}
                                        style={trade.trader_note ? { color: 'var(--ink)' } : undefined}
                                      >
                                        Journal
                                      </Button>
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        onClick={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}
                                      >
                                        Partial
                                      </Button>
                                      <Button
                                        variant="danger"
                                        size="sm"
                                        onClick={() => handleCloseTrade(trade)}
                                        disabled={closingTradeSet.has(trade.id)}
                                      >
                                        {closingTradeSet.has(trade.id) ? 'Closing...' : 'Close'}
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>

                            {/* Inline Partial Close Form */}
                            {!isPending && partialForm?.id === trade.id && (
                              <tr>
                                <td colSpan="9" style={{ padding: '0' }}>
                                  <div style={{ background: 'var(--navy-card)', border: '1px dashed var(--accent)', borderRadius: '8px', padding: '12px 16px', margin: '4px 0 8px 0', display: 'grid', gap: '10px' }}>
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
                                              borderRadius: '999px',
                                              border: '1px solid var(--navy-border)',
                                              background: invalid || closingTradeSet.has(trade.id) ? 'rgba(255,255,255,0.03)' : 'rgba(var(--brand-primary-rgb),0.08)',
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
                                  <div style={{ background: 'var(--navy-card)', border: '1px solid var(--accent)', borderRadius: '8px', padding: '16px', margin: '4px 0 8px 0' }}>
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
                                    borderRadius: '8px',
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
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Trailing Step (pips)
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.trailing_step_pips}
                                          onChange={e => setModifyForm(f => ({ ...f, trailing_step_pips: e.target.value }))}
                                          placeholder="10"
                                          step="1"
                                          style={{ width: '120px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Trail Activation
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.trailing_activation_price}
                                          onChange={e => setModifyForm(f => ({ ...f, trailing_activation_price: e.target.value }))}
                                          placeholder="Activation price"
                                          step={getInputStepString(trade.instrument)}
                                          style={{ width: '140px', fontSize: '13px', padding: '7px 10px' }}
                                        />
                                      </div>
                                      <div>
                                        <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginBottom: '4px' }}>
                                          Breakeven Trigger
                                        </label>
                                        <input
                                          type="number"
                                          value={modifyForm.breakeven_trigger_pips}
                                          onChange={e => setModifyForm(f => ({ ...f, breakeven_trigger_pips: e.target.value }))}
                                          placeholder="Pips to BE"
                                          step="0.1"
                                          style={{ width: '120px', fontSize: '13px', padding: '7px 10px' }}
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
                            {!isPending && editingNoteId === trade.id && renderTradeNoteEditor(trade, 9)}
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
              </div>
            )}

            {/* Trade History */}
            {tradeHistory.length > 0 && (
              <div className="card trade-section-card trade-history-card">
                <div className="trade-section-pills" style={{ marginBottom: '14px' }}>
                  <span className="trade-summary-pill">{closedTrades.length} Closed</span>
                  <span className="trade-summary-pill">{cancelledTrades.length} Cancelled</span>
                  <span className="trade-summary-pill" style={{ color: realizedHistoryPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {realizedHistoryPnl >= 0 ? '+' : ''}${realizedHistoryPnl.toFixed(2)} Realized
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <h3 style={{ color: 'var(--accent)', fontSize: '15px', margin: 0 }}>
                    Closed Trades & History ({tradeHistory.length})
                  </h3>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* ── Repeat Last Trade ── */}
                    {(() => {
                      const lastClosed = tradeHistory.find(t => t.status === 'closed')
                      if (!lastClosed) return null
                      return (
                        <button
                          onClick={() => {
                            setOrderForm(f => ({
                              ...f,
                              instrument: lastClosed.instrument,
                              lots:       parseFloat(lastClosed.lot_size).toFixed(2),
                              stop_loss:  lastClosed.stop_loss  ? parseFloat(lastClosed.stop_loss).toString()  : '',
                              take_profit: lastClosed.take_profit ? parseFloat(lastClosed.take_profit).toString() : '',
                              strategy_tag: lastClosed.strategy_tag || '',
                              journal_note: lastClosed.trader_note || '',
                              journal_tags: Array.isArray(lastClosed.tags)
                                ? lastClosed.tags.join(', ')
                                : (typeof lastClosed.tags === 'string' ? lastClosed.tags : ''),
                              trailing_step_pips: lastClosed.trailing_step_pips ? String(lastClosed.trailing_step_pips) : '',
                              trailing_activation_price: lastClosed.trailing_activation_price ? parseFloat(lastClosed.trailing_activation_price).toString() : '',
                              breakeven_trigger_pips: lastClosed.breakeven_trigger_pips ? parseFloat(lastClosed.breakeven_trigger_pips).toString() : '',
                            }))
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid rgba(148, 148, 148, 0.3)',
                            borderRadius: '6px',
                            padding: '6px 12px',
                            fontSize: '11px',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            display: 'flex', alignItems: 'center', gap: '5px',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(148, 148, 148, 0.08)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title={`Repeat: ${lastClosed.instrument} ${lastClosed.direction?.toUpperCase()} ${parseFloat(lastClosed.lot_size).toFixed(2)} lots`}
                        >
                          {renderIcon('repeat', { size: 12, color: 'currentColor' })}
                          <span>Repeat Last</span>
                        </button>
                      )
                    })()}
                    <button
                      onClick={() => exportTradesToCSV(
                        tradeHistory,
                        selectedAccount?.account_type || 'account',
                        selectedAccount?.account_size || ''
                      )}
                      style={{
                        background: 'transparent',
                        border: '1px solid var(--navy-border)',
                        borderRadius: '6px',
                        padding: '6px 12px',
                        fontSize: '11px',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: '5px',
                        transition: 'all 0.15s'
                      }}
                      onMouseEnter={e => { e.target.style.borderColor = 'var(--accent)'; e.target.style.color = 'var(--accent)' }}
                      onMouseLeave={e => { e.target.style.borderColor = 'var(--navy-border)'; e.target.style.color = 'var(--text-muted)' }}
                      title="Download trade history as CSV"
                    >
                      {renderIcon('download', { size: 12, color: 'currentColor' })}
                      <span>Export CSV</span>
                    </button>
                  </div>
                </div>
                <div className="table-wrapper trading-table-wrapper">
                  <table className="data-table trading-table">
                    <thead>
                      <tr>
                        <th>Symbol</th><th>Type</th><th>Lots</th>
                        <th>Open Price</th><th>Close Price</th><th>Reason</th><th>P&L</th><th>{renderIcon('journal', { size: 12, color: 'var(--text-secondary)' })}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tradeHistory.slice(
                        (tradeHistoryPage - 1) * TRADE_HIST_PAGE_SIZE,
                        tradeHistoryPage * TRADE_HIST_PAGE_SIZE
                      ).map(trade => {
                        const dec = getPriceDecimals(trade.instrument)
                        const isCancelled = trade.status === 'cancelled'
                        const isEditingNote = editingNoteId === trade.id
                        return (
                          <React.Fragment key={trade.id}>
                            <tr style={{ opacity: isCancelled ? 0.6 : 1 }}>
                              <td style={{ fontWeight: '600' }}>
                                {trade.instrument}
                                {renderTradeMetaBadges(trade)}
                              </td>
                              <td style={{ color: trade.direction === 'buy' ? 'var(--green)' : 'var(--red)', fontWeight: '600' }}>
                                {trade.order_type && trade.order_type !== 'market'
                                  ? trade.order_type.replace(/_/g, ' ').toUpperCase()
                                  : trade.direction.toUpperCase()
                                }
                              </td>
                              <td>{parseFloat(trade.lot_size).toFixed(2)}</td>
                              <td>
                                {trade.open_price != null
                                  ? parseFloat(trade.open_price).toFixed(dec)
                                  : trade.pending_price != null
                                    ? `${parseFloat(trade.pending_price).toFixed(dec)} (pending)`
                                    : '—'
                                }
                              </td>
                              <td>{trade.close_price ? parseFloat(trade.close_price).toFixed(dec) : '—'}</td>
                              <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                                {trade.close_reason || 'Manual'}
                              </td>
                              <td style={{
                                color: isCancelled
                                  ? 'var(--text-muted)'
                                  : (parseFloat(trade.demo_pnl || 0) >= 0 ? 'var(--green)' : 'var(--red)'),
                                fontWeight: '600'
                              }}>
                                {isCancelled ? '—' : `${parseFloat(trade.demo_pnl || 0) >= 0 ? '+' : ''}$${parseFloat(trade.demo_pnl || 0).toFixed(2)}`}
                              </td>
                              {/* Note button */}
                              <td>
                                <button
                                  onClick={() => {
                                    if (isEditingNote) {
                                      closeNoteEditor()
                                    } else {
                                      openNoteEditor(trade)
                                    }
                                  }}
                                  className="trade-note-btn"
                                  style={{
                                    borderColor: trade.trader_note ? 'var(--accent)' : 'var(--navy-border)',
                                    color: trade.trader_note ? 'var(--accent)' : 'var(--text-dim)'
                                  }}
                                  title={trade.trader_note ? 'View/edit note' : 'Add note'}
                                >
                                  {renderIcon(trade.trader_note ? 'journal' : 'plus', {
                                    size: 12,
                                    color: trade.trader_note ? 'var(--accent)' : 'var(--text-secondary)'
                                  })}
                                </button>
                              </td>
                            </tr>

                            {/* Inline note editor row */}
                            {null && (
                              <tr>
                                <td colSpan={8} style={{ padding: '0', borderBottom: '1px solid var(--navy-border)' }}>
                                  <div style={{
                                    padding: '12px 16px',
                                    background: 'rgba(148, 148, 148, 0.04)',
                                    borderTop: '1px solid rgba(148, 148, 148, 0.15)'
                                  }}>
                                    <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '8px', letterSpacing: '0.08em' }}>
                                      TRADE NOTE — {trade.instrument} {trade.direction?.toUpperCase()} {parseFloat(trade.lot_size).toFixed(2)} lots
                                    </div>
                                    <input type="text" placeholder="Tags (comma separated, e.g. A+ Setup, Revenge)" value={noteTags} onChange={e => { setNoteTags(e.target.value); setNoteSaved(false) }} style={{ width: '100%', fontSize: '13px', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--accent)', fontFamily: 'var(--font-ui)', marginBottom: '8px' }} />
                                    <textarea
                                      value={noteText}
                                      onChange={e => { setNoteText(e.target.value); setNoteSaved(false) }}
                                      placeholder="Add your trade notes here — strategy used, lessons learned, market context..."
                                      maxLength={1000}
                                      rows={3}
                                      style={{
                                        width: '100%', fontSize: '13px', resize: 'vertical',
                                        background: 'var(--navy)', border: '1px solid var(--navy-border)',
                                        borderRadius: '6px', padding: '8px 12px',
                                        color: 'var(--text)', fontFamily: 'var(--font-ui)',
                                        lineHeight: '1.5', marginBottom: '8px'
                                      }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{noteText.length}/1000</span>
                                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                        {noteSaved && (
                                          <span style={{ fontSize: '11px', color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                                            {renderIcon('approve', { size: 11, color: 'var(--accent-green)' })}
                                            <span>Saved</span>
                                          </span>
                                        )}
                                         <button
                                          onClick={() => saveNote(trade.id)}
                                          disabled={noteSaving}
                                          style={{
                                            background: noteSaving ? 'var(--navy-border)' : 'var(--accent)',
                                            color: noteSaving ? 'var(--text-muted)' : 'var(--navy)',
                                            border: 'none', borderRadius: '6px',
                                            padding: '6px 16px', fontSize: '12px',
                                            fontWeight: '700',
                                            cursor: noteSaving ? 'not-allowed' : 'pointer',
                                            fontFamily: 'var(--font-ui)'
                                          }}
                                        >
                                          {noteSaving ? 'Saving...' : 'Save Note'}
                                        </button>
                                        <button
                                          onClick={() => setEditingNoteId(null)}
                                          style={{
                                            background: 'transparent', border: '1px solid var(--navy-border)',
                                            borderRadius: '6px', padding: '6px 12px',
                                            fontSize: '12px', color: 'var(--text-muted)',
                                            cursor: 'pointer'
                                          }}
                                        >
                                          Close
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                </td>
                              </tr>
                            )}
                            {isEditingNote && renderTradeNoteEditor(trade, 8)}
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={tradeHistoryPage}
                  totalPages={Math.ceil(tradeHistory.length / TRADE_HIST_PAGE_SIZE)}
                  onPageChange={p => setTradeHistoryPage(p)}
                  pageSize={TRADE_HIST_PAGE_SIZE}
                  total={tradeHistory.length}
                />
              </div>
            )}
            </div>
          </div>

          {/* Right — Order Panel */}
          <div className='order-panel-sticky' style={{ position: 'sticky', top: '84px' }}>
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
        <div className="card" style={{
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
        </div>
      )}
    </div>
  )
}

