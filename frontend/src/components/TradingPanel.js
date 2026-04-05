import React, { useState, useEffect } from 'react'
import MultiChartGrid from './MultiChartGrid'
import OrderPanel from './OrderPanel'
import SimulatedTradingDisclaimer from './SimulatedTradingDisclaimer'
import RiskWarningBanner from './RiskWarningBanner'
import api from '../services/api'

const SUPPORTED_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']
function getDecimals(instrument) {
  if (instrument === 'XAUUSD' || instrument === 'XAGUSD') return 2
  return 5
}

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
    t.open_price  ? parseFloat(t.open_price).toFixed(5)  : '',
    t.close_price ? parseFloat(t.close_price).toFixed(5) : '',
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

export default function TradingPanel({
  prices, selectedAccount, accounts, setSelectedAccount,
  openTrades, tradeHistory, orderForm, setOrderForm,
  onOpenTrade, onCloseTrade, onCancelOrder, getStatusColor, stats,
  onTradeModified, accountLoading
}) {
  const [positionView, setPositionView] = useState('all')
  const [partialForm, setPartialForm] = useState(null)

  async function handleBatchAction(actionType) {
    if (!window.confirm('Are you sure you want to execute batch action: ' + actionType.replace('_', ' ') + '?')) return
    try {
      const res = await api.post('/api/trades/batch-action', { action: actionType, account_id: selectedAccount.id })
      alert(res.data.message + ' (Affected: ' + res.data.affected + ')')
    } catch (err) {
      alert(err.response?.data?.error || 'Batch action failed')
    }
  }

  async function handlePartialClose(tradeId, currentLots, closeLots) {
    try {
      if (!closeLots || parseFloat(closeLots) <= 0 || parseFloat(closeLots) > parseFloat(currentLots)) return alert('Invalid lot fraction')
      await api.post('/api/trades/close', { trade_id: tradeId, close_lots: parseFloat(closeLots) })
      setPartialForm(null)
      if (onTradeModified) onTradeModified()
    } catch (err) {
      alert(err.response?.data?.error || 'Partial close failed')
    }
  }
  const [modifyingTradeId, setModifyingTradeId] = useState(null)
  const [modifyForm, setModifyForm] = useState({ stop_loss: '', take_profit: '' })
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

  // ── Trade journal notes ────────────────────────────────────────────────────
  const [editingNoteId, setEditingNoteId] = useState(null)
  const [noteText, setNoteText]           = useState('')
  const [noteTags, setNoteTags]           = useState('')
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
      await api.patch('/api/trades/note', { trade_id: tradeId, note: noteText, tags: noteTags })
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
      stop_loss:   trade.stop_loss   ? parseFloat(trade.stop_loss).toString()   : '',
      take_profit: trade.take_profit ? parseFloat(trade.take_profit).toString() : ''
    })
    setModifyError('')
    setModifySuccess('')
  }

  function cancelModify() {
    setModifyingTradeId(null)
    setModifyForm({ stop_loss: '', take_profit: '' })
    setModifyError('')
    setModifySuccess('')
  }

  async function submitModify(trade) {
    try {
      setModifyError('')
      const payload = { trade_id: trade.id }
      payload.stop_loss   = modifyForm.stop_loss   === '' ? null : parseFloat(modifyForm.stop_loss)
      payload.take_profit = modifyForm.take_profit === '' ? null : parseFloat(modifyForm.take_profit)

      await api.patch('/api/trades/modify', payload)



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

  const currentBalance = stats ? parseFloat(stats.account?.current_balance || 0) : 0
  const floatingProfit = openTrades.reduce((sum, trade) => {
    if (trade.status !== 'open') return sum
    return sum + parseFloat(trade.floating_pnl || 0)
  }, 0)
  const floatingBalance = currentBalance + floatingProfit
  const startingBalance = stats ? parseFloat(stats.account?.starting_balance || selectedAccount?.starting_balance || 0) : 0
  const profitTargetAmount = stats ? parseFloat(stats.account?.profit_target || 0) : 0
  const realizedProfit = currentBalance - startingBalance
  const equityProfit = floatingBalance - startingBalance
  const targetProgressPct = profitTargetAmount > 0
    ? Math.min(Math.max((realizedProfit / profitTargetAmount) * 100, 0), 100)
    : 0
  const targetRemaining = Math.max(0, profitTargetAmount - realizedProfit)
  const openPositions = openTrades.filter(trade => trade.status === 'open')
  const pendingOrders = openTrades.filter(trade => trade.status === 'pending')
  const visibleOpenTrades = positionView === 'open'
    ? openPositions
    : positionView === 'pending'
      ? pendingOrders
      : openTrades

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: 0, fontSize: '22px' }}>
          Trading Terminal
        </h2>
        {/* Price Feed Status Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 14px',
          borderRadius: '8px',
          background: priceStatus.healthy ? 'rgba(0, 200, 153, 0.1)' : 'rgba(255, 71, 87, 0.1)',
          border: `1px solid ${priceStatus.healthy ? 'rgba(0, 200, 153, 0.3)' : 'rgba(255, 71, 87, 0.3)'}`,
          fontSize: '12px'
        }}>
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: priceStatus.healthy ? 'var(--green)' : 'var(--red)',
            animation: priceStatus.healthy ? 'none' : 'pulse 1.5s infinite'
          }} />
          <span style={{ color: priceStatus.healthy ? 'var(--green)' : 'var(--red)', fontWeight: 500 }}>
            {priceStatus.healthy ? '● Live' : '● Delayed'}
          </span>
          {!priceStatus.healthy && priceStatus.message && (
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

      {/* Price Ticker */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '20px', overflowX: 'auto', paddingBottom: '4px' }}>
        {SUPPORTED_INSTRUMENTS.map(instrument => {
          const data = prices[instrument]
          if (!data) return null
          const decimals = getDecimals(instrument)
          const isSelected = orderForm.instrument === instrument
          return (
            <div
              key={instrument}
              onClick={() => setOrderForm(f => ({ ...f, instrument, stop_loss: '', take_profit: '' }))}
              style={{
                background:  'var(--navy-card)',
                border:      isSelected ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
                borderRadius:'8px',
                padding:     '10px 14px',
                cursor:      'pointer',
                minWidth:    '110px',
                flexShrink:  0,
                transition:  'all 0.15s',
                boxShadow:   isSelected ? '0 0 12px rgba(148, 148, 148, 0.2)' : 'none'
              }}
            >
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', letterSpacing: '0.08em', marginBottom: '4px' }}>{instrument}</div>
              <div style={{ fontSize: '15px', fontWeight: 'bold', color: 'var(--accent)', fontFamily: 'DM Mono, monospace' }}>
                {parseFloat(data.bid).toFixed(decimals)}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '2px' }}>
                {parseFloat(data.ask).toFixed(decimals)}
              </div>
            </div>
          )
        })}
      </div>

      {/* No account yet */}
      {accounts.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📈</div>
          <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Trading Account</h3>
          <p style={{ color: 'var(--text-muted)' }}>Go to Dashboard to create your challenge account first.</p>
        </div>
      )}

      {/* Locked account */}
      {selectedAccount?.status === 'locked' && (
        <div className="card" style={{ textAlign: 'center', padding: '32px', border: '1px solid #8a8a8a', marginBottom: '20px' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🔒</div>
          <h3 style={{ color: '#8a8a8a', marginBottom: '8px' }}>Account Locked</h3>
          <p style={{ color: 'var(--text-muted)' }}>This account has been locked by admin. Contact support.</p>
        </div>
      )}

      {/* Loading state */}
      {accountLoading && (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '14px' }}>
          ⏳ Loading account data...
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
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'DM Mono, monospace' }}>
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
                        ? '#7a7a7a'
                        : targetProgressPct >= 50
                          ? '#8b8b8b'
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
                critical: { bg: 'rgba(97, 97, 97, 0.15)', border: 'var(--red)',   bar: '#7a7a7a', text: 'var(--red)',   icon: '🚨' },
                high:     { bg: 'rgba(122, 122, 122, 0.10)', border: '#7a7a7a',      bar: '#7a7a7a', text: '#7a7a7a',     icon: '⚠️' },
                medium:   { bg: 'rgba(139, 139, 139, 0.10)', border: '#8b8b8b',     bar: '#8b8b8b', text: '#8b8b8b',     icon: '📊' },
                low:      { bg: 'rgba(148, 148, 148, 0.06)', border: 'rgba(148, 148, 148, 0.3)', bar: 'var(--accent)', text: 'var(--text-muted)', icon: '📉' },
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
                      <span>{c.icon}</span>
                      <span style={{ fontSize: '12px', fontWeight: '600', color: c.text }}>
                        Drawdown {level === 'critical' ? '— CRITICAL' : level === 'high' ? '— HIGH' : level === 'medium' ? '— WARNING' : ''}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '11px', fontFamily: 'DM Mono, monospace' }}>
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
                    <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--red)', fontWeight: '600' }}>
                      ⚡ Account will fail if drawdown reaches {maxDrawdownPct}%. Close losing trades immediately.
                    </div>
                  )}
                </div>
              )
            })()}


            <div style={{ width: '100%', height: '400px', marginBottom: '16px' }}>
              <MultiChartGrid
                selectedInstrument={orderForm.instrument}
                openTrades={openTrades}
                tradeHistory={tradeHistory}
                prices={prices}
              />
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
                <span style={{ fontSize: '18px' }}>
                  {timeRemaining.expired ? '⏰' : timeRemaining.urgent ? '🚨' : '⏱️'}
                </span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginBottom: '2px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                    {selectedAccount.account_type.toUpperCase()} Phase Time Remaining
                  </div>
                  <div style={{
                    fontSize: '16px', fontWeight: '700',
                    fontFamily: 'DM Mono, monospace',
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
                            background: pct > 80 ? 'var(--red)' : pct > 60 ? '#8b8b8b' : 'var(--accent)',
                            transition: 'width 1s linear'
                          }} />
                        </div>
                      )
                    })()}
                  </div>
                )}
              </div>
            )}
            {openTrades.length > 0 && (
              <div className="card" style={{ marginBottom: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                    <h3 style={{ marginBottom: 0, color: 'var(--accent)', fontSize: '15px' }}>
                      Open Positions & Orders ({visibleOpenTrades.length})
                    </h3>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button onClick={() => handleBatchAction('close_winning')} className="btn" style={{ fontSize: '10px', padding: '4px 8px', background: 'rgba(0, 200, 153, 0.2)', color: 'var(--green)', border: '1px solid var(--green)' }}>Close Winners</button>
                      <button onClick={() => handleBatchAction('close_losing')} className="btn" style={{ fontSize: '10px', padding: '4px 8px', background: 'rgba(255, 71, 87, 0.2)', color: 'var(--red)', border: '1px solid var(--red)' }}>Close Losers</button>
                      <button onClick={() => handleBatchAction('breakeven_winning')} className="btn" style={{ fontSize: '10px', padding: '4px 8px', background: 'rgba(0, 229, 255, 0.2)', color: 'var(--accent)', border: '1px solid var(--accent)' }}>Breakeven All</button>
                    </div>
                  </div>
                  <div style={{ display: 'inline-flex', border: '1px solid var(--navy-border)', borderRadius: '8px', overflow: 'hidden' }}>
                    {[
                      { id: 'all', label: `All (${openTrades.length})` },
                      { id: 'open', label: `Open (${openPositions.length})` },
                      { id: 'pending', label: `Pending (${pendingOrders.length})` }
                    ].map(view => (
                      <button
                        key={view.id}
                        onClick={() => setPositionView(view.id)}
                        style={{
                          border: 'none',
                          padding: '7px 11px',
                          fontSize: '11px',
                          cursor: 'pointer',
                          background: positionView === view.id ? 'var(--accent)' : 'var(--navy-card)',
                          color: positionView === view.id ? 'var(--navy)' : 'var(--text-muted)',
                          fontWeight: positionView === view.id ? '700' : '500',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {view.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th><th>Type</th><th>Lots</th><th>Open / Target</th>
                        <th>Current</th><th>SL</th><th>TP</th><th>P&L</th><th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleOpenTrades.map(trade => {
                        const dec = getDecimals(trade.instrument)
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
                                <div style={{ display: 'flex', gap: '5px' }}>
                                  {isPending ? (
                                    <button
                                      className="btn btn-red"
                                      onClick={() => onCancelOrder(trade.id)}
                                      style={{ padding: '5px 10px', fontSize: '11px' }}>
                                      Cancel
                                    </button>
                                  ) : (
                                    <>
                                      <button
                                        className="btn"
                                        onClick={() => isModifying ? cancelModify() : openModifyForm(trade)}
                                        style={{
                                          padding: '5px 10px', fontSize: '11px',
                                          background: isModifying ? 'var(--navy-border)' : 'var(--navy-card)',
                                          border: '1px solid var(--accent)',
                                          color: 'var(--accent)'
                                        }}>
                                        {isModifying ? 'Cancel' : 'Modify'}
                                      </button>
                                      <button
                                        className="btn"
                                        onClick={() => setPartialForm({ id: trade.id, lots: parseFloat(trade.lot_size).toFixed(2) })}
                                        style={{ padding: '5px 10px', fontSize: '11px', background: 'var(--navy-border)', color: 'var(--text-muted)' }}>
                                        Partial
                                      </button>
                                      <button
                                        className="btn btn-red"
                                        onClick={() => onCloseTrade(trade.id)}
                                        style={{ padding: '5px 10px', fontSize: '11px' }}>
                                        Close
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>

                            {/* Inline Partial Close Form */}
                            {!isPending && partialForm?.id === trade.id && (
                              <tr>
                                <td colSpan="9" style={{ padding: '0' }}>
                                  <div style={{ background: 'var(--navy-card)', border: '1px dashed var(--accent)', borderRadius: '8px', padding: '12px 16px', margin: '4px 0 8px 0', display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span style={{ fontSize: '12px', color: 'var(--text)' }}>Close Fraction (Current: {parseFloat(trade.lot_size).toFixed(2)}):</span>
                                    <input type="number" step="0.01" max={trade.lot_size} value={partialForm.val || ''} onChange={e => setPartialForm({ ...partialForm, val: e.target.value })} style={{ width: '80px', padding: '4px 8px', fontSize: '12px' }} />
                                    <button onClick={() => handlePartialClose(trade.id, trade.lot_size, partialForm.val)} className="btn btn-accent" style={{ padding: '4px 12px', fontSize: '11px' }}>Confirm Partial Close</button>
                                    <button onClick={() => setPartialForm(null)} className="btn" style={{ padding: '4px 12px', fontSize: '11px', background: 'transparent', border: '1px solid var(--navy-border)' }}>Cancel</button>
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
                                          step={trade.instrument.includes('XAU') || trade.instrument.includes('XAG') ? '0.01' : '0.00001'}
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
                                          step={trade.instrument.includes('XAU') || trade.instrument.includes('XAG') ? '0.01' : '0.00001'}
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
                                      <div style={{ color: 'var(--green)', fontSize: '12px', marginTop: '8px' }}>✅ {modifySuccess}</div>
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
              </div>
            )}

            {/* Trade History */}
            {tradeHistory.length > 0 && (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <h3 style={{ color: 'var(--accent)', fontSize: '15px', margin: 0 }}>
                    Trade History ({tradeHistory.length})
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
                          🔄 Repeat Last
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
                      ⬇ Export CSV
                    </button>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th><th>Type</th><th>Lots</th>
                        <th>Open Price</th><th>Close Price</th><th>Reason</th><th>P&L</th><th>📝</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tradeHistory.map(trade => {
                        const dec = getDecimals(trade.instrument)
                        const isCancelled = trade.status === 'cancelled'
                        const isEditingNote = editingNoteId === trade.id
                        return (
                          <React.Fragment key={trade.id}>
                            <tr style={{ opacity: isCancelled ? 0.6 : 1 }}>
                              <td style={{ fontWeight: '600' }}>{trade.instrument}</td>
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
                                      setEditingNoteId(null)
                                    } else {
                                      setEditingNoteId(trade.id)
                                      setNoteText(trade.trader_note || '')
                                      setNoteTags(trade.tags ? (typeof trade.tags === 'string' ? trade.tags : JSON.stringify(trade.tags)) : '')
                                      setNoteSaved(false)
                                    }
                                  }}
                                  style={{
                                    background: 'transparent',
                                    border: `1px solid ${trade.trader_note ? 'var(--accent)' : 'var(--navy-border)'}`,
                                    borderRadius: '4px',
                                    padding: '3px 6px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    color: trade.trader_note ? 'var(--accent)' : 'var(--text-dim)',
                                    title: trade.trader_note ? 'View/edit note' : 'Add note'
                                  }}
                                  title={trade.trader_note ? 'View/edit note' : 'Add note'}
                                >
                                  {trade.trader_note ? '📝' : '＋'}
                                </button>
                              </td>
                            </tr>

                            {/* Inline note editor row */}
                            {isEditingNote && (
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
                                    <input type="text" placeholder="Tags (comma separated, e.g. A+ Setup, Revenge)" value={noteTags} onChange={e => { setNoteTags(e.target.value); setNoteSaved(false) }} style={{ width: '100%', fontSize: '13px', background: 'var(--navy)', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '8px 12px', color: 'var(--accent)', fontFamily: 'DM Sans, sans-serif', marginBottom: '8px' }} />
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
                                        color: 'var(--text)', fontFamily: 'DM Sans, sans-serif',
                                        lineHeight: '1.5', marginBottom: '8px'
                                      }}
                                    />
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>{noteText.length}/1000</span>
                                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                        {noteSaved && <span style={{ fontSize: '11px', color: 'var(--green)' }}>✓ Saved</span>}
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
                                            fontFamily: 'DM Sans, sans-serif'
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
                          </React.Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>

          {/* Right — Order Panel */}
          <div className='order-panel-sticky' style={{ position: 'sticky', top: '84px' }}>
            <OrderPanel
              prices={prices}
              selectedAccount={selectedAccount}
              floatingBalance={floatingBalance}
              onOpenTrade={onOpenTrade}
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
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>
            {selectedAccount.status === 'passed' ? '🏆' : selectedAccount.status === 'expired' ? '⏰' : '❌'}
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

