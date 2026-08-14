// Pure formatters for the batch-action result banner and the phase countdown.
// Extracted from TradingPanel so they can be read (and tested) without the
// component around them.

export function getTimeRemaining(endDateStr) {
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

export function formatBatchActionLabel(actionType) {
  if (actionType === 'close_winning') return 'Close Winners'
  if (actionType === 'close_losing') return 'Close Losers'
  if (actionType === 'breakeven_winning') return 'Breakeven Winners'
  return actionType.replace(/_/g, ' ')
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

export function buildBatchFeedback(actionType, data) {
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
