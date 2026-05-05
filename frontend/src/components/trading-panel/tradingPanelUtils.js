import { SUPPORTED_INSTRUMENTS, formatPrice, getPriceDecimals } from '../../utils/instruments'

export { SUPPORTED_INSTRUMENTS }

export function getDecimals(instrument) {
  return getPriceDecimals(instrument)
}

export function getTimeRemaining(endDateStr) {
  if (!endDateStr) return null
  const diff = new Date(endDateStr) - new Date()
  if (diff <= 0) return { expired: true, display: 'EXPIRED' }
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
  const seconds = Math.floor((diff % (1000 * 60)) / 1000)

  return {
    expired: false,
    days,
    hours,
    minutes,
    seconds,
    totalMs: diff,
    display: days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`,
    urgent: diff < 3 * 24 * 60 * 60 * 1000,
  }
}

export function exportTradesToCSV(trades, accountType, accountSize) {
  if (!trades || trades.length === 0) return

  const headers = ['ID', 'Instrument', 'Direction', 'Lots', 'Open Price', 'Close Price', 'Open Time', 'Close Time', 'P&L', 'Close Reason', 'Order Type']
  const rows = trades.map((trade) => [
    trade.id,
    trade.instrument,
    trade.direction,
    parseFloat(trade.lot_size).toFixed(2),
    trade.open_price ? formatPrice(trade.open_price, trade.instrument) : '',
    trade.close_price ? formatPrice(trade.close_price, trade.instrument) : '',
    trade.open_time ? new Date(trade.open_time).toISOString() : '',
    trade.close_time ? new Date(trade.close_time).toISOString() : '',
    trade.demo_pnl ? parseFloat(trade.demo_pnl).toFixed(2) : '0.00',
    trade.close_reason || 'Manual',
    trade.order_type || 'market',
  ])

  function csvSafeValue(value) {
    let stringValue = String(value).replace(/"/g, '""')
    if (/^[=+\-@\t\r]/.test(stringValue)) stringValue = `'${stringValue}`
    return `"${stringValue}"`
  }

  const csvContent = [headers, ...rows]
    .map((row) => row.map((value) => csvSafeValue(value)).join(','))
    .join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const safeAccountType = String(accountType || 'account').replace(/[^a-zA-Z0-9_-]/g, '_')
  const safeAccountSize = String(accountSize || '').replace(/[^a-zA-Z0-9_.]/g, '_')

  link.href = url
  link.download = `trade_history_${safeAccountType}_${safeAccountSize}_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
