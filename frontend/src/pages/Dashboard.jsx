import React, { Suspense, lazy, useState, useEffect, useMemo, useRef } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'
import toast from 'react-hot-toast'
import ThemeToggle from '../components/ThemeToggle'
import Sidebar from '../components/Sidebar'
import KYCUploadForm from '../components/dashboard/KYCUploadForm'
import DashboardHome from './DashboardHome'
import ChallengeRules from './ChallengeRules'
import Onboarding, { shouldShowOnboarding } from './Onboarding'
import Support from './Support'
import Dispute from './Dispute'
import Chat from './Chat'
import { calculatePnL } from '../utils/instruments'
import { createIdempotencyHeaders, normalizeApiError } from '../services/api'
import useStore from '../store/useStore'
import { renderIcon } from '../utils/iconMap'
import { calculatePayoutPreview, calculateRealizedProfit, formatCurrency, toMoneyNumber } from '../utils/finance'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../utils/accountVisibility'
import Pagination from '../components/Pagination'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const TradingPanel = lazy(() => import('../components/TradingPanel'))
const Analytics = lazy(() => import('./Analytics'))

function getStatusColor(status) {
  const c = {
    active: 'var(--accent)', passed: 'var(--green)', failed: 'var(--red)',
    funded: 'var(--cyan)', pending: 'var(--accent)', approved: 'var(--green)',
    paid: 'var(--green)', rejected: 'var(--red)', locked: '#8a8a8a'
  }
  return c[status] || 'var(--text-muted)'
}

function enrichTradesWithPrices(trades = [], currentPrices = {}) {
  return trades.map(trade => {
    if (trade.status === 'pending') return trade
    const priceData = currentPrices[trade.instrument]
    if (!priceData || trade.open_price == null) return trade

    const currentPrice = trade.direction === 'buy'
      ? parseFloat(priceData.bid)
      : parseFloat(priceData.ask)

    const floatingPnl = calculatePnL(
      trade.direction,
      parseFloat(trade.open_price),
      currentPrice,
      parseFloat(trade.lot_size),
      trade.instrument,
      parseFloat(trade.commission || 0)
    )

    return {
      ...trade,
      floating_pnl: floatingPnl,
      current_price: currentPrice
    }
  })
}

function formatMoney(value) {
  return toMoneyNumber(value).toFixed(2)
}

function DashboardSectionFallback({ label = 'Loading module...' }) {
  return (
    <div
      className="card ui-surface ui-empty-state"
      style={{
        padding: '32px',
        minHeight: '220px',
        color: 'var(--text-muted)'
      }}
    >
      {label}
    </div>
  )
}

