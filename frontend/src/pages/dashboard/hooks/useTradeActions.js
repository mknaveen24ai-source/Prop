import { useRef, useState } from 'react'
import axios from 'axios'
import { createIdempotencyHeaders, normalizeApiError } from '../../../services/api'
import { formatCurrency } from '../../../utils/finance'
import { API_BASE_URL as API_URL } from '../../../config/apiBase'

// Order entry and position management: the order ticket form plus open, close,
// partial-close and cancel.
//
// closingTradesRef guards against a double-submit racing the closingTradeIds
// state update, which is what actually prevents a trade being closed twice.
export default function useTradeActions({
  selectedAccount,
  setError,
  setSuccess,
  fetchOpenTrades,
  fetchStats,
  fetchTradeHistory
}) {
  const [orderForm, setOrderForm] = useState({
    instrument: 'EURUSD',
    lots: '0.01',
    stop_loss: '',
    take_profit: '',
    oco_enabled: false,
    oco_order_type: 'sell_stop',
    oco_pending_price: ''
  })
  const [tradeSubmitting, setTradeSubmitting] = useState(false)
  const [closingTradeIds, setClosingTradeIds] = useState([])
  const closingTradesRef = useRef(new Set())

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
      setSuccess(`${options.closeLots ? 'Partial close executed' : 'Trade closed'}. P&L: ${formatCurrency(res.data.pnl, { signed: true })}`)
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

  return {
    orderForm,
    setOrderForm,
    tradeSubmitting,
    closingTradeIds,
    openTrade,
    closeTrade,
    cancelOrder,
    handleTradeModified
  }
}
