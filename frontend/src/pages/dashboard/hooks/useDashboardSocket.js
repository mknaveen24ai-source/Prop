import { useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import toast from 'react-hot-toast'
import useStore from '../../../store/useStore'
import { renderIcon } from '../../../utils/iconMap'
import { formatCurrency } from '../../../utils/finance'
import { SOCKET_URL } from '../../../config/apiBase'
import { enrichTradesWithPrices } from '../enrichTradesWithPrices'

// The dashboard's live feed: 15 socket listeners covering prices, positions,
// trade lifecycle, KYC decisions, payouts, drawdown warnings and admin
// broadcasts.
//
// The effect subscribes once on mount and must not resubscribe on every price
// tick or account switch, so everything it needs is read through refs rather
// than closed over: handlersRef for the callbacks, and the store's getState()
// for current positions.
export default function useDashboardSocket({
  user,
  pricesRef,
  selectedAccountRef,
  setError,
  setSuccess,
  setKycStatus,
  setSelectedAccount,
  pushNotification,
  refreshSelectedAccount,
  fetchAccounts,
  fetchAccountHistory
}) {
  const [connected, setConnected] = useState(false)
  const socketRef = useRef(null)

  // Buffers equity_update payloads between animation frames — see the
  // equity_update handler below.
  const pendingEquityRef = useRef(new Map())
  const equityFrameRef = useRef(null)

  const {
    updatePrice,
    updatePrices,
    setOpenPositions,
    updatePositionPnL,
    addPosition,
    removePosition,
    updateLiveEquity,
  } = useStore()

  // Latest callbacks, so the subscribe effect can stay mount-only without
  // going stale. Synced in an effect rather than during render (a render-phase
  // ref write is unsafe under concurrent rendering), and declared above the
  // subscribe effect so it is populated first — effects run in declaration
  // order, and no socket event can arrive before both have run.
  const handlersRef = useRef({})
  useEffect(() => {
    handlersRef.current = {
      setError,
      setSuccess,
      setKycStatus,
      setSelectedAccount,
      pushNotification,
      refreshSelectedAccount,
      fetchAccounts,
      fetchAccountHistory
    }
  })

  useEffect(() => {
    // FIX: include 'polling' as fallback — works behind proxies/firewalls that
    // block WebSocket upgrades. Socket.IO prefers WebSocket, falls back automatically.
    const socket = io(SOCKET_URL, { transports: ['websocket', 'polling'], withCredentials: true })
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
        `${instrument} closed ${formatCurrency(pnl, { signed: true })}`,
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
      toast.success(`Payout of ${formatCurrency(data?.amount)} approved!`, {
        duration: 8000,
        icon: renderIcon('payouts', { size: 16, color: 'var(--accent-gold)' }),
        style: { borderLeft: '3px solid var(--warn)' }
      })
    })
    socket.on('kyc_status_changed', (data) => {
      if (!data?.status) return
      handlersRef.current.setKycStatus(data.status)
      if (data.status === 'approved') {
        toast.success('Your identity verification was approved!', {
          duration: 8000,
          icon: renderIcon('kyc', { size: 16, color: 'var(--accent-gold)' }),
          style: { borderLeft: '3px solid var(--gain)' }
        })
      } else if (data.status === 'rejected') {
        toast.error(data.reason ? `Identity verification rejected: ${data.reason}` : 'Identity verification was rejected.', {
          duration: 8000,
          style: { borderLeft: '3px solid var(--loss)' }
        })
      }
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
      toast.success(`TP hit on ${data?.instrument || 'trade'}! ${formatCurrency(data?.pnl, { signed: true })}`, {
        icon: renderIcon('target', { size: 16, color: 'var(--accent-green)' }),
        style: { borderLeft: '3px solid var(--gain)' }
      })
    })
    // ── Live equity (ENGINE_MODE=event) ──────────────────────────────────────
    // The backend pushes a snapshot on every engine tick for accounts whose
    // numbers moved, so balance, drawdown and profit-target progress update
    // without a refetch. Writes are coalesced through one animation frame:
    // the feed can tick several times a second and each store write would
    // otherwise re-render every KPI card and gauge subscribed to it.
    socket.on('equity_update', (data) => {
      if (!data?.account_id) return
      pendingEquityRef.current.set(data.account_id, data)
      if (equityFrameRef.current) return
      equityFrameRef.current = requestAnimationFrame(() => {
        equityFrameRef.current = null
        for (const [accountId, snapshot] of pendingEquityRef.current) {
          updateLiveEquity(accountId, snapshot)
        }
        pendingEquityRef.current.clear()
      })
    })

    socket.on('account_update', (data) => {
      const isPhasePassedEvent = /^phase\d+_passed$/.test(data?.event || '')
      if (data?.message) {
        const pnlSuffix = data.pnl != null ? ` P&L: ${formatCurrency(data.pnl, { signed: true })}` : ''
        handlersRef.current.setSuccess(data.message + pnlSuffix)
        handlersRef.current.pushNotification(data.message + pnlSuffix,
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
        handlersRef.current.refreshSelectedAccount()
      }
      // FIX: Auto-select the newly promoted account when a phase is passed.
      // The backend emits new_account_id on phase1_passed and phase2_passed events.
      // Without this, the trader sees the old (passed) account selected and has to
      // manually click the new Phase 2 / Funded account to start trading it.
      handlersRef.current.fetchAccounts().then((latestAccounts) => {
        if (data?.new_account_id && latestAccounts) {
          const newAcc = latestAccounts.find(a => a.id === data.new_account_id)
          if (newAcc) handlersRef.current.setSelectedAccount(newAcc)
        }
      })
      handlersRef.current.fetchAccountHistory()
    })

    // ── Drawdown warning alerts (50% / 75% / 90% of limit) ───────────────────
    socket.on('drawdown_warning', (data) => {
      if (!data?.message) return
      const percentage = data?.percentage ?? data?.warning_level ?? 0
      const type = percentage >= 90 ? 'error'
        : percentage >= 75 ? 'warning'
        : 'info'
      handlersRef.current.pushNotification(data.message, type)
      toast.error(
        `Warning: ${percentage}% drawdown used. Trade carefully.`,
        {
          duration: 10000,
          icon: renderIcon('warning', { size: 16, color: 'var(--accent-red)' }),
        }
      )
      handlersRef.current.setError(data.message)
    })

    // ── Platform-wide admin broadcasts (Notification Center → "web" channel) ──
    socket.on('platform_notification', (data) => {
      if (!data?.message) return
      handlersRef.current.pushNotification(data.title ? `${data.title}: ${data.message}` : data.message, data.type || 'info')
    })

    // Captured here rather than read in the cleanup: the buffer is created once
    // and never reassigned, so this is the same Map either way, but reading a
    // ref during cleanup is the pattern the lint rule (correctly) warns about.
    const pendingEquity = pendingEquityRef.current

    return () => {
      if (equityFrameRef.current) cancelAnimationFrame(equityFrameRef.current)
      equityFrameRef.current = null
      pendingEquity.clear()
      socket.disconnect()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { connected, socketRef }
}
