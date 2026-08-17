import { useEffect, useMemo, useState } from 'react'
import {
  CONTRACT_SIZES,
  INSTRUMENT_GROUPS,
  getInputStepString,
  getPriceDecimals,
  getSpreadPoints,
  getTradableInstruments,
  getUsdRateForInstrument,
  isTradableInstrument,
} from '../../../utils/instruments'
import { calculateRiskRewardRatio, toDecimal, toMoneyNumber } from '../../../utils/finance'

/**
 * Every piece of order-entry state, derivation and submission, shared by the
 * desktop OrderPanel and the mobile order ticket.
 *
 * The two surfaces look nothing alike — a persistent side panel versus a
 * bottom sheet — but they must place *identical* orders. Keeping the R:R maths,
 * the market-hours gate, the FX conversion and the payload shape in one place
 * is the point: a second copy of this logic would be a second place for the
 * risk numbers to drift.
 *
 * Views own their own markup and nothing else.
 */

export function getMarketStatus() {
  const now = new Date()
  const day = now.getUTCDay()
  const hour = now.getUTCHours()
  const min = now.getUTCMinutes()
  const total = hour * 60 + min

  if (day === 6) return { open: false, reason: 'Market closed - weekend. Opens Sunday 22:00 UTC.' }
  if (day === 5 && total >= 22 * 60) return { open: false, reason: 'Market closed - weekend. Opens Sunday 22:00 UTC.' }
  if (day === 0 && total < 22 * 60) {
    const minsLeft = 22 * 60 - total
    return { open: false, reason: `Market opens Sunday 22:00 UTC (in ${Math.floor(minsLeft / 60)}h ${minsLeft % 60}m).` }
  }
  if (day >= 1 && day <= 5 && total >= 21 * 60 + 55 && total < 22 * 60 + 5) {
    return { open: false, reason: 'Daily rollover 21:55-22:05 UTC. Try again shortly.' }
  }

  return { open: true, reason: '' }
}

/**
 * Market status including the Friday-evening cutoff on *new* trades. Separate
 * from getMarketStatus so the plain session check stays reusable.
 */
export function getTradingWindow() {
  const now = new Date()
  const total = now.getUTCHours() * 60 + now.getUTCMinutes()
  if (now.getUTCDay() === 5 && total >= 21 * 60) {
    return { open: false, reason: 'New trades stop after Friday 21:00 UTC to avoid weekend gap risk.' }
  }
  return getMarketStatus()
}

