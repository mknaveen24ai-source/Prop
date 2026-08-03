import React, { Suspense, lazy, useState, useEffect, useMemo, useRef } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'
import toast from 'react-hot-toast'
import MarketStatusPill from '../components/MarketStatusPill'
import CommandPaletteTrigger from '../components/CommandPaletteTrigger'
import Sidebar, { NAV_GROUPS } from '../components/Sidebar'
import CommandPalette from '../components/CommandPalette'
import KYCUploadForm from '../components/dashboard/KYCUploadForm'
import Card from '../components/ui/Card'
import DashboardHome from './DashboardHome'
import ChallengeRules from './ChallengeRules'
import Onboarding, { shouldShowOnboarding } from './Onboarding'
import Support from './Support'
import Dispute from './Dispute'
import Chat from './Chat'
import { calculatePnL } from '../utils/instruments'
import { createIdempotencyHeaders, normalizeApiError, authAPI } from '../services/api'
import { useAuth } from '../providers/AuthProvider'
import useStore from '../store/useStore'
import { renderIcon } from '../utils/iconMap'
import { calculatePayoutPreview, calculateRealizedProfit, formatCurrency, toMoneyNumber } from '../utils/finance'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../utils/accountVisibility'
import { getStatusColor } from '../utils/constants'
import Pagination from '../components/Pagination'
import DashboardKYCPage from './DashboardKYCPage'
import DashboardPayoutsPage from './DashboardPayoutsPage'
import DashboardAffiliatePage from './DashboardAffiliatePage'
import DashboardCompetitionsPage from './DashboardCompetitionsPage'
import DashboardProfilePage from './DashboardProfilePage'
import GetChallenge from './GetChallenge'
import ErrorBoundary from '../ErrorBoundary'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'
const TradingPanel = lazy(() => import('../components/TradingPanel'))
const Analytics = lazy(() => import('./Analytics'))

// Header breadcrumb + page title per screen (Modern Gazette handoff spec
// TITLES map — breadcrumb is a separate, narrower label than the sidebar
// nav group name, e.g. 'dispute' breadcrumbs under "Support" even though
// its nav item lives in the Help group).
const PAGE_TITLES = {
  dashboard: ['Trader Desk', null], // title is the personalized greeting, built at render time
  trade: ['Trading Desk', 'Order Ticket & Chart'],
  analytics: ['Trader Desk', 'Performance Analytics'],
  competitions: ['Programme', 'Competitions & Leaderboard'],
  rules: ['Programme', 'Challenge Rules'],
  history: ['Programme', 'Trade History'],
  kyc: ['Account', 'Identity Verification'],
  payouts: ['Account', 'Payouts'],
  chat: ['Support', 'Live Chat with the Desk'],
  dispute: ['Support', 'File an Appeal'],
  'get-challenge': ['Programme', 'New Challenge'],
  affiliate: ['Account', 'Affiliate'],
  support: ['Support', 'Support'],
  profile: ['Account', 'Profile'],
}

function greeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
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
      className="lx-card ui-surface ui-empty-state"
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
  const { login } = useAuth()
  const [profileForm, setProfileForm] = useState({
    full_name: user?.full_name || '',
    country: user?.country || '',
    address_line1: user?.address_line1 || '',
    address_line2: user?.address_line2 || '',
    city: user?.city || '',
    state_province: user?.state_province || '',
    postal_code: user?.postal_code || ''
  })
  const [profileSaving, setProfileSaving] = useState(false)
  const [stats, setStats] = useState(null)
  const [accountRules, setAccountRules] = useState(null)
  const [tradeHistory, setTradeHistory] = useState([])
  const [payouts, setPayouts] = useState([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [activePage, setActivePage] = useState('dashboard')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('sidebarCollapsed') === 'true' } catch { return false }
  })
  const handleToggleSidebar = () => setSidebarCollapsed(prev => {
    const next = !prev
    try { localStorage.setItem('sidebarCollapsed', String(next)) } catch {}
    return next
  })
  const [orderForm, setOrderForm] = useState({
    instrument: 'EURUSD',
    lots: '0.01',
    stop_loss: '',
    take_profit: '',
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
  const dismissedAnnouncementKeyRef = useRef(null)
  const announcementKey = (a) => a ? `${a.message}|${a.updated_at}` : null

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
          // Reset dismissal when the announcement disappears OR changes to
          // different content — a dismissed banner shouldn't stay hidden
          // forever once an admin posts a new one.
          if (announcementKey(res.data) !== dismissedAnnouncementKeyRef.current) {
            setAnnouncementDismissed(false)
          }
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
            borderLeft: `3px solid ${profit ? 'var(--gain)' : 'var(--loss)'}`
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
        style: { borderLeft: '3px solid var(--accent)' }
      })
    })
    socket.on('account_passed', (data) => {
      toast.success(`Congratulations! You passed ${data?.phase || 'your challenge'}!`, {
        duration: 8000,
        icon: renderIcon('leaderboard', { size: 16, color: 'var(--accent-gold)' }),
        style: { borderLeft: '3px solid var(--warn)' }
      })
    })
    socket.on('payout_approved', (data) => {
      toast.success(`Payout of $${formatMoney(data?.amount)} approved!`, {
        duration: 8000,
        icon: renderIcon('payouts', { size: 16, color: 'var(--accent-gold)' }),
        style: { borderLeft: '3px solid var(--warn)' }
      })
    })
    socket.on('sl_triggered', (data) => {
      const slipMsg = Number(data?.slippage_pips || 0) > 0
        ? ` (${data.slippage_pips} pip slippage)`
        : ''
      toast(`SL triggered on ${data?.instrument || 'trade'}${slipMsg}`, {
        icon: renderIcon('warning', { size: 16, color: 'var(--accent-red)' }),
        style: { borderLeft: '3px solid var(--loss)' }
      })
    })
    socket.on('tp_triggered', (data) => {
      toast.success(`TP hit on ${data?.instrument || 'trade'}! +$${formatMoney(data?.pnl)}`, {
        icon: renderIcon('target', { size: 16, color: 'var(--accent-green)' }),
        style: { borderLeft: '3px solid var(--gain)' }
      })
    })
    socket.on('account_update', (data) => {
      const isPhasePassedEvent = /^phase\d+_passed$/.test(data?.event || '')
      if (data?.message) {
        setSuccess(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''))
        pushNotification(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''),
          data.event === 'account_failed' ? 'error' : isPhasePassedEvent ? 'success' : 'info')
      }
      if (isPhasePassedEvent) {
        const phaseLabel = `Phase ${data.event.match(/^phase(\d+)_passed$/)[1]}`
        toast.success(`Congratulations! You passed ${phaseLabel}!`, {
          duration: 8000,
          icon: renderIcon('leaderboard', { size: 16, color: 'var(--accent-gold)' }),
          style: { borderLeft: '3px solid var(--warn)' }
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

    // ── Platform-wide admin broadcasts (Notification Center → "web" channel) ──
    socket.on('platform_notification', (data) => {
      if (!data?.message) return
      pushNotification(data.title ? `${data.title}: ${data.message}` : data.message, data.type || 'info')
    })

    return () => socket.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchAccounts(); fetchPrices(); fetchPayouts(); fetchPayoutSettings(); fetchAccountHistory() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stripe checkout return handler ──────────────────────────────────────
  // After a challenge order is paid, Stripe redirects back to
  // /dashboard?checkout=success&order_id=N. Webhook delivery can lag a few
  // seconds behind the redirect, so poll the order until it's marked paid,
  // then create the challenge account.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const checkout = params.get('checkout')
    const orderId = params.get('order_id')
    if (!checkout) return

    window.history.replaceState({}, '', window.location.pathname)

    if (checkout === 'cancelled') {
      toast.error('Checkout was cancelled — no charge was made.')
      return
    }
    if (checkout !== 'success' || !orderId) return

    let cancelled = false
    async function confirmPayment() {
      setSuccess('Confirming your payment...')
      for (let attempt = 0; attempt < 10 && !cancelled; attempt++) {
        try {
          const res = await axios.get(`${API_URL}/api/accounts/orders/${orderId}`)
          const order = res.data?.order
          if (order?.status === 'paid') {
            await createAccount(parseFloat(order.account_size), { challengeOrderId: order.id })
            return
          }
        } catch (_) {
          // keep retrying — webhook may not have landed yet
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      if (!cancelled) {
        setError('Payment is taking longer than expected to confirm. If you were charged, your account will appear shortly — refresh in a minute or contact support.')
      }
    }
    confirmPayment()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
      if (ocoSibling) payload.oco_sibling = ocoSibling
      await axios.post(`${API_URL}/api/trades/open`, payload, {
        headers: createIdempotencyHeaders('trades:open')
      })
      setSuccess(`${orderType === 'market' ? direction.toUpperCase() : orderType.replace(/_/g, ' ').toUpperCase()} order placed on ${orderForm.instrument}`)
      setOrderForm(f => ({
        ...f,
        stop_loss: '',
        take_profit: '',
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

  async function updateProfile(e) {
    e.preventDefault()
    if (profileSaving) return
    setProfileSaving(true)
    try {
      const res = await authAPI.updateProfile(profileForm)
      login(res.data)
      setSuccess('Profile updated!')
    } catch (err) {
      setError(normalizeApiError(err, 'Could not update profile').message)
    } finally {
      setProfileSaving(false)
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
          info:    { bg: 'transparent', border: 'var(--rule)', text: 'var(--ink)', icon: 'info' },
          warning: { bg: 'transparent', border: 'var(--warn)', text: 'var(--warn)', icon: 'warning' },
          success: { bg: 'transparent', border: 'var(--gain)', text: 'var(--gain)', icon: 'approve' },
          error:   { bg: 'transparent', border: 'var(--loss)', text: 'var(--loss)', icon: 'reject' },
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
              onClick={() => {
                dismissedAnnouncementKeyRef.current = announcementKey(announcement)
                setAnnouncementDismissed(true)
              }}
              aria-label="Dismiss announcement"
              style={{ background: 'none', border: 'none', color: c.text, cursor: 'pointer', fontSize: '16px', opacity: 0.7, padding: '0 4px' }}
            >
              {renderIcon('close', { size: 16, color: c.text })}
            </button>
          </div>
        )
      })()}

      <Sidebar
        user={user}
        activePage={activePage}
        setActivePage={setActivePage}
        kycStatus={kycStatus}
        pendingPayouts={payouts.filter(p => p.status === 'pending').length}
        unreadNotifications={notifications.filter(n => !n.read).length}
        onLogout={onLogout}
        collapsed={sidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
      />

      <CommandPalette
        results={NAV_GROUPS.flatMap((group) => group.items.map((item) => ({
          label: item.label,
          group: group.label,
          action: () => setActivePage(item.id),
        })))}
      />

      {/* Main Content — .sidebar is position:fixed (stays pinned, only its
          own nav list scrolls internally), so main content needs an
          explicit offset instead of relying on flex to push it over.
          Class-based (not inline) so the mobile media query can still
          override it — see .dashboard-main rules in App.css. */}
      <div
        className={`dashboard-main animate-fade-up ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {/* Top Nav — flush, full-width header matching the prototype exactly
            (breadcrumb + Playfair title, search, MARKETS OPEN — no floating
            card/margin, that's what was creating the visible gap around it). */}
      <div className="nav dashboard-topbar" style={{
        margin: 0,
        padding: '14px 24px',
        display: 'flex', alignItems: 'center', gap: '16px',
        background: 'var(--glass)',
        backdropFilter: 'blur(18px)',
        WebkitBackdropFilter: 'blur(18px)',
        borderBottom: '1px solid var(--rule)',
        borderRadius: 0,
        boxShadow: 'none',
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: '9.5px', letterSpacing: '.18em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {(PAGE_TITLES[activePage] || ['Trader Desk'])[0]}
          </div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '23px', fontWeight: 500, margin: '2px 0 0', letterSpacing: '-.01em' }}>
            {activePage === 'dashboard'
              ? `${greeting()}, ${(user?.full_name || 'Trader').split(' ')[0]}`
              : (PAGE_TITLES[activePage]?.[1] || 'Dashboard')}
          </h1>
        </div>
        <div style={{ flex: 1 }} />
        <CommandPaletteTrigger />
        <MarketStatusPill />

        {/* ── Notification Bell ── */}
        <div style={{ position: 'relative' }}>
          <button
            onClick={() => {
              setShowNotifications(p => {
                if (!p) markAllRead()
                return !p
              })
            }}
            style={{ display: 'flex', alignItems: 'center', padding: '8px', border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', background: 'var(--paper-2)', color: 'var(--muted)' }}
          >
            {renderIcon('bell', { size: 15, color: 'var(--muted)' })}
            {notifications.filter(n => !n.read).length > 0 && (
              <span className="lx-badge" style={{
                position: 'absolute', top: '-6px', right: '-6px', color: 'var(--loss)',
                padding: '1px 5px', fontSize: '9px',
              }}>
                {notifications.filter(n => !n.read).length}
              </span>
            )}
          </button>
          {showNotifications && (
            <div style={{
              position: 'absolute', right: 0, top: '42px', width: '320px', maxHeight: '400px',
              background: 'var(--glass-2)', backdropFilter: 'blur(24px) saturate(160%)', WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              border: '1px solid var(--rule)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--elev-lg)', zIndex: 999,
              overflow: 'hidden', display: 'flex', flexDirection: 'column'
            }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontFamily: 'var(--font-display)', fontSize: '14px', color: 'var(--accent)' }}>Notifications</span>
                {notifications.length > 0 && (
                  <button onClick={clearNotifications} style={{ border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: '11px', cursor: 'pointer' }}>Clear all</button>
                )}
              </div>
              <div style={{ overflowY: 'auto', maxHeight: '340px' }}>
                {notifications.length === 0 ? (
                  <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--muted)', fontSize: '13px' }}>No notifications yet</div>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} style={{
                      padding: '12px 16px', borderBottom: '1px solid var(--rule-soft)',
                      borderLeft: `3px solid ${n.type === 'error' ? 'var(--loss)' : n.type === 'success' ? 'var(--gain)' : 'var(--accent)'}`,
                    }}>
                      <div style={{ fontSize: '13px', color: 'var(--ink)', marginBottom: '4px' }}>{n.message}</div>
                      <div style={{ fontSize: '11px', color: 'var(--muted)' }}>
                        {new Date(n.time).toLocaleString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="dashboard-page-content dashboard-page-stack">
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
            getStatusColor={getStatusColor}
            profitSharePct={profitSharePct}
            quotaFull={quotaFull}
            quotaNextOpen={quotaNextOpen}
            onOpenRulesPage={() => setActivePage('rules')}
            onStartChallenge={() => setActivePage('get-challenge')}
            onOpenPayoutsPage={() => setActivePage('payouts')}
          />
        )}

        {/* Profile Page */}
        {activePage === 'profile' && (
          <DashboardProfilePage
            kycStatus={kycStatus}
            profileForm={profileForm}
            setProfileForm={setProfileForm}
            updateProfile={updateProfile}
            profileSaving={profileSaving}
          />
        )}

        {activePage === 'get-challenge' && (
          <GetChallenge
            onCreateAccount={createAccount}
            kycStatus={kycStatus}
            setActivePage={setActivePage}
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
            <Card style={{ textAlign: 'center', padding: '48px' }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                {renderIcon('kyc', { size: 48, color: 'var(--accent)' })}
              </div>
              <h3 className="page-title" style={{ marginBottom: '12px', fontSize: '20px' }}>KYC Required</h3>
              <p style={{ color: 'var(--text-secondary)', marginBottom: '20px' }}>Complete your identity verification to start trading.</p>
              <button className="btn btn-primary" onClick={() => setActivePage('kyc')} style={{ padding: '12px 32px' }}>Complete KYC</button>
            </Card>
          ) : (
            // FIX (AUDIT): TradingPanel is a ~1700-line component with its own
            // chart/order-form/batch-action state — a rendering crash in it
            // used to take down the entire app via the single app-wide
            // boundary. Scoped here so a crash falls back in place instead.
            <ErrorBoundary variant="section" label="Trading Panel" key={selectedAccount?.id}>
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
            </ErrorBoundary>
          )
        )}

        {/* Analytics Page */}
        {activePage === 'analytics' && (
          <ErrorBoundary variant="section" label="Analytics">
            <Suspense fallback={<DashboardSectionFallback label="Loading analytics..." />}>
              <Analytics
                selectedAccount={selectedAccount}

              />
            </Suspense>
          </ErrorBoundary>
        )}

        {/* KYC Page */}
        {activePage === 'kyc' && (
          <DashboardKYCPage
            user={user}
            kycStatus={kycStatus}
            uploadKYC={uploadKYC}
            kycCountry={kycCountry}
            setKycCountry={setKycCountry}
            kycDocumentType={kycDocumentType}
            setKycDocumentType={setKycDocumentType}
            kycDocumentNumber={kycDocumentNumber}
            setKycDocumentNumber={setKycDocumentNumber}
            idDocument={idDocument}
            setIdDocument={setIdDocument}
            idDocumentBack={idDocumentBack}
            setIdDocumentBack={setIdDocumentBack}
            selfie={selfie}
            setSelfie={setSelfie}
            kycUploading={kycUploading}
          />
        )}

        {/* Payouts Page */}
        {activePage === 'payouts' && (
          <DashboardPayoutsPage
            user={user}
            fundedAccount={fundedAccount}
            payouts={payouts}
            payoutForm={payoutForm}
            setPayoutForm={setPayoutForm}
            requestPayout={requestPayout}
            availableProfit={availableProfit}
            profitSharePct={profitSharePct}
            API_URL={API_URL}
          />
        )}

        {/* Affiliate Page */}
        {activePage === 'affiliate' && (
          <ErrorBoundary variant="section" label="Affiliate">
            <DashboardAffiliatePage />
          </ErrorBoundary>
        )}

        {/* Competitions Page */}
        {activePage === 'competitions' && (
          <ErrorBoundary variant="section" label="Competitions">
            <DashboardCompetitionsPage />
          </ErrorBoundary>
        )}

      </div>
        {/* Account History Page */}
        {activePage === 'history' && (
          <div>
            <h2 style={{ fontFamily: 'var(--font-ui)', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Account History</h2>
            {accountHistory.length === 0 ? (
              <Card style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
                  {renderIcon('file', { size: 48, color: 'var(--accent)' })}
                </div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No History Yet</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your challenge history will appear here once you complete or start a challenge.</p>
              </Card>
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
                      const statusColor = getStatusColor(acc.status)
                      return (
                        <Card key={acc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', borderLeft: `3px solid ${statusColor}` }}>
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
                            <span style={{ padding: '3px 10px', borderRadius: 'var(--radius-pill)', fontSize: '11px', fontWeight: '700', color: statusColor, border: `1px solid ${statusColor}`, background: `color-mix(in srgb, ${statusColor} 10%, transparent)` }}>
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
                        </Card>
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

export default Dashboard
