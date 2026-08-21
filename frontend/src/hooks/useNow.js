import { useEffect, useState } from 'react'

/**
 * A wall-clock reading that re-renders on an interval.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Calling `Date.now()` during render produces a value that is correct at the
 * instant of the render and silently wrong forever after, because nothing
 * schedules the re-render that would refresh it. In a trading UI that is not a
 * theoretical problem:
 *
 *   - `hasFreshPushedEquity = Date.now() - received_at < 5000` decides whether
 *     to show engine-pushed equity or fall back to fetched values. Read once
 *     during render, a feed that stalls goes on looking fresh indefinitely —
 *     the balance freezes at its last pushed value and nothing says so.
 *   - Position age and SLA countdowns simply stop counting.
 *
 * DashboardHome already had two hand-rolled copies of this (`nowTick` and
 * PayoutCycleBanner's `now`), and its own comment at the staleness check spells
 * out why. This is that pattern, named once, so the next component that needs a
 * clock does not have to rediscover it — TradingPanel had the same staleness
 * check written against a raw `Date.now()` and therefore never re-evaluated it.
 *
 * The initialiser is lazy (`useState(() => Date.now())`) so the impure read
 * happens inside a callback React controls rather than in the render body.
 *
 * @param {number} [intervalMs=1000] How often to re-read the clock.
 * @returns {number} Milliseconds since the epoch, refreshed every intervalMs.
 */
export default function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])

  return now
}
