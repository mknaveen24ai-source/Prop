/**
 * Forex markets trade continuously from Sunday 22:00 UTC (~5pm ET) through
 * Friday 22:00 UTC — the standard interbank week. Drives the header's live
 * "MARKETS OPEN" status pill (Modern Gazette handoff spec).
 */
export function isMarketOpen(date = new Date()) {
  const day = date.getUTCDay() // 0=Sun..6=Sat
  const hour = date.getUTCHours()
  if (day === 0) return hour >= 22
  if (day === 6) return false
  if (day === 5) return hour < 22
  return true
}
