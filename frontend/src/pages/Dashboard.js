import React, { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'
import ThemeToggle from '../components/ThemeToggle'
import Sidebar from '../components/Sidebar'
import TradingPanel from '../components/TradingPanel'
import DashboardHome from './DashboardHome'
import Analytics from './Analytics'
import Onboarding, { shouldShowOnboarding } from './Onboarding'
import Support from './Support'
import Dispute from './Dispute'
import Chat from './Chat'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

const CONTRACT_SIZES = {
  EURUSD: 100000, GBPUSD: 100000, USDJPY: 100000,
  USDCHF: 100000, AUDUSD: 100000, USDCAD: 100000,
  XAUUSD: 100, XAGUSD: 5000, US30: 1, NAS100: 1
}

function calculatePnL(direction, openPrice, currentPrice, lots, instrument, commission = 0) {
  const contractSize = CONTRACT_SIZES[instrument] || 100000;
  const priceDiff = direction === 'buy' ? currentPrice - openPrice : openPrice - currentPrice;
  return parseFloat(((priceDiff * lots * contractSize) - commission).toFixed(2));
}

function getStatusColor(status) {
  const c = {
    active: 'var(--accent)', passed: 'var(--green)', failed: 'var(--red)',
    funded: 'var(--cyan)', pending: 'var(--accent)', approved: 'var(--green)',
    paid: 'var(--green)', rejected: 'var(--red)', locked: '#8a8a8a'
  }
  return c[status] || 'var(--text-muted)'
}

function Dashboard({ user, onLogout }) {
  const [accounts, setAccounts] = useState([])
  const [selectedAccount, setSelectedAccount] = useState(null)
  const [stats, setStats] = useState(null)
  const [openTrades, setOpenTrades] = useState([])
  const [tradeHistory, setTradeHistory] = useState([])
  const [prices, setPrices] = useState({})
  const [payouts, setPayouts] = useState([])
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [activePage, setActivePage] = useState('dashboard')
  const [orderForm, setOrderForm] = useState({ instrument: 'EURUSD', lots: '0.01', stop_loss: '', take_profit: '' })
  const [payoutForm, setPayoutForm] = useState({ amount_requested: '', payment_method: 'crypto', payment_details: '' })
  const [kycStatus, setKycStatus] = useState(user?.kyc_status || 'not_submitted')
  const [idDocument, setIdDocument] = useState(null)
  const [selfie, setSelfie] = useState(null)
  const [kycUploading, setKycUploading] = useState(false)
  const [accountLoading, setAccountLoading] = useState(false)
  const [profitSharePct, setProfitSharePct] = useState(80)

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

  useEffect(() => {
    // Fetch on mount
    axios.get(`${API_URL}/api/admin/announcement`)
      .then(res => { if (res.data) setAnnouncement(res.data) })
      .catch(() => {})
    // Re-poll every 5 minutes
    const iv = setInterval(() => {
      axios.get(`${API_URL}/api/admin/announcement`)
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
  // FIX (BUG-L4): pricesRef always holds the latest prices, avoiding stale closure
  // in fetchOpenTrades which would capture an empty {} at function definition time.
  const pricesRef = useRef({})

  useEffect(() => { selectedAccountRef.current = selectedAccount }, [selectedAccount])

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
    socket.on('price_update', (newPrices) => {
      setPrices(newPrices)
      pricesRef.current = newPrices  // FIX (BUG-L4): keep ref in sync with state
      setOpenTrades(prev => prev.map(trade => {
        if (trade.status === 'pending') return trade
        const pd = newPrices[trade.instrument]
        if (!pd) return trade
        const currentPrice = trade.direction === 'buy' ? parseFloat(pd.bid) : parseFloat(pd.ask)
        const floating_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )
        return { ...trade, floating_pnl, current_price: currentPrice }
      }))
    })
    socket.on('account_update', (data) => {
      if (data?.message) {
        setSuccess(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''))
        pushNotification(data.message + (data.pnl != null ? ` P&L: $${data.pnl}` : ''),
          data.event === 'account_failed' ? 'error' : (data.event === 'phase1_passed' || data.event === 'phase2_passed') ? 'success' : 'info')
      }
      if (selectedAccountRef.current) {
        fetchStats(selectedAccountRef.current.id)
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
      const type = data.warning_level >= 90 ? 'error'
        : data.warning_level >= 75 ? 'warning'
        : 'info'
      pushNotification(data.message, type)
      // Also surface as a toast so the trader sees it immediately while trading
      setError(data.message)
    })
    return () => socket.disconnect()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchAccounts(); fetchPrices(); fetchPayouts(); fetchPayoutSettings(); fetchAccountHistory() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (selectedAccount) {
      setAccountLoading(true)
      setOpenTrades([])
      setStats(null)
      setTradeHistory([])
      Promise.all([
        fetchStats(selectedAccount.id),
        fetchOpenTrades(selectedAccount.id),
        fetchTradeHistory(selectedAccount.id)
      ]).finally(() => setAccountLoading(false))
    }
  }, [selectedAccount?.id]) // eslint-disable-line react-hooks/exhaustive-deps

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
      setAccounts(res.data)
      if (res.data.length > 0 && !selectedAccountRef.current) setSelectedAccount(res.data[0])
      return res.data
    } catch { setError('Could not fetch accounts') }
  }

  async function fetchPrices() {
    try { const res = await axios.get(`${API_URL}/api/prices`); setPrices(res.data) } catch {}
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

  async function fetchOpenTrades(id) {
    try {
      const res = await axios.get(`${API_URL}/api/trades/open`, { params: { account_id: id } })
      // FIX (BUG-L4): Read from pricesRef (always current) not the prices closure
      // which was stale at function-definition time.
      const currentPrices = pricesRef.current
      const enriched = res.data.map(trade => {
        if (trade.status === 'pending') return trade
        const pd = currentPrices[trade.instrument]
        if (!pd || trade.open_price == null) return trade
        const currentPrice = trade.direction === 'buy' ? parseFloat(pd.bid) : parseFloat(pd.ask)
        const floating_pnl = calculatePnL(
          trade.direction,
          parseFloat(trade.open_price),
          currentPrice,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )
        return { ...trade, floating_pnl, current_price: currentPrice }
      })
      setOpenTrades(enriched)
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
    const notif = { id: Date.now(), message, type, time: new Date().toISOString(), read: false }
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

  async function createAccount(size) {
    try {
      // Clear any previous quota state before trying
      setQuotaFull(false)
      setQuotaNextOpen(null)
      await axios.post(`${API_URL}/api/accounts/create`, { account_size: size })
      setSuccess('Challenge account created!')
      fetchAccounts()
    } catch (err) {
      const data = err.response?.data
      if (data?.quota_full) {
        // Backend told us quota is full — show the dedicated banner instead of the error toast
        setQuotaFull(true)
        setQuotaNextOpen(data.next_open || null)
      } else {
        setError(data?.error || 'Could not create account')
      }
    }
  }

  async function openTrade({ direction, orderType, pendingPrice }) {
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
      await axios.post(`${API_URL}/api/trades/open`, payload)
      setSuccess(`${orderType === 'market' ? direction.toUpperCase() : orderType.replace(/_/g, ' ').toUpperCase()} order placed on ${orderForm.instrument}`)
      setOrderForm(f => ({ ...f, stop_loss: '', take_profit: '' }))
      fetchOpenTrades(selectedAccount.id)
      fetchStats(selectedAccount.id)
    } catch (err) { setError(err.response?.data?.error || 'Could not open trade') }
  }

  async function closeTrade(tradeId) {
    try {
      const res = await axios.post(`${API_URL}/api/trades/close`, { trade_id: tradeId })
      setSuccess(`Trade closed. P&L: $${res.data.pnl}`)
      fetchOpenTrades(selectedAccount.id)
      fetchStats(selectedAccount.id)
      fetchTradeHistory(selectedAccount.id)
    } catch (err) { setError(err.response?.data?.error || 'Could not close trade') }
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
    }
  }

  async function uploadKYC(e) {
    e.preventDefault()
    if (!idDocument || !selfie) return setError('Please select both ID document and selfie')
    try {
      setKycUploading(true)
      const formData = new FormData()
      formData.append('id_document', idDocument)
      formData.append('selfie', selfie)
      await axios.post(`${API_URL}/api/kyc/upload`, formData)
      setKycStatus('pending')
      setSuccess('KYC documents uploaded! Admin will review within 24 hours.')
      setIdDocument(null)
      setSelfie(null)
    } catch (err) {
      setError(err.response?.data?.error || 'Upload failed')
    } finally {
      setKycUploading(false)
    }
  }

  async function requestPayout(e) {
    e.preventDefault()
    try {
      await axios.post(`${API_URL}/api/payouts/request`, {
        account_id: selectedAccount.id,
        amount_requested: parseFloat(payoutForm.amount_requested),
        payment_method: payoutForm.payment_method,
        payment_details: payoutForm.payment_details
      })
      setSuccess('Payout request submitted!')
      setPayoutForm({ amount_requested: '', payment_method: 'crypto', payment_details: '' })
      fetchPayouts()
    } catch (err) { setError(err.response?.data?.error || 'Could not submit payout') }
  }

  const fundedAccount = accounts.find(a => a.account_type === 'funded' && a.status === 'active')
  const availableProfit = fundedAccount
    ? Math.max(0, parseFloat(fundedAccount.current_balance) - parseFloat(fundedAccount.starting_balance))
    : 0

  return (
    <div style={{ minHeight: '100vh', background: 'var(--navy)' }}>

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
          info:    { bg: 'rgba(100, 180, 255, 0.10)', border: 'rgba(100, 180, 255, 0.4)', text: '#60b4ff', icon: 'ℹ️' },
          warning: { bg: 'rgba(255, 180, 50, 0.10)',  border: 'rgba(255, 180, 50, 0.4)',  text: '#ffb432', icon: '⚠️' },
          success: { bg: 'rgba(80, 200, 120, 0.10)',  border: 'rgba(80, 200, 120, 0.4)',  text: '#50c878', icon: '✅' },
          error:   { bg: 'rgba(240, 80, 80, 0.10)',   border: 'rgba(240, 80, 80, 0.4)',   text: '#f05050', icon: '🚨' },
        }
        const c = colors[announcement.type] || colors.info
        return (
          <div style={{
            background: c.bg, borderBottom: `1px solid ${c.border}`,
            padding: '10px 24px',
            display: 'flex', alignItems: 'center', gap: '10px',
            position: 'sticky', top: '57px', zIndex: 90
          }}>
            <span>{c.icon}</span>
            <span style={{ flex: 1, fontSize: '13px', color: c.text, fontWeight: '500' }}>
              {announcement.message}
            </span>
            <button
              onClick={() => setAnnouncementDismissed(true)}
              style={{ background: 'none', border: 'none', color: c.text, cursor: 'pointer', fontSize: '16px', opacity: 0.7, padding: '0 4px' }}
            >
              ×
            </button>
          </div>
        )
      })()}

      {/* Top Nav */}
      <div className="nav dashboard-nav">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <span className="nav-logo">PROP FIRM</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: connected ? 'var(--green)' : 'var(--red)' }}>
            <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: connected ? 'var(--green-light)' : 'var(--red)', boxShadow: connected ? '0 0 6px var(--green-light)' : 'none', display: 'inline-block' }} />
            {connected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <span className="nav-username" style={{ color: 'var(--text-muted)', fontSize: '13px' }}>{user?.full_name || 'Trader'}</span>
          {kycStatus !== 'approved' && (
            <span onClick={() => setActivePage('kyc')} style={{
              background: kycStatus === 'pending' ? 'rgba(148, 148, 148, 0.12)' : 'rgba(97, 97, 97, 0.15)',
              border: '1px solid ' + (kycStatus === 'pending' ? 'var(--accent)' : 'var(--red)'),
              padding: '4px 10px', borderRadius: '4px', fontSize: '12px',
              cursor: 'pointer', color: kycStatus === 'pending' ? 'var(--accent)' : '#fff'
            }}>
              {kycStatus === 'pending' ? '⏳ KYC Pending' : '⚠️ Complete KYC'}
            </span>
          )}
          {kycStatus === 'approved' && (
            <span style={{ background: 'rgba(74, 74, 74, 0.15)', border: '1px solid var(--green)', padding: '4px 10px', borderRadius: '4px', fontSize: '12px', color: 'var(--green-light)' }}>
              ✅ KYC Verified
            </span>
          )}

          {/* ── Notification Bell ── */}
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => { setShowNotifications(p => !p); markAllRead() }}
              style={{ background: 'none', border: '1px solid var(--navy-border)', borderRadius: '6px', padding: '6px 10px', cursor: 'pointer', fontSize: '16px', color: 'var(--text-muted)', position: 'relative' }}
            >
              🔔
              {notifications.filter(n => !n.read).length > 0 && (
                <span style={{
                  position: 'absolute', top: '-4px', right: '-4px',
                  background: 'var(--red)', color: '#fff',
                  borderRadius: '99px', fontSize: '9px', fontWeight: '700',
                  padding: '0 4px', lineHeight: '14px', minWidth: '14px', textAlign: 'center'
                }}>
                  {notifications.filter(n => !n.read).length}
                </span>
              )}
            </button>
            {showNotifications && (
              <div style={{
                position: 'absolute', right: 0, top: '42px', width: '320px', maxHeight: '400px',
                background: 'var(--navy-card)', border: '1px solid var(--navy-border)',
                borderRadius: '10px', boxShadow: '0 8px 32px rgba(0,0,0,0.4)', zIndex: 999,
                overflow: 'hidden', display: 'flex', flexDirection: 'column'
              }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--navy-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: '600', fontSize: '13px', color: 'var(--accent)' }}>Notifications</span>
                  {notifications.length > 0 && (
                    <button onClick={clearNotifications} style={{ background: 'none', border: 'none', color: 'var(--text-dim)', fontSize: '11px', cursor: 'pointer' }}>Clear all</button>
                  )}
                </div>
                <div style={{ overflowY: 'auto', maxHeight: '340px' }}>
                  {notifications.length === 0 ? (
                    <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>No notifications yet</div>
                  ) : (
                    notifications.map(n => (
                      <div key={n.id} style={{
                        padding: '12px 16px', borderBottom: '1px solid var(--navy-border)',
                        borderLeft: `3px solid ${n.type === 'error' ? 'var(--red)' : n.type === 'success' ? 'var(--green)' : 'var(--accent)'}`,
                        background: 'transparent'
                      }}>
                        <div style={{ fontSize: '13px', color: 'var(--text)', marginBottom: '4px' }}>{n.message}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
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
          <button className="btn btn-red" onClick={onLogout} style={{ padding: '7px 14px', fontSize: '12px' }}>Logout</button>
        </div>
      </div>

      {/* Sidebar */}
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        kycStatus={kycStatus}
        pendingPayouts={payouts.filter(p => p.status === 'pending').length}
        unreadNotifications={notifications.filter(n => !n.read).length}
      />

      {/* Main Content */}
      <div className="dashboard-content">

        {error && <div className="error">{error}</div>}
        {success && <div className="success">{success}</div>}

        {/* Dashboard Page */}
        {activePage === 'dashboard' && (
          <DashboardHome
            user={user}
            stats={stats}
            accounts={accounts}
            selectedAccount={selectedAccount}
            setSelectedAccount={setSelectedAccount}
            onCreateAccount={createAccount}
            getStatusColor={getStatusColor}
            profitSharePct={profitSharePct}
            quotaFull={quotaFull}
            quotaNextOpen={quotaNextOpen}
          />
        )}

        {/* Trade Page */}
        {activePage === 'trade' && (
          kycStatus !== 'approved' ? (
            <div className="card" style={{ textAlign: 'center', padding: '48px' }}>
              <div style={{ fontSize: '48px', marginBottom: '16px' }}>🪪</div>
              <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>KYC Required</h3>
              <p style={{ color: 'var(--text-muted)', marginBottom: '20px' }}>Complete your identity verification to start trading.</p>
              <button className="btn btn-accent" onClick={() => setActivePage('kyc')} style={{ padding: '12px 32px' }}>Complete KYC</button>
            </div>
          ) : (
            <TradingPanel
              prices={prices}
              selectedAccount={selectedAccount}
              accounts={accounts}
              setSelectedAccount={setSelectedAccount}
              openTrades={openTrades}
              tradeHistory={tradeHistory}
              orderForm={orderForm}
              setOrderForm={setOrderForm}
              onOpenTrade={openTrade}
              onCloseTrade={closeTrade}
              onCancelOrder={cancelOrder}
              getStatusColor={getStatusColor}
              stats={stats}
              
              onTradeModified={handleTradeModified}
              accountLoading={accountLoading}
            />
          )
        )}

        {/* Analytics Page */}
        {activePage === 'analytics' && (
          <Analytics
            selectedAccount={selectedAccount}
            
          />
        )}

        {/* KYC Page */}
        {activePage === 'kyc' && (
          <div>
            <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Identity Verification</h2>
            {kycStatus === 'approved' ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
                <h3 style={{ color: 'var(--green)', marginBottom: '12px' }}>KYC Verified</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your identity has been verified. You can start trading.</p>
              </div>
            ) : kycStatus === 'pending' ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>⏳</div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>KYC Under Review</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your documents have been submitted. Admin will review within 24 hours.</p>
              </div>
            ) : (
              <div>
                {kycStatus === 'rejected' && (
                  <div className="card" style={{ textAlign: 'center', padding: '24px', marginBottom: '20px', border: '1px solid var(--red)', maxWidth: '600px' }}>
                    <div style={{ fontSize: '32px', marginBottom: '8px' }}>❌</div>
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
                  idDocument={idDocument}
                  setIdDocument={setIdDocument}
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
            <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Payouts</h2>
            {!fundedAccount ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>🏆</div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No Funded Account Yet</h3>
                <p style={{ color: 'var(--text-muted)' }}>Complete Phase 1 and Phase 2 to unlock payouts.</p>
              </div>
            ) : (
              <div>
                <div className="grid-2" style={{ marginBottom: '20px', maxWidth: '600px' }}>
                  <div className="stat-card">
                    <div className="stat-value" style={{ color: 'var(--green)' }}>${availableProfit.toFixed(2)}</div>
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
                          placeholder={`Max $${availableProfit.toFixed(2)}`} min="50" max={availableProfit} step="0.01" required />
                        {payoutForm.amount_requested && (
                          <p style={{ fontSize: '13px', color: 'var(--green-light)', marginTop: '6px' }}>
                            You will receive: ${(parseFloat(payoutForm.amount_requested || 0) * (profitSharePct / 100)).toFixed(2)} ({profitSharePct}% share)
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
                          ⬇ Download Statement
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
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px' }}>{user?.trader_uid || user?.trader_id || '—'}</td>
                            <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '11px' }}>{p.account_uid || p.account_id || '—'}</td>
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
        {/* Account History Page */}
        {activePage === 'history' && (
          <div>
            <h2 style={{ fontFamily: 'Inter, serif', color: 'var(--accent)', marginBottom: '24px', fontSize: '22px' }}>Account History</h2>
            {accountHistory.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '48px', maxWidth: '500px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
                <h3 style={{ color: 'var(--accent)', marginBottom: '12px' }}>No History Yet</h3>
                <p style={{ color: 'var(--text-muted)' }}>Your challenge history will appear here once you complete or start a challenge.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {accountHistory.map(acc => {
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
                            {acc.account_type.toUpperCase()} — ${parseFloat(acc.account_size).toLocaleString()}
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
            )}
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

function KYCUploadForm({ onSubmit, idDocument, setIdDocument, selfie, setSelfie, uploading }) {
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
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>📄</div>
                  <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{idDocument.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(idDocument.size / 1024).toFixed(0)} KB</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>📁</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>JPG, PNG or PDF · max 5MB</div>
                </div>
              )}
            </div>
            {idError && (
              <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px' }}>⚠ {idError}</p>
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
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>🤳</div>
                  <div style={{ fontSize: '13px', color: 'var(--green-light)' }}>{selfie.name}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>{(selfie.size / 1024).toFixed(0)} KB</div>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: '24px', marginBottom: '8px' }}>📁</div>
                  <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Click to upload (JPG or PNG only)</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '4px' }}>max 5MB</div>
                </div>
              )}
            </div>
            {selfieError && (
              <p style={{ color: 'var(--red)', fontSize: '12px', marginTop: '6px' }}>⚠ {selfieError}</p>
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
          <p style={{ margin: '0', fontSize: '13px', color: 'var(--text-muted)' }}>
            ⚠️ Your documents are securely stored and only used for identity verification. We accept government-issued IDs only.
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
