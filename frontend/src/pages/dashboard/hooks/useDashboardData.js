import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import useStore from '../../../store/useStore'
import { filterVisibleTraderAccounts, isTraderAccountVisible } from '../../../utils/accountVisibility'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'
import { enrichTradesWithPrices } from '../enrichTradesWithPrices'

// Every read the dashboard performs, plus the account-selection effects that
// depend on them.
//
// The fetchers are returned (not just run internally) because the socket
// handlers re-run them on account_update, and the trade actions re-run them
// after an open/close/cancel. They are wrapped in useCallback with empty deps
// and read the current account through selectedAccountRef, so the socket effect
// can depend on them without re-subscribing on every account switch.
export default function useDashboardData({ setError }) {
  const [stats, setStats] = useState(null)
  const [accountRules, setAccountRules] = useState(null)
  const [tradeHistory, setTradeHistory] = useState([])
  const [payouts, setPayouts] = useState([])
  const [accountHistory, setAccountHistory] = useState([])
  const [profitSharePct, setProfitSharePct] = useState(80)
  const [accountLoading, setAccountLoading] = useState(false)

  const {
    activeAccount: selectedAccount,
    allAccounts: accounts,
    setActiveAccount,
    setAllAccounts,
    switchAccount,
    prices,
    updatePrices,
    setOpenPositions,
  } = useStore()

  const selectedAccountRef = useRef(null)
  const pricesRef = useRef({})
  useEffect(() => { selectedAccountRef.current = selectedAccount }, [selectedAccount])
  useEffect(() => { pricesRef.current = prices }, [prices])

  // Memoised because it is a dependency of the visibility effect below — a
  // fresh array each render would re-run that effect on every render.
  const visibleAccounts = useMemo(() => filterVisibleTraderAccounts(accounts), [accounts])

  const setSelectedAccount = useCallback((account) => {
    if (!account) {
      setActiveAccount(null)
      return
    }

    switchAccount(account.id)

    if (useStore.getState().activeAccount?.id !== account.id) {
      setActiveAccount(account)
    }
  }, [setActiveAccount, switchAccount])

  const fetchAccounts = useCallback(async () => {
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
    } catch (err) {
      // Logged as well as banner-ed: the banner clears itself after 5s, so a
      // failure caught mid-session used to leave nothing behind to diagnose.
      console.error('[Dashboard] fetchAccounts failed:', err.response?.status, err.response?.data?.error || err.message)
      setError('Could not fetch accounts')
    }
  }, [setAllAccounts, setActiveAccount, setError])

  const fetchPrices = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/prices`)
      updatePrices(res.data)
      pricesRef.current = res.data
    } catch {}
  }, [updatePrices])

  const fetchStats = useCallback(async (id) => {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/stats/${id}`)
      setStats(res.data)
    } catch (err) {
      console.error('[Dashboard] fetchStats failed:', err.response?.data?.error || err.message)
      // Keep stats null so the loading state shows rather than a blank page
    }
  }, [])

  const fetchAccountRules = useCallback(async (id) => {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/rules/${id}`)
      setAccountRules(res.data)
    } catch {}
  }, [])

  const fetchOpenTrades = useCallback(async (id) => {
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
  }, [setOpenPositions])

  const fetchTradeHistory = useCallback(async (id) => {
    try { const res = await axios.get(`${API_URL}/api/trades/history`, { params: { account_id: id } }); setTradeHistory(res.data) } catch {}
  }, [])

  const fetchPayouts = useCallback(async () => {
    try { const res = await axios.get(`${API_URL}/api/payouts/my-payouts`); setPayouts(res.data) } catch {}
  }, [])

  const fetchPayoutSettings = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/payouts/settings`)
      if (res.data?.profit_share_pct) setProfitSharePct(parseFloat(res.data.profit_share_pct))
    } catch {}
  }, [])

  const fetchAccountHistory = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/api/accounts/history`)
      setAccountHistory(res.data)
    } catch {}
  }, [])

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

  // Refetch everything scoped to the currently selected account. The socket's
  // account_update handler and the trade actions both need exactly this set.
  const refreshSelectedAccount = useCallback(() => {
    const current = selectedAccountRef.current
    if (!current) return
    fetchStats(current.id)
    fetchAccountRules(current.id)
    fetchOpenTrades(current.id)
    fetchTradeHistory(current.id)
  }, [fetchStats, fetchAccountRules, fetchOpenTrades, fetchTradeHistory])

  return {
    stats,
    accountRules,
    tradeHistory,
    payouts,
    accountHistory,
    profitSharePct,
    accountLoading,
    accounts,
    visibleAccounts,
    selectedAccount,
    setSelectedAccount,
    selectedAccountRef,
    pricesRef,
    prices,
    fetchAccounts,
    fetchPrices,
    fetchStats,
    fetchAccountRules,
    fetchOpenTrades,
    fetchTradeHistory,
    fetchPayouts,
    fetchAccountHistory,
    refreshSelectedAccount
  }
}
