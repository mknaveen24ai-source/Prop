import { useCallback, useRef, useState } from 'react'
import { getMemoryItem, setMemoryItem } from '../../../utils/memoryStore'

const TRADING_SPLIT_MIN = 50
const TRADING_SPLIT_MAX = 85
const TRADING_SPLIT_DEFAULT = 74
const TRADING_SPLIT_STORAGE_KEY = 'tradingSplitPct'

// The draggable divider between the chart and the order panel. Width is
// persisted, and only written back on mouse-up so a drag does not thrash
// storage on every mousemove.
export default function useSplitPane() {
  const tradingLayoutRef = useRef(null)
  const [splitPct, setSplitPct] = useState(() => {
    const saved = parseFloat(getMemoryItem(TRADING_SPLIT_STORAGE_KEY))
    return Number.isFinite(saved) && saved >= TRADING_SPLIT_MIN && saved <= TRADING_SPLIT_MAX
      ? saved
      : TRADING_SPLIT_DEFAULT
  })

  const handleSplitDragStart = useCallback((e) => {
    e.preventDefault()
    const container = tradingLayoutRef.current
    if (!container) return
    const startX = e.clientX
    const startPct = splitPct
    const containerWidth = container.getBoundingClientRect().width

    function onMouseMove(moveEvent) {
      const deltaPct = ((moveEvent.clientX - startX) / containerWidth) * 100
      const nextPct = Math.max(TRADING_SPLIT_MIN, Math.min(TRADING_SPLIT_MAX, startPct + deltaPct))
      setSplitPct(nextPct)
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setSplitPct((current) => {
        setMemoryItem(TRADING_SPLIT_STORAGE_KEY, String(Math.round(current)))
        return current
      })
    }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [splitPct])

  // Double-clicking the handle restores the default width.
  const resetSplit = useCallback(() => {
    setSplitPct(TRADING_SPLIT_DEFAULT)
    setMemoryItem(TRADING_SPLIT_STORAGE_KEY, String(TRADING_SPLIT_DEFAULT))
  }, [])

  return { tradingLayoutRef, splitPct, handleSplitDragStart, resetSplit }
}