function Dashboard({ user, onLogout }) {
  const [stats, setStats] = useState(null)
  const [accountRules, setAccountRules] = useState(null)
  const [tradeHistory, setTradeHistory] = useState([])
  const [payouts, setPayouts] = useState([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [activePage, setActivePage] = useState('dashboard')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === 'true'
  )
  const handleToggleSidebar = () => setSidebarCollapsed(prev => {
    const next = !prev
    localStorage.setItem('sidebarCollapsed', String(next))
    return next
  })
  const [orderForm, setOrderForm] = useState({
    instrument: 'EURUSD',
    lots: '0.01',
    stop_loss: '',
    take_profit: '',
    strategy_tag: '',
    journal_note: '',
    journal_tags: '',
    trailing_step_pips: '',
    trailing_activation_price: '',
    breakeven_trigger_pips: '',
    oco_enabled: false,
    oco_order_type: 'sell_stop',
    oco_pending_price: ''
  })
  const [payoutForm, setPayoutForm] = useState({ amount_requested: '', payment_method: 'crypto', payment_details: '' })
  const [kycStatus, setKycStatus] = useState(user?.kyc_status || 'not_submitted')
  const [kycCountry, setKycCountry] = useState(user?.kyc_document_country || user?.country || '')
  const [kycDocumentType, setKycDocumentType] = useState(user?.kyc_document_type || 'passport')
  const [kycDocumentNumber, setKycDocumentNumber] = useState(user?.kyc_document_number || '')
  const [idDocument, setIdDocument] = useState(null)
  const [idDocumentBack, setIdDocumentBack] = useState(null)
  const [selfie, setSelfie] = useState(null)
  const [kycUploading, setKycUploading] = useState(false)
  const [accountLoading, setAccountLoading] = useState(false)
  const [profitSharePct, setProfitSharePct] = useState(80)
  const [accountSubmitting, setAccountSubmitting] = useState(false)
  const [tradeSubmitting, setTradeSubmitting] = useState(false)
  const [closingTradeIds, setClosingTradeIds] = useState([])
  const [payoutSubmitting, setPayoutSubmitting] = useState(false)
  const [historyPage, setHistoryPage] = useState(1)
  const HISTORY_PAGE_SIZE = 8

  // ── Quota state: set when the backend returns quota_full on account creation ──
  const [quotaFull, setQuotaFull] = useState(false)
  const [quotaNextOpen, setQuotaNextOpen] = useState(null)

  // ── Notification centre ──
  const [notifications, setNotifications] = useState(() => {
    try { return JSON.parse(localStorage.getItem('notifications') || '[]') } catch { return [] }
  })
  const [showNotifications, setShowNotifications] = useState(false)

  // ── Account history ──
  const [accountHistory, setAccountHistory] = useState([])

  // ── Onboarding ──
  const [showOnboarding, setShowOnboarding] = useState(() => shouldShowOnboarding())

  // ── Platform announcement banner ──
  const [announcement, setAnnouncement] = useState(null)
  const [announcementDismissed, setAnnouncementDismissed] = useState(false)

  const {
    activeAccount: selectedAccount,
    allAccounts: accounts,
    setActiveAccount,
    setAllAccounts,
    switchAccount,
    prices,
    updatePrice,
    updatePrices,
    openPositions: openTrades,
    setOpenPositions,
    updatePositionPnL,
    addPosition,
    removePosition,
  } = useStore()
  const visibleAccounts = useMemo(() => filterVisibleTraderAccounts(accounts), [accounts])

  useEffect(() => {
    // Fetch on mount
    axios.get(`${API_URL}/api/announcement`)
      .then(res => { if (res.data) setAnnouncement(res.data) })
      .catch(() => {})
    // Re-poll every 5 minutes
    const iv = setInterval(() => {
      axios.get(`${API_URL}/api/announcement`)
        .then(res => {
          setAnnouncement(res.data || null)
          if (!res.data) setAnnouncementDismissed(false)
        })
        .catch(() => {})
    }, 5 * 60 * 1000)
    return () => clearInterval(iv)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const socketRef = useRef(null)
  const selectedAccountRef = useRef(null)
  const pricesRef = useRef({})
  const closingTradesRef = useRef(new Set())

  useEffect(() => { selectedAccountRef.current = selectedAccount }, [selectedAccount])
  useEffect(() => { pricesRef.current = prices }, [prices])

  function setSelectedAccount(account) {
    if (!account) {
      setActiveAccount(null)
      return
    }

    switchAccount(account.id)

    if (useStore.getState().activeAccount?.id !== account.id) {
      setActiveAccount(account)
    }
  }

  useEffect(() => {
    // FIX: include 'polling' as fallback — works behind proxies/firewalls that
    // block WebSocket upgrades. Socket.IO prefers WebSocket, falls back automatically.
    const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
    socketRef.current = socket
    socket.on('connect', () => {
      setConnected(true)
      if (user?.id) socket.emit('join_account', String(user.id))
    })
    socket.on('disconnect', () => setConnected(false))
    socket.on('price_update', (payload) => {
      const mergedPrices = payload?.instrument
        ? { ...pricesRef.current, [payload.instrument]: payload }
        : payload

      if (!mergedPrices || typeof mergedPrices !== 'object') return

      if (payload?.instrument) {
        updatePrice(payload.instrument, payload)
      } else if (data?.monthly_claim_limit) {
        const resetText = data.monthly_claim_limit.resets_at
          ? new Date(data.monthly_claim_limit.resets_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })
          : 'next month'
        const message = `Free account already claimed. Try again ${resetText}.`
        setError(message)
        toast.error(message)
      } else {
        updatePrices(mergedPrices)
      }

      pricesRef.current = mergedPrices
      setOpenPositions(enrichTradesWithPrices(useStore.getState().openPositions, mergedPrices))
    })
    socket.on('position_update', (data) => {
      const tradeId = data?.tradeId ?? data?.trade_id
      const floatingPnl = data?.floatingPnL ?? data?.floating_pnl ?? 0
      if (tradeId == null) return
      updatePositionPnL(tradeId, floatingPnl)
    })
    socket.on('trade_closed', (data) => {
      const tradeId = data?.tradeId ?? data?.trade_id
      const existingTrade = useStore.getState().openPositions.find(trade => trade.id === tradeId)
      if (tradeId == null) return
      const instrument = data?.instrument || existingTrade?.instrument || 'Trade'
      const pnl = Number(data?.pnl ?? data?.demo_pnl ?? 0)
      const profit = pnl >= 0
      toast(
        `${instrument} closed ${profit ? '+' : ''}$${formatMoney(pnl)}`,
        {
          icon: renderIcon(profit ? 'approve' : 'reject', { size: 16, color: profit ? 'var(--accent-green)' : 'var(--accent-red)' }),
          style: {
            borderLeft: `3px solid ${profit ? '#00FF88' : '#FF3B5C'}`
          }
        }
      )
      removePosition(tradeId)
    })
    socket.on('trade_opened', (data) => {
      if (!data?.position) return
      const openedPosition = enrichTradesWithPrices([data.position], pricesRef.current)[0]
      addPosition(openedPosition)
      toast(`Trade opened: ${openedPosition.instrument} ${openedPosition.direction}`, {
        icon: renderIcon('trade', { size: 16, color: 'var(--accent)' }),
        style: { borderLeft: '3px solid #00D4FF' }
      })
    })
    socket.on('account_passed', (data) => {
      toast.success(`Congratulations! You passed ${data?.phase || 'your challenge'}!`, {
        duration: 8000,
        icon: renderIcon('leaderboard', { size: 16, color: 'var(--accent-gold)' }),
        style: { borderLeft: '3px solid #FFD700' }
      })
    })
    socket.on('payout_approved', (data) => {
      toast.success(`Payout of $${formatMoney(data?.amount)} approved!`, {
        duration: 8000,
        icon: renderIcon('payouts', { size: 16, color: 'var(--accent-gold)' }),
        style: { borderLeft: '3px solid #FFD700' }
      })
    })
    socket.on('sl_triggered', (data) => {
      const slipMsg = Number(data?.slippage_pips || 0) > 0
        ? ` (${data.slippage_pips} pip slippage)`
        : ''
      toast(`SL triggered on ${data?.instrument || 'trade'}${slipMsg}`, {
        icon: renderIcon('warning', { size: 16, color: 'var(--accent-red)' }),
        style: { borderLeft: '3px solid #FF3B5C' }
      })
    })
    socket.on('tp_triggered', (data) => {
      toast.success(`TP hit on ${data?.instrument || 'trade'}! +$${formatMoney(data?.pnl)}`, {
        icon: renderIcon('target', { size: 16, color: 'var(--accent-green)' }),
        style: { borderLeft: '3px solid #00FF88' }
      })
    })
    socket.on('account_update', (data) => {
      if (data?.message) {
        setSuccess(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''))
        pushNotification(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''),
          data.event === 'account_failed' ? 'error' : (data.event === 'phase1_passed' || data.event === 'phase2_passed') ? 'success' : 'info')
      }
      if (data?.event === 'phase1_passed' || data?.event === 'phase2_passed') {
        const phaseLabel = data?.event === 'phase1_passed' ? 'Phase 1' : 'Phase 2'
        toast.success(`Congratulations! You passed ${phaseLabel}!`, {
          duration: 8000,
          icon: renderIcon('leaderboard', { size: 16, color: 'var(--accent-gold)' }),
          style: { borderLeft: '3px solid #FFD700' }
        })
      }
      if (selectedAccountRef.current) {
        fetchStats(selectedAccountRef.current.id)
        fetchAccountRules(selectedAccountRef.current.id)
        fetchOpenTrades(selectedAccountRef.current.id)
        fetchTradeHistory(selectedAccountRef.current.id)
      }
      // FIX: Auto-select the newly promoted account when a phase is passed.
      // The backend emits new_account_id on phase1_passed and phase2_passed events.
      // Without this, the trader sees the old (passed) account selected and has to
      // manually click the new Phase 2 / Funded account to start trading it.
      fetchAccounts().then((latestAccounts) => {
        if (data?.new_account_id && latestAccounts) {
          const newAcc = latestAccounts.find(a => a.id === data.new_account_id)
          if (newAcc) setSelectedAccount(newAcc)
        }
      })
      fetchAccountHistory()
    })

    // ── Drawdown warning alerts (50% / 75% / 90% of limit) ───────────────────
    socket.on('drawdown_warning', (data) => {
      if (!data?.message) return
      const percentage = data?.percentage ?? data?.warning_level ?? 0
      const type = percentage >= 90 ? 'error'
        : percentage >= 75 ? 'warning'
        : 'info'
      pushNotification(data.message, type)
      toast.error(
        `Warning: ${percentage}% drawdown used. Trade carefully.`,
        {
          duration: 10000,
          icon: renderIcon('warning', { size: 16, color: 'var(--accent-red)' }),
        }
      )
      setError(data.message)
    })
    return () => socket.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchAccounts(); fetchPrices(); fetchPayouts(); fetchPayoutSettings(); fetchAccountHistory() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedAccount) {
      setAccountLoading(true)
      setOpenPositions([])
      setStats(null)
      setAccountRules(null)
      setTradeHistory([])
      Promise.all([
        fetchStats(selectedAccount.id),
        fetchAccountRules(selectedAccount.id),
        fetchOpenTrades(selectedAccount.id),
        fetchTradeHistory(selectedAccount.id)
      ]).finally(() => setAccountLoading(false))
    }
  }, [selectedAccount?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedAccount || isTraderAccountVisible(selectedAccount)) return
    setActiveAccount(visibleAccounts[0] || null)
  }, [selectedAccount?.id, visibleAccounts, setActiveAccount]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error || success) {
      const t = setTimeout(() => { setError(''); setSuccess('') }, 5000)
      return () => clearTimeout(t)
    }
  }, [error, success])

  // Poll KYC status every 30s
  useEffect(() => {
    const pollKyc = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/auth/me`)
        const newStatus = res.data?.kyc_status
        if (newStatus && newStatus !== kycStatus) {
          setKycStatus(newStatus)
        }
      } catch {}
    }
    const interval = setInterval(pollKyc, 30000)
    return () => clearInterval(interval)
  }, [kycStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchAccounts() {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/my-accounts`)
      const latestAccounts = Array.isArray(res.data) ? res.data : []
      const latestVisibleAccounts = filterVisibleTraderAccounts(latestAccounts)
      setAllAccounts(latestAccounts)
      if (selectedAccountRef.current?.id) {
        const refreshed = latestVisibleAccounts.find(account => account.id === selectedAccountRef.current.id)
        setActiveAccount(refreshed || latestVisibleAccounts[0] || null)
      } else if (latestVisibleAccounts.length > 0) {
        setActiveAccount(latestVisibleAccounts[0])
      }
      return res.data
    } catch { setError('Could not fetch accounts') }
  }

  async function fetchPrices() {
    try {
      const res = await axios.get(`${API_URL}/api/prices`)
      updatePrices(res.data)
      pricesRef.current = res.data
    } catch {}
  }

  async function fetchStats(id) {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/stats/${id}`)
      setStats(res.data)
    } catch (err) {
      console.error('[Dashboard] fetchStats failed:', err.response?.data?.error || err.message)
      // Keep stats null so the loading state shows rather than a blank page
    }
  }

  async function fetchAccountRules(id) {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/rules/${id}`)
      setAccountRules(res.data)
    } catch {}
  }

  async function fetchOpenTrades(id) {
    try {
      const [openRes, pendingRes] = await Promise.all([
        axios.get(`${API_URL}/api/trades/open`, { params: { account_id: id } }),
        axios.get(`${API_URL}/api/trades/pending`, { params: { account_id: id } })
      ])
      const mergedTrades = [
        ...(Array.isArray(openRes.data) ? openRes.data : []),
        ...(Array.isArray(pendingRes.data) ? pendingRes.data : [])
      ]
      setOpenPositions(enrichTradesWithPrices(mergedTrades, pricesRef.current))
    } catch {}
  }

  async function fetchTradeHistory(id) {
    try { const res = await axios.get(`${API_URL}/api/trades/history`, { params: { account_id: id } }); setTradeHistory(res.data) } catch {}
  }

  async function fetchPayouts() {
    try { const res = await axios.get(`${API_URL}/api/payouts/my-payouts`); setPayouts(res.data) } catch {}
  }

  async function fetchPayoutSettings() {
    try {
      const res = await axios.get(`${API_URL}/api/payouts/settings`)
      if (res.data?.profit_share_pct) setProfitSharePct(parseFloat(res.data.profit_share_pct))
    } catch {}
  }

  function pushNotification(message, type = 'info') {
    // FIX (MEDIUM #14): Use crypto.randomUUID() instead of Date.now() to prevent
    // ID collisions when two notifications arrive in the same millisecond.
    const notif = { 
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, 
      message, 
      type, 
      time: new Date().toISOString(), 
      read: false 
    }
    setNotifications(prev => {
      const updated = [notif, ...prev].slice(0, 50)
      localStorage.setItem('notifications', JSON.stringify(updated))
      return updated
    })
  }

  function markAllRead() {
    setNotifications(prev => {
      const updated = prev.map(n => ({ ...n, read: true }))
      localStorage.setItem('notifications', JSON.stringify(updated))
      return updated
    })
  }

  function clearNotifications() {
    setNotifications([])
    localStorage.removeItem('notifications')
  }

  async function fetchAccountHistory() {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/history`)
      setAccountHistory(res.data)
    } catch {}
  }

  async function createAccount(size, options = {}) {
    if (accountSubmitting) return
    setAccountSubmitting(true)
    try {
      // Clear any previous quota state before trying
      setQuotaFull(false)
      setQuotaNextOpen(null)
      const payload = { account_size: size }
      if (options.challengeOrderId) {
        payload.challenge_order_id = options.challengeOrderId
      }
      await axios.post(`${API_URL}/api/accounts/create`, payload, {
        headers: createIdempotencyHeaders('accounts:create'),
        skipAuthRedirect: true
      })
      setSuccess('Challenge account created!')
      fetchAccounts()
    } catch (err) {
      const data = err.response?.data
      if (data?.quota_full) {
        // Backend told us quota is full — show the dedicated banner instead of the error toast
        setQuotaFull(true)
        setQuotaNextOpen(data.next_open || null)
      } else {
        setError(normalizeApiError(err, 'Could not create account').message)
      }
    } finally {
      setAccountSubmitting(false)
    }
  }

  async function openTrade({
    direction,
    orderType,
    pendingPrice,
    strategyTag,
    journalNote,
    journalTags,
    trailingStepPips,
    trailingActivationPrice,
    breakevenTriggerPips,
    ocoSibling
  }) {
    if (tradeSubmitting) return
    setTradeSubmitting(true)
    try {
      setError('')
      const payload = {
        account_id: selectedAccount.id,
        instrument: orderForm.instrument,
        direction,
        lots: parseFloat(orderForm.lots),
        order_type: orderType,
      }
      if (pendingPrice) payload.pending_price = pendingPrice
      if (orderForm.stop_loss) payload.stop_loss = parseFloat(orderForm.stop_loss)
      if (orderForm.take_profit) payload.take_profit = parseFloat(orderForm.take_profit)
      if (strategyTag) payload.strategy_tag = strategyTag
      if (journalNote) payload.trader_note = journalNote
      if (journalTags) payload.tags = journalTags
      if (trailingStepPips) payload.trailing_step_pips = parseInt(trailingStepPips, 10)
      if (trailingActivationPrice) payload.trailing_activation_price = parseFloat(trailingActivationPrice)
      if (breakevenTriggerPips) payload.breakeven_trigger_pips = parseFloat(breakevenTriggerPips)
      if (ocoSibling) payload.oco_sibling = ocoSibling
      await axios.post(`${API_URL}/api/trades/open`, payload, {
        headers: createIdempotencyHeaders('trades:open')
      })
      setSuccess(`${orderType === 'market' ? direction.toUpperCase() : orderType.replace(/_/g, ' ').toUpperCase()} order placed on ${orderForm.instrument}`)
      setOrderForm(f => ({
        ...f,
        stop_loss: '',
        take_profit: '',
        journal_note: '',
        journal_tags: '',
        trailing_step_pips: '',
        trailing_activation_price: '',
        breakeven_trigger_pips: '',
        oco_enabled: false,
        oco_order_type: 'sell_stop',
        oco_pending_price: ''
      }))
      fetchOpenTrades(selectedAccount.id)
      fetchStats(selectedAccount.id)
    } catch (err) {
      setError(normalizeApiError(err, 'Could not open trade').message)
    } finally {
      setTradeSubmitting(false)
    }
  }

  async function closeTrade(tradeId, options = {}) {
    if (closingTradesRef.current.has(tradeId)) return false
    closingTradesRef.current.add(tradeId)
    setClosingTradeIds((current) => (current.includes(tradeId) ? current : [...current, tradeId]))
    try {
      const payload = { trade_id: tradeId }
      if (options.closeLots) payload.close_lots = options.closeLots
      const res = await axios.post(`${API_URL}/api/trades/close`, payload)
      setSuccess(`${options.closeLots ? 'Partial close executed' : 'Trade closed'}. P&L: $${res.data.pnl}`)
      fetchOpenTrades(selectedAccount.id)
      fetchStats(selectedAccount.id)
      fetchTradeHistory(selectedAccount.id)
      return true
    } catch (err) {
      setError(err.response?.data?.error || 'Could not close trade')
      return false
    } finally {
      closingTradesRef.current.delete(tradeId)
      setClosingTradeIds((current) => current.filter((id) => id !== tradeId))
    }
  }

  async function cancelOrder(tradeId) {
    try {
      await axios.post(`${API_URL}/api/trades/cancel`, { trade_id: tradeId })
      setSuccess('Pending order cancelled')
      fetchOpenTrades(selectedAccount.id)
    } catch (err) { setError(err.response?.data?.error || 'Could not cancel order') }
  }

  function handleTradeModified() {
    if (selectedAccount) {
      fetchOpenTrades(selectedAccount.id)
      fetchStats(selectedAccount.id)
      fetchTradeHistory(selectedAccount.id)
    }
  }

  async function uploadKYC(e) {
    e.preventDefault()
    if (!idDocument || !idDocumentBack || !selfie) {
      return setError('Please upload ID front, ID back, and live photo')
    }
    if (!kycCountry.trim()) return setError('Please enter your country of residence')
    if (!kycDocumentType) return setError('Please choose your document type')
    if (!kycDocumentNumber.trim()) return setError('Please enter your document number')
    try {
      setKycUploading(true)
      const formData = new FormData()
      formData.append('country', kycCountry.trim())
      formData.append('document_type', kycDocumentType)
      formData.append('document_number', kycDocumentNumber.trim())
      formData.append('id_document', idDocument)
      formData.append('id_document_back', idDocumentBack)
      formData.append('selfie', selfie)
      await axios.post(`${API_URL}/api/kyc/upload`, formData)
      setKycStatus('pending')
      setSuccess('KYC documents uploaded! Admin will review within 24 hours.')
      setIdDocument(null)
      setIdDocumentBack(null)
      setSelfie(null)
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
    } finally {
      setKycUploading(false)
    }
  }

  async function requestPayout(e) {
    e.preventDefault()
    if (payoutSubmitting) return
    setPayoutSubmitting(true)
    try {
      await axios.post(`${API_URL}/api/payouts/request`, {
        account_id: selectedAccount.id,
        amount_requested: parseFloat(payoutForm.amount_requested),
        payment_method: payoutForm.payment_method,
        payment_details: payoutForm.payment_details
      }, {
        headers: createIdempotencyHeaders('payouts:request')
      })
      setSuccess('Payout request submitted!')
      setPayoutForm({ amount_requested: '', payment_method: 'crypto', payment_details: '' })
      fetchPayouts()
    } catch (err) {
      setError(normalizeApiError(err, 'Could not submit payout').message)
    } finally {
      setPayoutSubmitting(false)
    }
  }

  const fundedAccount = accounts.find(a => a.account_type === 'funded' && a.status === 'active')
  const availableProfit = fundedAccount
    ? Math.max(0, calculateRealizedProfit(fundedAccount.current_balance, fundedAccount.starting_balance))
    : 0

  return (
    <div className="mode-trader ui-shell dashboard-layout">

      {/* ── Onboarding walkthrough — shown on first login ── */}
      {showOnboarding && (
        <Onboarding
          onComplete={() => setShowOnboarding(false)}
          onNavigate={(page) => {
            setShowOnboarding(false)
            setActivePage(page)
          }}
        />
      )}

      {/* ── Platform Announcement Banner ── */}
      {announcement && !announcementDismissed && (() => {
        // FIX (BUG-L3): All four types rendered identical grey shades; now uses proper semantic colors
        const colors = {
          info:    { bg: 'rgba(100, 180, 255, 0.10)', border: 'rgba(100, 180, 255, 0.4)', text: '#60b4ff', icon: 'info' },
          warning: { bg: 'rgba(255, 180, 50, 0.10)',  border: 'rgba(255, 180, 50, 0.4)',  text: '#ffb432', icon: 'warning' },
          success: { bg: 'rgba(80, 200, 120, 0.10)',  border: 'rgba(80, 200, 120, 0.4)',  text: '#50c878', icon: 'approve' },
          error:   { bg: 'rgba(240, 80, 80, 0.10)',   border: 'rgba(240, 80, 80, 0.4)',   text: '#f05050', icon: 'reject' },
        }
        const c = colors[announcement.type] || colors.info
        return (
          <div style={{
            background: c.bg, borderBottom: `1px solid ${c.border}`,
            padding: '10px 24px',
            display: 'flex', alignItems: 'center', gap: '10px',
            position: 'sticky', top: '57px', zIndex: 90
          }}>
            <span style={{ display: 'inline-flex' }}>
              {renderIcon(c.icon, { size: 16, color: c.text })}
            </span>
            <span style={{ flex: 1, fontSize: '13px', color: c.text, fontWeight: '500' }}>
              {announcement.message}
            </span>
            <button
              onClick={() => setAnnouncementDismissed(true)}
              style={{ background: 'none', border: 'none', color: c.text, cursor: 'pointer', fontSize: '16px', opacity: 0.7, padding: '0 4px' }}
            >
              {renderIcon('close', { size: 16, color: c.text })}
            </button>
          </div>
        )
      })()}

      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        kycStatus={kycStatus}
        pendingPayouts={payouts.filter(p => p.status === 'pending').length}
        unreadNotifications={notifications.filter(n => !n.read).length}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />

      {/* Main Content */}
      <div className="dashboard-main animate-fade-up" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* Top Nav */}
      <div className="nav dashboard-topbar" style={{ 
        margin: '16px 24px', 
        borderRadius: '16px', 
        background: 'var(--bg-surface)', 
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--border)',
        boxShadow: 'var(--shadow-surface)' 
      }}>
        <div className="dashboard-topbar-left" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span style={{ display: 'inline-flex' }}>
            {renderIcon('activity', { size: 14, color: connected ? 'var(--accent-green)' : 'var(--accent-red)' })}
          </span>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Terminal Status</span>
          <span className={`badge ${connected ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: '10px', padding: '4px 10px', boxShadow: connected ? '0 0 10px rgba(16,185,129,0.3)' : '0 0 10px rgba(239,68,68,0.3)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              {renderIcon(connected ? 'activity' : 'close', { size: 10, color: 'currentColor' })}
              <span>{connected ? 'LIVE SYNC' : 'OFFLINE'}</span>
            </span>
          </span>
        </div>
        <div className="dashboard-topbar-right" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span className="dashboard-user-name" style={{ color: 'var(--text-secondary)', fontSize: '13px', fontWeight: '500' }}>{user?.full_name || 'Trader'}</span>
          {kycStatus !== 'approved' && (
            <span className={`badge ${kycStatus === 'pending' ? 'badge-warning' : 'badge-danger'}`} onClick={() => setActivePage('kyc')} style={{ cursor: 'pointer' }}>
              <span style={{ display: 'inline-flex', marginRight: '6px', verticalAlign: 'middle' }}>
                {renderIcon(kycStatus === 'pending' ? 'timer' : 'warning', {
                  size: 12,
                  color: kycStatus === 'pending' ? 'var(--accent-gold)' : 'var(--accent-red)'
                })}
              </span>
              {kycStatus === 'pending' ? 'KYC Pending' : 'Complete KYC'}
            </span>
          )}
          {kycStatus === 'approved' && (
            <span className="badge badge-success">
              <span style={{ display: 'inline-flex', marginRight: '6px', verticalAlign: 'middle' }}>
                {renderIcon('approve', { size: 12, color: 'var(--accent-green)' })}
              </span>
              KYC Verified
            </span>
          )}

          {/* ── Notification Bell ── */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => { 
                setShowNotifications(p => {
                  if (!p) markAllRead()
                  return !p
                })
              }}
              className="btn btn-secondary" style={{ padding: '6px 10px', fontSize: '16px' }}
            >
              {renderIcon('bell', { size: 16, color: 'var(--text-primary)' })}
              {notifications.filter(n => !n.read).length > 0 && (
                <span className="badge badge-danger" style={{
                  position: 'absolute', top: '-6px', right: '-6px',
                  padding: '2px 6px', fontSize: '9px'
                }}>
                  {notifications.filter(n => !n.read).length}
                </span>
              )}
            </button>
            {showNotifications && (
              <div style={{
                position: 'absolute', right: 0, top: '42px', width: '320px', maxHeight: '400px',
                background: 'var(--bg-surface)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', zIndex: 999,
                overflow: 'hidden', display: 'flex', flexDirection: 'column'
              }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: '600', fontSize: '13px', color: 'var(--accent)' }}>Notifications</span>
                  {notifications.length > 0 && (
                    <button onClick={clearNotifications} className="btn-ghost" style={{ border: 'none', color: 'var(--text-secondary)', fontSize: '11px', cursor: 'pointer' }}>Clear all</button>
                  )}
                </div>
                <div style={{ overflowY: 'auto', maxHeight: '340px' }}>
                  {notifications.length === 0 ? (
                    <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>No notifications yet</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} style={{
                        padding: '12px 16px', borderBottom: '1px solid var(--border)',
                        borderLeft: `3px solid ${n.type === 'error' ? 'var(--danger)' : n.type === 'success' ? 'var(--success)' : 'var(--accent)'}`,
                        background: 'transparent'
                      }}>
                        <div style={{ fontSize: '13px', color: 'var(--text-primary)', marginBottom: '4px' }}>{n.message}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                          {new Date(n.time).toLocaleString()}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <ThemeToggle />
          <button className="btn btn-danger" onClick={onLogout} style={{ padding: '6px 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {renderIcon('logout', { size: 14, color: 'currentColor' })}
            <span>Logout</span>
          </button>
        </div>
      </div>

      <div className="dashboard-page-content dashboard-page-stack ui-shell-section">
        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}

        {/* Dashboard Page */}
        {activePage === 'dashboard' && (
          <DashboardHome
            user={user}
            stats={stats}
            openTrades={openTrades}
            accounts={visibleAccounts}
            selectedAccount={selectedAccount}
            setSelectedAccount={setSelectedAccount}
            onCreateAccount={createAccount}
            getStatusColor={getStatusColor}
            profitSharePct={profitSharePct}
            quotaFull={quotaFull}
            quotaNextOpen={quotaNextOpen}
            onOpenRulesPage={() => setActivePage('rules')}
          />
        )}

        {activePage === 'rules' && (
          <ChallengeRules
            selectedAccount={selectedAccount}
            accountRules={accountRules}
            stats={stats}
            openTrades={openTrades}
            onTradeNow={() => setActivePage('trade')}
          />
        )}

        {/* Trade Page */}
        {activePage === 'trade' && (
          kycStatus !== 'approved' ? (
            <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                {renderIcon('kyc', { size: 48, color: 'var(--accent)' })}
              </div>
              <h3 className="page-title" style={{ marginBottom: '12px', fontSize: '20px' }}>KYC Required</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '20px' }}>Complete your identity verification to start trading.</p>
              <button className="btn btn-primary" onClick={() => setActivePage('kyc')} style={{ padding: '12px 32px' }}>Complete KYC</button>
            </div>
          ) : (
            <Suspense fallback={<DashboardSectionFallback label="Loading trading terminal..." />}>
              <TradingPanel
                prices={prices}
                selectedAccount={selectedAccount}
                accounts={visibleAccounts}
                setSelectedAccount={setSelectedAccount}
                openTrades={openTrades}
                tradeHistory={tradeHistory}
                orderForm={orderForm}
                setOrderForm={setOrderForm}
                onOpenTrade={openTrade}
                onCloseTrade={closeTrade}
                closingTradeIds={closingTradeIds}
                onCancelOrder={cancelOrder}
                getStatusColor={getStatusColor}
                stats={stats}
                
                onTradeModified={handleTradeModified}
                accountLoading={accountLoading}
              />
            </Suspense>
          )
        )}

        {/* Analytics Page */}
        {activePage === 'analytics' && (
          <Suspense fallback={<DashboardSectionFallback label="Loading analytics..." />}>
            <Analytics
              selectedAccount={selectedAccount}
              
            />
          </Suspense>
        )}

        {/* KYC Page */}
        {activePage === 'kyc' && (
          <div>
            <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Identity Verification</h2>
            {kycStatus === 'approved' ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  {renderIcon('approve', { size: 48, color: 'var(--accent-green)' })}
                </div>
                <h3 style={{ color: 'var(--green)', marginBottom: '12px' }}>KYC Verified</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your identity has been verified. You can start trading.</p>
              </div>
            ) : kycStatus === 'pending' ? (
              <div className="card" style={{ textAlign: 'left', padding: '28px', marginBottom: '20px', border: '1px solid rgba(245, 158, 11, 0.35)', maxWidth: '720px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '10px' }}>
                  {renderIcon('timer', { size: 40, color: 'var(--accent-gold)' })}
                  <div>
                    <h3 style={{ color: 'var(--accent)', margin: 0 }}>KYC Under Review</h3>
                    <p style={{ color: 'var(--text-muted)', margin: '6px 0 0', lineHeight: 1.6 }}>
                      Your documents were submitted successfully. The upload form is locked while admin reviews your KYC. If it is declined, you can resubmit corrected documents here.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                {kycStatus === 'rejected' && (
                  <div className="card" style={{ textAlign: 'center', padding: '24px', marginBottom: '20px', border: '1px solid var(--red)', maxWidth: '720px' }}>
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                      {renderIcon('reject', { size: 32, color: 'var(--accent-red)' })}
                    </div>
                    <h3 style={{ color: 'var(--red)', marginBottom: '8px' }}>KYC Rejected</h3>
                    <p style={{ color: 'var(--text-muted)' }}>Your documents were rejected. Please re-submit.</p>
                    {user?.kyc_rejection_reason && (
                      <div style={{ marginTop: '12px', padding: '12px 16px', background: 'rgba(97, 97, 97, 0.08)', border: '1px solid rgba(97, 97, 97, 0.3)', borderRadius: '8px', textAlign: 'left' }}>
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '6px' }}>Reason from Admin</div>
                        <div style={{ fontSize: '14px', color: 'var(--text)' }}>{user.kyc_rejection_reason}</div>
                      </div>
                    )}
                  </div>
                )}
                <KYCUploadForm
                  onSubmit={uploadKYC}
                  country={kycCountry}
                  setCountry={setKycCountry}
                  documentType={kycDocumentType}
                  setDocumentType={setKycDocumentType}
                  documentNumber={kycDocumentNumber}
                  setDocumentNumber={setKycDocumentNumber}
                  idDocument={idDocument}
                  setIdDocument={setIdDocument}
                  idDocumentBack={idDocumentBack}
                  setIdDocumentBack={setIdDocumentBack}
                  selfie={selfie}
                  setSelfie={setSelfie}
                  uploading={kycUploading}
                />
              </div>
            )}
          </div>
        )}

        {/* Payouts Page */}
        {activePage === 'payouts' && (
          <div>
            <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Payouts</h2>
            {!fundedAccount ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  {renderIcon('payouts', { size: 48, color: 'var(--accent-gold)' })}
                </div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Funded Account Yet</h3>
                <p style={{ color: 'var(--text-muted)' }}>Complete Phase 1 and Phase 2 to unlock payouts.</p>
              </div>
            ) : (
              <div>
                <div className="grid-2" style={{ marginBottom: '20px', maxWidth: '600px' }}>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: 'var(--green)' }}>{formatCurrency(availableProfit)}</div>
                    <div className="stat-label">Available Profit</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: 'var(--accent)' }}>{profitSharePct}%</div>
                    <div className="stat-label">Your Profit Share</div>
                  </div>
                </div>

                <div className="card" style={{ marginBottom: '20px', maxWidth: '700px' }}>
                  <h3 style={{ marginBottom: '20px', color: 'var(--accent)' }}>Request Payout</h3>
                  <form onSubmit={requestPayout}>
                    <div className="grid-2 payout-form-grid">
                      <div>
                        <label>Amount to Withdraw ($)</label>
                        <input type="number" value={payoutForm.amount_requested}
                          onChange={e => setPayoutForm({ ...payoutForm, amount_requested: e.target.value })}
                          placeholder={`Max ${formatCurrency(availableProfit)}`} min="50" max={availableProfit} step="0.01" required />
                        {payoutForm.amount_requested && (
                          <p style={{ fontSize: '13px', color: 'var(--green-light)', marginTop: '6px' }}>
                            You will receive: {formatCurrency(calculatePayoutPreview(payoutForm.amount_requested || 0, profitSharePct))} ({profitSharePct}% share)
                          </p>
                        )}
                        <label>Payment Method</label>
                        <select value={payoutForm.payment_method} onChange={e => setPayoutForm({ ...payoutForm, payment_method: e.target.value })}>
                          <option value="crypto">Cryptocurrency (USDT/BTC)</option>
                          <option value="bank">Bank Transfer</option>
                          <option value="wise">Wise</option>
                          <option value="paypal">PayPal</option>
                        </select>
                      </div>
                      <div>
                        <label>Payment Details</label>
                        <textarea value={payoutForm.payment_details}
                          onChange={e => setPayoutForm({ ...payoutForm, payment_details: e.target.value })}
                          placeholder="Enter your payment details" rows="5" required style={{ resize: 'vertical' }} />
                      </div>
                    </div>
                    <button className="btn btn-accent" type="submit" style={{ marginTop: '16px', padding: '12px 32px' }} disabled={availableProfit < 50}>
                      {availableProfit < 50 ? 'Minimum $50 required' : 'Submit Payout Request'}
                    </button>
                  </form>
                </div>

                {payouts.length > 0 && (
                  <div className="card" style={{ maxWidth: '900px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                      <h3 style={{ color: 'var(--accent)', margin: 0 }}>Payout History</h3>
                      {payouts.some(p => p.status === 'paid') && (
                        <button
                          onClick={() => {
                            const link = document.createElement('a')
                            link.href = `${API_URL}/api/payouts/statement`
                            link.target = '_blank'
                            link.click()
                          }}
                          style={{
                            background: 'transparent',
                            border: '1px solid rgba(148, 148, 148, 0.3)',
                            borderRadius: '6px',
                            padding: '6px 14px',
                            fontSize: '12px',
                            color: 'var(--accent)',
                            cursor: 'pointer',
                            transition: 'all 0.15s'
                          }}
                          onMouseEnter={e => e.currentTarget.style.background = 'rgba(148, 148, 148, 0.08)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          title="Download your payout statement as HTML (printable / save as PDF)"
                        >
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                            {renderIcon('download', { size: 14, color: 'currentColor' })}
                            <span>Download Statement</span>
                          </span>
                        </button>
                      )}
                    </div>
                    <table>
                      <thead>
                        <tr>
                          <th>Trader ID</th>
                          <th>Account ID</th>
                          <th>Amount</th>
                          <th>You Receive</th>
                          <th>Method</th>
                          <th>Status</th>
                          <th>Requested</th>
                          <th>Paid</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payouts.map(p => (
                          <tr key={p.id}>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{user?.trader_uid || user?.trader_id || '—'}</td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>{p.account_uid || p.account_id || '—'}</td>
                            <td>${parseFloat(p.amount_requested).toFixed(2)}</td>
                            <td style={{ color: 'var(--green)' }}>${parseFloat(p.amount_payable).toFixed(2)}</td>
                            <td>{p.payment_method}</td>
                            <td style={{ color: getStatusColor(p.status) }}>{p.status.toUpperCase()}</td>
                            <td>{new Date(p.requested_at).toLocaleDateString()}</td>
                            {/* FIX (BUG-L2): was p.processed_at but backend column is paid_at */}
                            <td>{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—'}</td>
                            <td>${parseFloat(p.amount_requested).toFixed(2)}</td>
                            <td style={{ color: 'var(--green)' }}>${parseFloat(p.amount_payable).toFixed(2)}</td>
                            <td>{p.payment_method}</td>
                            <td style={{ color: getStatusColor(p.status) }}>{p.status.toUpperCase()}</td>
                            <td>{new Date(p.requested_at).toLocaleDateString()}</td>
                            {/* FIX (BUG-L2): was p.processed_at but backend column is paid_at */}
                            <td>{p.paid_at ? new Date(p.paid_at).toLocaleDateString() : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
        {/* Account History Page */}
        {activePage === 'history' && (
          <div>
            <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Account History</h2>
            {accountHistory.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  {renderIcon('file', { size: 48, color: 'var(--accent)' })}
                </div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No History Yet</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your challenge history will appear here once you complete or start a challenge.</p>
              </div>
            ) : (() => {
              const totalHistPages = Math.ceil(accountHistory.length / HISTORY_PAGE_SIZE)
              const pagedHistory = accountHistory.slice(
                (historyPage - 1) * HISTORY_PAGE_SIZE,
                historyPage * HISTORY_PAGE_SIZE
              )
              return (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {pagedHistory.map(acc => {
                      const pnl = parseFloat(acc.total_pnl || 0)
                      const trades = parseInt(acc.total_trades || 0)
                      const wins = parseInt(acc.winning_trades || 0)
                      const winRate = trades > 0 ? ((wins / trades) * 100).toFixed(0) : 0
                      const statusColors = {
                        active: 'var(--accent)', passed: 'var(--green)', failed: 'var(--red)',
                        funded: 'var(--cyan)', expired: '#878787', locked: '#8a8a8a'
                      }
                      const statusColor = statusColors[acc.status] || 'var(--text-muted)'
                      return (
                        <div key={acc.id} className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', borderLeft: `3px solid ${statusColor}` }}>
                          <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                            <div>
                              <div style={{ fontWeight: '700', fontSize: '15px', color: 'var(--accent)', marginBottom: '4px' }}>
                                {acc.account_type.toUpperCase()} — ${parseFloat(acc.account_size).toLocaleString('en-US')}
                              </div>
                              <div style={{ fontSize: '12px', color: 'var(--text-dim)' }}>
                                Started {acc.phase_start_date ? new Date(acc.phase_start_date).toLocaleDateString() : '—'}
                                {acc.phase_end_date && acc.status !== 'active' && ` · Ended ${new Date(acc.phase_end_date).toLocaleDateString()}`}
                              </div>
                            </div>
                            <span style={{ padding: '3px 10px', borderRadius: '99px', fontSize: '11px', fontWeight: '700', color: statusColor, border: `1px solid ${statusColor}`, background: 'rgba(0,0,0,0.05)' }}>
                              {acc.status.toUpperCase()}
                            </span>
                          </div>
                          <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '15px', fontWeight: '700', color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                                {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Total P&L</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text)' }}>{trades}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Trades</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text)' }}>{winRate}%</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Win Rate</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '15px', fontWeight: '700', color: 'var(--text)' }}>
                                ${parseFloat(acc.current_balance).toFixed(0)}
                              </div>
                              <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>Final Balance</div>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                  <Pagination
                    page={historyPage}
                    totalPages={totalHistPages}
                    onPageChange={p => { setHistoryPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
                    pageSize={HISTORY_PAGE_SIZE}
                    total={accountHistory.length}
                  />
                </>
              )
            })()}
          </div>
        )}

        {/* Support Page */}
        {activePage === 'support' && (
          <Support user={user} />
        )}

        {/* Dispute Page */}
        {activePage === 'dispute' && (
          <Dispute user={user} accounts={accounts} />
        )}

        {/* Live Chat Page */}
        {activePage === 'chat' && (
          <Chat />
        )}

      </div>
    </div>
  )
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ALLOWED_ID_TYPES     = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf']
const ALLOWED_SELFIE_TYPES = ['image/jpeg', 'image/jpg', 'image/png']
const MAX_FILE_SIZE        = 5 * 1024 * 1024 // 5 MB

function LegacyKYCUploadForm({ onSubmit, idDocument, setIdDocument, selfie, setSelfie, uploading }) {
  const [idError, setIdError]         = React.useState('')
  const [selfieError, setSelfieError] = React.useState('')

  function handleIdChange(e) {
    const file = e.target.files[0]
    if (!file) return
    if (!ALLOWED_ID_TYPES.includes(file.type)) {
      setIdError('ID must be JPG, PNG or PDF')
      setIdDocument(null)
      e.target.value = ''
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setIdError('ID file must be under 5MB')
      setIdDocument(null)
      e.target.value = ''
      return
    }
    setIdError('')
    setIdDocument(file)
  }

  function handleSelfieChange(e) {
    const file = e.target.files[0]
    if (!file) return
    if (!ALLOWED_SELFIE_TYPES.includes(file.type)) {
      setSelfieError('Selfie must be JPG or PNG (no PDFs)')
      setSelfie(null)
      e.target.value = ''
      return
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelfieError('Selfie file must be under 5MB')
      setSelfie(null)
      e.target.value = ''
      return
    }
    setSelfieError('')
    setSelfie(file)
  }

  return (
    <div className="card" style={{ maxWidth: '600px' }}>
      <h3 style={{ color: 'var(--accent)', marginBottom: '8px' }}>Upload Documents</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginBottom: '24px' }}>
        Upload your ID document and a selfie. ID files must be JPG, PNG or PDF under 5MB. Selfie must be JPG or PNG.
      </p>
      <form onSubmit={onSubmit}>
        <div className="grid-2 kyc-upload-grid">

          {/* ID Document */}
          <div>
            <label>ID Document</label>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Passport, National ID or Driver's License</p>
            <div
              style={{
                border: `2px dashed ${idError ? 'var(--red)' : 'var(--navy-border)'}`,
                borderRadius: '8px', padding: '20px', textAlign: 'center',
                cursor: 'pointer',
                background: idDocument ? 'rgba(74, 74, 74, 0.12)' : 'transparent',
                transition: 'all 0.2s'
              }}
              onClick={() => document.getElementById('id_doc_input').click()}
            >
              {idDocument ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                    {renderIcon('file', { size: 24, color: 'var(--accent-green)' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{idDocument.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(idDocument.size / 1024).toFixed(0)} KB</div>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                    {renderIcon('folder', { size: 24, color: 'var(--text-secondary)' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>JPG, PNG or PDF · max 5MB</div>
                </div>
              )}
            </div>
            {idError && (
              <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {renderIcon('warning', { size: 14, color: 'var(--accent-red)' })}
                <span>{idError}</span>
              </p>
            )}
            <input id="id_doc_input" type="file" accept=".jpg,.jpeg,.png,.pdf" style={{ display: 'none' }} onChange={handleIdChange} />
          </div>

          {/* Selfie */}
          <div>
            <label>Selfie with ID</label>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Hold your ID next to your face</p>
            <div
              style={{
                border: `2px dashed ${selfieError ? 'var(--red)' : 'var(--navy-border)'}`,
                borderRadius: '8px', padding: '20px', textAlign: 'center',
                cursor: 'pointer',
                background: selfie ? 'rgba(74, 74, 74, 0.12)' : 'transparent',
                transition: 'all 0.2s'
              }}
              onClick={() => document.getElementById('selfie_input').click()}
            >
              {selfie ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                    {renderIcon('selfie', { size: 24, color: 'var(--accent-green)' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{selfie.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(selfie.size / 1024).toFixed(0)} KB</div>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '8px' }}>
                    {renderIcon('folder', { size: 24, color: 'var(--text-secondary)' })}
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload (JPG or PNG only)</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>max 5MB</div>
                </div>
              )}
            </div>
            {selfieError && (
              <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                {renderIcon('warning', { size: 14, color: 'var(--accent-red)' })}
                <span>{selfieError}</span>
              </p>
            )}
            <input id="selfie_input" type="file" accept=".jpg,.jpeg,.png" style={{ display: 'none' }} onChange={handleSelfieChange} />
          </div>
        </div>

        <div style={{
          marginTop: '20px', padding: '16px',
          background: 'var(--navy-card)',
          border: '1px solid var(--navy-border)',
          borderRadius: '8px', marginBottom: '20px'
        }}>
          <p style={{ margin: '0', fontSize: '13px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {renderIcon('warning', { size: 14, color: 'var(--accent-gold)' })}
            <span>Your documents are securely stored and only used for identity verification. We accept government-issued IDs only.</span>
          </p>
        </div>

        <button
          className="btn btn-accent"
          type="submit"
          style={{ padding: '12px 32px' }}
          disabled={uploading || !idDocument || !selfie || !!idError || !!selfieError}
        >
          {uploading ? 'Uploading...' : 'Submit for Verification'}
        </button>
      </form>
    </div>
  )
}

export default Dashboard
