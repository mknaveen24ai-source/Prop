import React, { useEffect, useState } from 'react'
import { isMarketOpen } from '../utils/marketHours'
import useStore from '../store/useStore'

/**
 * Live "MARKETS OPEN" header status pill (Modern Gazette handoff spec).
 * Ticks every 30s off wall-clock time — no backend round-trip needed, the
 * forex week boundary is a pure function of UTC time (see utils/marketHours).
 */
export default function MarketStatusPill() {
  const [open, setOpen] = useState(() => isMarketOpen())
  const setMarketOpen = useStore((s) => s.setMarketOpen)

  useEffect(() => {
    setMarketOpen(open)
    const id = setInterval(() => {
      setOpen((prev) => {
        const next = isMarketOpen()
        if (next !== prev) setMarketOpen(next)
        return next
      })
    }, 30000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <span className="lx-badge" style={{ color: open ? 'var(--gain)' : 'var(--muted)' }}>
      {open ? 'Markets Open' : 'Markets Closed'}
    </span>
  )
}