export default function useOrderTicket({
  prices,
  selectedAccount,
  floatingBalance,
  availableInstruments = getTradableInstruments(),
  onOpenTrade,
  orderForm,
  setOrderForm,
}) {
  const [orderMode, setOrderMode] = useState('market')
  const [marketPreviewDirection, setMarketPreviewDirection] = useState('buy')
  const [pendingType, setPendingType] = useState('buy_limit')
  const [pendingPrice, setPendingPrice] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [symbolCategory, setSymbolCategory] = useState('all')

  const updateForm = (patch) => setOrderForm((current) => ({ ...current, ...patch }))

  const filteredInstruments = useMemo(() => {
    if (symbolCategory === 'all') return availableInstruments
    const group = INSTRUMENT_GROUPS[symbolCategory] || []
    return availableInstruments.filter((item) => group.includes(item))
  }, [symbolCategory, availableInstruments])

  useEffect(() => {
    if (filteredInstruments.length === 0) return
    if (!filteredInstruments.includes(orderForm.instrument)) {
      updateForm({ instrument: filteredInstruments[0], stop_loss: '', take_profit: '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredInstruments])

  const instrument = orderForm.instrument
  const priceData = prices[instrument]
  const decimals = getPriceDecimals(instrument)
  const step = getInputStepString(instrument)
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  const accountBalanceNum = selectedAccount ? parseFloat(selectedAccount.current_balance || 0) : 0
  const floatingBalanceNum = Number.isFinite(parseFloat(floatingBalance))
    ? parseFloat(floatingBalance)
    : accountBalanceNum
  const bidNum = priceData ? parseFloat(priceData.bid) : null
  const askNum = priceData ? parseFloat(priceData.ask) : null
  const bid = Number.isFinite(bidNum) ? bidNum.toFixed(decimals) : '-'
  const ask = Number.isFinite(askNum) ? askNum.toFixed(decimals) : '-'
  const spread = priceData
    ? getSpreadPoints(parseFloat(priceData.ask) - parseFloat(priceData.bid), instrument).toFixed(1)
    : '-'

  const marketStatus = getTradingWindow()

  const pendingDirection = pendingType.startsWith('buy') ? 'buy' : 'sell'
  const pendingPriceNum = Number.isFinite(parseFloat(pendingPrice)) ? parseFloat(pendingPrice) : null
  const stopLossNum = Number.isFinite(parseFloat(orderForm.stop_loss)) ? parseFloat(orderForm.stop_loss) : null
  const takeProfitNum = Number.isFinite(parseFloat(orderForm.take_profit)) ? parseFloat(orderForm.take_profit) : null

  const previewDirection = orderMode === 'pending' ? pendingDirection : marketPreviewDirection
  const previewEntry = orderMode === 'pending'
    ? pendingPriceNum
    : previewDirection === 'buy'
      ? askNum
      : bidNum

  const rrSummary = useMemo(() => {
    const lots = Number.isFinite(parseFloat(orderForm.lots)) ? parseFloat(orderForm.lots) : null
    if (!lots || lots < 0.01 || !Number.isFinite(previewEntry) || (!stopLossNum && !takeProfitNum)) return null

    // C-01: distance * lots * contractSize lands in the instrument's QUOTE
    // currency, so calling it USD needs the same QUOTE/USD rate the server
    // applies. A null rate means we cannot state a dollar figure — show nothing
    // rather than a number that is wrong by the rate (~150x on the JPY pairs).
    if (!isTradableInstrument(instrument)) return null
    const usdRate = getUsdRateForInstrument(prices, instrument)
    if (usdRate == null) return null

    const riskDistance = stopLossNum ? Math.abs(previewEntry - stopLossNum) : null
    const rewardDistance = takeProfitNum ? Math.abs(takeProfitNum - previewEntry) : null

    const toUSD = (distance) => toMoneyNumber(
      toDecimal(distance).mul(toDecimal(lots)).mul(toDecimal(contractSize)).mul(toDecimal(usdRate))
    )

    const riskUSD = riskDistance != null ? toUSD(riskDistance) : null
    const rewardUSD = rewardDistance != null ? toUSD(rewardDistance) : null
    const rr = riskUSD != null && rewardUSD != null
      ? calculateRiskRewardRatio(riskUSD, rewardUSD)
      : null

    return { riskUSD, rewardUSD, rr }
  }, [contractSize, instrument, orderForm.lots, previewEntry, prices, stopLossNum, takeProfitNum])

  async function submitOrder(payload) {
    if (isSubmitting) return
    setIsSubmitting(true)
    try {
      await onOpenTrade(payload)
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleMarketOrder(direction) {
    setMarketPreviewDirection(direction)
    return submitOrder({
      direction,
      orderType: 'market',
      pendingPrice: null,
    })
  }

  function handlePendingOrder() {
    const price = parseFloat(pendingPrice)
    if (!pendingPrice || Number.isNaN(price) || price <= 0) return undefined

    const ocoEnabled = Boolean(orderForm.oco_enabled && orderForm.oco_order_type && orderForm.oco_pending_price)
    const ocoSibling = ocoEnabled
      ? {
          order_type: orderForm.oco_order_type,
          pending_price: parseFloat(orderForm.oco_pending_price),
        }
      : null

    const direction = pendingDirection
    const result = submitOrder({
      direction,
      orderType: pendingType,
      pendingPrice: price,
      ocoSibling,
    })
    setPendingPrice('')
    return result
  }

  /** True when an order can actually be placed right now. */
  const canTrade = Boolean(selectedAccount) && Boolean(priceData) && marketStatus.open

  return {
    // mode / selection state
    orderMode, setOrderMode,
    marketPreviewDirection, setMarketPreviewDirection,
    pendingType, setPendingType,
    pendingPrice, setPendingPrice,
    symbolCategory, setSymbolCategory,
    isSubmitting,

    // form plumbing
    updateForm,
    filteredInstruments,

    // instrument + price derivations
    instrument, priceData, decimals, step, contractSize,
    bid, ask, bidNum, askNum, spread,
    accountBalanceNum, floatingBalanceNum,

    // order derivations
    marketStatus, canTrade,
    pendingDirection, pendingPriceNum,
    stopLossNum, takeProfitNum,
    previewDirection, previewEntry,
    rrSummary,

    // actions
    handleMarketOrder,
    handlePendingOrder,
  }
}
