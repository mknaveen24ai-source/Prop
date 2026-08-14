import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPersistentItem, setPersistentItem } from '../../../utils/memoryStore'
import { INSTRUMENT_GROUPS } from '../../../utils/instruments'

const WATCHLIST_STORAGE_KEY = 'tradingWatchlist'

// The watchlist rail: pinned instruments, the category filter, and the rolling
// price history behind each row's sparkline.
export default function useWatchlist(prices, availableInstruments) {
  const [pinnedInstruments, setPinnedInstruments] = useState(() => {
    try {
      const saved = JSON.parse(getPersistentItem(WATCHLIST_STORAGE_KEY) || '[]')
      return Array.isArray(saved) ? saved : []
    } catch {
      return []
    }
  })

  const togglePin = useCallback((instrument) => {
    setPinnedInstruments((current) => {
      const next = current.includes(instrument)
        ? current.filter((sym) => sym !== instrument)
        : [...current, instrument]
      setPersistentItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const [tickerCategory, setTickerCategory] = useState('all')

  // Rolling per-instrument price history for the Watchlist rail's sparklines
  // (Modern Gazette handoff spec: every stat/table row gets one). Buffered in
  // a ref so a price tick doesn't force a re-render on its own — only the
  // periodic tick below does, capped well under the sparkline's own 100x34
  // resolution.
  // The tick value itself is never read — bumping it is what re-renders the
  // component so the sparklines pick up the buffered history.
  const priceHistoryRef = useRef({})
  const [, setHistoryTick] = useState(0)

  useEffect(() => {
    const entries = Object.entries(prices || {})
    if (entries.length === 0) return
    for (const [instrument, data] of entries) {
      const mid = data?.bid != null && data?.ask != null ? (parseFloat(data.bid) + parseFloat(data.ask)) / 2 : parseFloat(data?.bid ?? data?.ask)
      if (!Number.isFinite(mid)) continue
      // Build a new array rather than mutating in place — the previous array
      // reference is handed straight to Recharts via <Sparkline data={history}/>,
      // which can freeze it internally, making a later .push()/.shift() throw.
      const nextHistory = [...(priceHistoryRef.current[instrument] || []), { value: mid }]
      if (nextHistory.length > 30) nextHistory.shift()
      priceHistoryRef.current[instrument] = nextHistory
    }
  }, [prices])

  useEffect(() => {
    const iv = setInterval(() => setHistoryTick((t) => t + 1), 4000)
    return () => clearInterval(iv)
  }, [])

  const sortedInstruments = useMemo(() => {
    const pinnedSet = new Set(pinnedInstruments)
    return [...availableInstruments].sort((a, b) => (pinnedSet.has(b) ? 1 : 0) - (pinnedSet.has(a) ? 1 : 0))
  }, [availableInstruments, pinnedInstruments])

  const tickerInstruments = useMemo(() => {
    if (tickerCategory === 'all') return sortedInstruments
    const group = INSTRUMENT_GROUPS[tickerCategory] || []
    return sortedInstruments.filter((instrument) => group.includes(instrument))
  }, [sortedInstruments, tickerCategory])

  // sortedInstruments stays internal — only the category-filtered list is
  // rendered.
  return {
    pinnedInstruments,
    togglePin,
    tickerCategory,
    setTickerCategory,
    priceHistoryRef,
    tickerInstruments
  }
}
