import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineStyle } from 'lightweight-charts'
import api from '../services/api'
import { useTheme } from '../ThemeContext'
import {
  SUPPORTED_INSTRUMENTS,
  formatPrice,
  roundPrice
} from '../utils/instruments'
import {
  CHART_TIMEFRAMES,
  DEFAULT_CHART_TIMEFRAME,
  getChartTimeframeMinutes
} from '../utils/chartTimeframes'

const SESSION_SPECS = [
  { label: 'ASIA', hour: 0, color: '#60a5fa' },
  { label: 'LONDON', hour: 8, color: '#fbbf24' },
  { label: 'NEW YORK', hour: 13, color: '#fb7185' }
]

function getTraderChartPalette(theme = 'dark') {
  if (theme === 'light') {
    return {
      background: '#ffffff',
      panelBg: 'rgba(255, 255, 255, 0.84)',
      optionBg: '#ffffff',
      paneBg: 'rgba(255, 255, 255, 0.92)',
      paneBorder: 'rgba(37, 99, 235, 0.14)',
      text: '#0f172a',
      muted: '#64748b',
      grid: 'rgba(15, 23, 42, 0.08)',
      scaleBorder: 'rgba(15, 23, 42, 0.12)',
      lineLabelBg: 'rgba(255, 255, 255, 0.96)',
      toolbarButtonBg: 'rgba(15, 23, 42, 0.04)',
      toolbarButtonBorder: 'rgba(15, 23, 42, 0.08)',
      toolbarChipBg: 'rgba(37, 99, 235, 0.08)',
      toolbarChipBorder: 'rgba(37, 99, 235, 0.14)',
      shadow: '0 10px 24px rgba(15, 23, 42, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.72)'
    }
  }

  return {
    background: '#090B0E',
    panelBg: 'rgba(9, 11, 14, 0.84)',
    optionBg: '#090B0E',
    paneBg: 'rgba(13, 17, 23, 0.6)',
    paneBorder: 'rgba(74, 144, 226, 0.12)',
    text: '#E8ECF1',
    muted: '#8B949E',
    grid: 'rgba(255, 255, 255, 0.05)',
    scaleBorder: 'rgba(255, 255, 255, 0.1)',
    lineLabelBg: 'rgba(9, 11, 14, 0.92)',
    toolbarButtonBg: 'rgba(255, 255, 255, 0.04)',
    toolbarButtonBorder: 'rgba(255, 255, 255, 0.08)',
    toolbarChipBg: 'rgba(255, 255, 255, 0.04)',
    toolbarChipBorder: 'rgba(255, 255, 255, 0.08)',
    shadow: '0 2px 8px rgba(0, 0, 0, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.02)'
  }
}

function getInstrumentUniverse(availableInstruments = []) {
  const liveList = Array.isArray(availableInstruments)
    ? availableInstruments.filter(Boolean)
    : []

  return liveList.length > 0 ? liveList : [...SUPPORTED_INSTRUMENTS]
}

function buildPaneSymbols(primaryInstrument, availableInstruments, count, previous = []) {
  const universe = getInstrumentUniverse(availableInstruments)
  const fallbackPrimary = universe[0] || SUPPORTED_INSTRUMENTS[0]
  const firstSymbol = universe.includes(primaryInstrument) ? primaryInstrument : fallbackPrimary
  const nextSymbols = [firstSymbol]
  const used = new Set([firstSymbol])

  for (let index = 1; index < count; index += 1) {
    const preferred = previous[index]
    if (preferred && universe.includes(preferred) && !used.has(preferred)) {
      nextSymbols.push(preferred)
      used.add(preferred)
      continue
    }

    const fallback = universe.find((symbol) => !used.has(symbol)) || firstSymbol
    nextSymbols.push(fallback)
    used.add(fallback)
  }

  return nextSymbols
}

function toEpochSeconds(value) {
  if (!value) return null
  const ts = Math.floor(new Date(value).getTime() / 1000)
  return Number.isFinite(ts) ? ts : null
}

function buildTradeMarkers(tradeHistory, instrument) {
  const rows = Array.isArray(tradeHistory) ? tradeHistory : []

  return rows
    .filter((trade) => trade.instrument === instrument && trade.open_time && trade.close_time)
    .flatMap((trade) => {
      const openTime = toEpochSeconds(trade.open_time)
      const closeTime = toEpochSeconds(trade.close_time)
      if (!openTime || !closeTime) return []

      const pnl = parseFloat(trade.demo_pnl || 0)
      const isProfit = pnl >= 0
      const isBuy = trade.direction === 'buy'

      return [
        {
          time: openTime,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#00C899' : '#FF4757',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          text: `${isBuy ? 'BUY' : 'SELL'} OPEN`
        },
        {
          time: closeTime,
          position: isProfit ? 'aboveBar' : 'belowBar',
          color: isProfit ? '#00C899' : '#FF4757',
          shape: isProfit ? 'arrowUp' : 'arrowDown',
          text: `${isProfit ? 'WIN' : 'LOSS'} CLOSE`
        }
      ]
    })
    .sort((a, b) => a.time - b.time)
    .slice(-350)
}

function buildSessionMarkers(candles = []) {
  const seen = new Set()

  return candles.flatMap((candle) => {
    const date = new Date(candle.time * 1000)
    return SESSION_SPECS.flatMap((session) => {
      if (date.getUTCHours() !== session.hour || date.getUTCMinutes() !== 0) {
        return []
      }
      const key = `${session.label}:${date.toISOString().slice(0, 13)}`
      if (seen.has(key)) return []
      seen.add(key)
      return [{
        time: candle.time,
        position: 'aboveBar',
        color: session.color,
        shape: 'circle',
        text: session.label
      }]
    })
  }).slice(-120)
}

function buildTradeLevels(openTrades, instrument) {
  return (Array.isArray(openTrades) ? openTrades : [])
    .filter((trade) => trade.status === 'open' && trade.instrument === instrument)
    .flatMap((trade) => {
      const levels = []
      const openPrice = parseFloat(trade.open_price)
      const stopLoss = parseFloat(trade.stop_loss)
      const takeProfit = parseFloat(trade.take_profit)

      if (Number.isFinite(openPrice)) {
        levels.push({
          id: trade.id,
          field: 'open_price',
          kind: trade.direction === 'buy' ? 'BUY OPEN' : 'SELL OPEN',
          shortLabel: 'ENTRY',
          price: openPrice,
          color: trade.direction === 'buy' ? '#00C899' : '#FF4757',
          draggable: false,
          lineStyle: typeof LineStyle !== 'undefined' ? LineStyle.Solid : 0
        })
      }

      if (Number.isFinite(stopLoss)) {
        levels.push({
          id: trade.id,
          field: 'stop_loss',
          kind: 'SL',
          shortLabel: 'SL',
          price: stopLoss,
          color: '#FF4757',
          draggable: true,
          lineStyle: typeof LineStyle !== 'undefined' ? LineStyle.Dashed : 2
        })
      }

      if (Number.isFinite(takeProfit)) {
        levels.push({
          id: trade.id,
          field: 'take_profit',
          kind: 'TP',
          shortLabel: 'TP',
          price: takeProfit,
          color: '#00C899',
          draggable: true,
          lineStyle: typeof LineStyle !== 'undefined' ? LineStyle.Dashed : 2
        })
      }

      return levels
    })
}

function overlayLevelsEqual(current = [], next = []) {
  if (current === next) return true
  if (current.length !== next.length) return false

  for (let index = 0; index < current.length; index += 1) {
    const currentLevel = current[index]
    const nextLevel = next[index]
    if (
      currentLevel.id !== nextLevel.id ||
      currentLevel.field !== nextLevel.field ||
      currentLevel.kind !== nextLevel.kind ||
      currentLevel.shortLabel !== nextLevel.shortLabel ||
      currentLevel.price !== nextLevel.price ||
      currentLevel.y !== nextLevel.y ||
      currentLevel.color !== nextLevel.color ||
      currentLevel.draggable !== nextLevel.draggable ||
      currentLevel.lineStyle !== nextLevel.lineStyle
    ) {
      return false
    }
  }

  return true
}

function ChartPane({
  paneIndex,
  instrument,
  symbolColor,
  availableInstruments,
  showSymbolSelector,
  livePrice,
  openTrades,
  tradeHistory,
  timeframe,
  onTradeLineAdjust,
  onInstrumentChange
}) {
  const { theme } = useTheme()
  const chartPalette = useMemo(() => getTraderChartPalette(theme), [theme])
  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const currentCandleRef = useRef(null)
  const priceLinesRef = useRef([])
  const dragRef = useRef(null)
  const sltpLevelsRef = useRef([])
  const [candles, setCandles] = useState([])
  const [overlayLevels, setOverlayLevels] = useState([])

  const tradeMarkers = useMemo(() => buildTradeMarkers(tradeHistory, instrument), [tradeHistory, instrument])
  const sessionMarkers = useMemo(() => buildSessionMarkers(candles), [candles])
  const sltpLevels = useMemo(() => buildTradeLevels(openTrades, instrument), [openTrades, instrument])

  useEffect(() => {
    sltpLevelsRef.current = sltpLevels
  }, [sltpLevels])

  const syncOverlayLevels = useCallback(() => {
    const series = candleSeriesRef.current
    if (!series) return

    const nextLevels = sltpLevelsRef.current
      .map((level) => {
        const y = series.priceToCoordinate(level.price)
        if (!Number.isFinite(y)) return null
        return { ...level, y }
      })
      .filter(Boolean)

    setOverlayLevels((current) => (
      overlayLevelsEqual(current, nextLevels) ? current : nextLevels
    ))
  }, [])

  useEffect(() => {
    if (!chartContainerRef.current) return undefined

    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth || 400,
      height: chartContainerRef.current.clientHeight || 320,
      layout: {
        background: { type: 'solid', color: chartPalette.background },
        textColor: chartPalette.muted
      },
      grid: {
        vertLines: { color: chartPalette.grid },
        horzLines: { color: chartPalette.grid }
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: chartPalette.muted, style: 0 },
        horzLine: { width: 1, color: chartPalette.muted, style: 0 }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: chartPalette.scaleBorder
      }
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00C899',
      downColor: '#FF4757',
      borderVisible: false,
      wickUpColor: '#00C899',
      wickDownColor: '#FF4757'
    })

    chartRef.current = chart
    candleSeriesRef.current = candleSeries

    const resizeObserver = new ResizeObserver(() => {
      if (!chartRef.current || !chartContainerRef.current) return
      chartRef.current.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight
      })
      syncOverlayLevels()
    })

    resizeObserver.observe(chartContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      priceLinesRef.current.forEach((line) => {
        try { candleSeries.removePriceLine(line) } catch {}
      })
      priceLinesRef.current = []
      setOverlayLevels([])
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
    }
  }, [chartPalette.background, chartPalette.grid, chartPalette.muted, chartPalette.scaleBorder, syncOverlayLevels])

  useEffect(() => {
    if (!chartRef.current) return

    chartRef.current.applyOptions({
      layout: {
        background: { type: 'solid', color: chartPalette.background },
        textColor: chartPalette.muted
      },
      grid: {
        vertLines: { color: chartPalette.grid },
        horzLines: { color: chartPalette.grid }
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: chartPalette.muted, style: 0 },
        horzLine: { width: 1, color: chartPalette.muted, style: 0 }
      },
      rightPriceScale: {
        borderColor: chartPalette.scaleBorder
      }
    })
    syncOverlayLevels()
  }, [chartPalette, syncOverlayLevels])

  useEffect(() => {
    let cancelled = false

    async function loadCandles() {
      if (!candleSeriesRef.current) return

      try {
        currentCandleRef.current = null
        candleSeriesRef.current.setData([])
        setCandles([])
        setOverlayLevels([])

        const res = await api.get('/api/trades/candles', {
          params: { instrument, timeframe }
        })
        if (cancelled || !candleSeriesRef.current) return

        const raw = Array.isArray(res.data) ? res.data : []
        const seen = new Set()
        const clean = raw
          .filter((candle) => {
            const time = Number(candle.time)
            if (!Number.isFinite(time) || seen.has(time)) return false
            seen.add(time)
            return true
          })
          .map((candle) => ({
            time: Number(candle.time),
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close)
          }))
          .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
          .sort((a, b) => a.time - b.time)

        candleSeriesRef.current.setData(clean)
        setCandles(clean)
        currentCandleRef.current = clean.length > 0 ? { ...clean[clean.length - 1] } : null
        chartRef.current?.timeScale().fitContent()
        syncOverlayLevels()
      } catch (error) {
        console.error(`Error fetching chart history for ${instrument}:`, error)
      }
    }

    loadCandles()

    return () => {
      cancelled = true
    }
  }, [instrument, timeframe, syncOverlayLevels])

  useEffect(() => {
    if (!candleSeriesRef.current) return
    try {
      candleSeriesRef.current.setMarkers([...sessionMarkers, ...tradeMarkers])
    } catch {}
  }, [sessionMarkers, tradeMarkers])

  useEffect(() => {
    if (!candleSeriesRef.current) return

    const series = candleSeriesRef.current
    priceLinesRef.current.forEach((line) => {
      try { series.removePriceLine(line) } catch {}
    })
    priceLinesRef.current = []

    sltpLevels.forEach((level) => {
      const line = series.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 1,
        lineStyle: level.lineStyle ?? (typeof LineStyle !== 'undefined' ? LineStyle.Dashed : 2),
        axisLabelVisible: true,
        title: `${level.kind} #${level.id}`
      })
      priceLinesRef.current.push(line)
    })

    syncOverlayLevels()
  }, [sltpLevels, syncOverlayLevels])

  useEffect(() => {
    if (!candleSeriesRef.current || !livePrice) return

    const bid = parseFloat(livePrice.bid)
    if (!Number.isFinite(bid)) return

    const intervalMinutes = getChartTimeframeMinutes(timeframe)
    if (!intervalMinutes) return

    const intervalSeconds = intervalMinutes * 60
    const now = Math.floor(Date.now() / 1000)
    const candleTime = Math.floor(now / intervalSeconds) * intervalSeconds

    if (!currentCandleRef.current || currentCandleRef.current.time !== candleTime) {
      currentCandleRef.current = {
        time: candleTime,
        open: bid,
        high: bid,
        low: bid,
        close: bid
      }
    } else {
      currentCandleRef.current = {
        ...currentCandleRef.current,
        high: Math.max(currentCandleRef.current.high, bid),
        low: Math.min(currentCandleRef.current.low, bid),
        close: bid
      }
    }

    try {
      candleSeriesRef.current.update(currentCandleRef.current)
      if (sltpLevelsRef.current.length > 0) {
        syncOverlayLevels()
      }
    } catch {}
  }, [instrument, livePrice, syncOverlayLevels, timeframe])

  useEffect(() => {
    function handleMouseMove(event) {
      if (!chartContainerRef.current || !candleSeriesRef.current || !dragRef.current) return
      const bounds = chartContainerRef.current.getBoundingClientRect()
      const relativeY = Math.min(Math.max(event.clientY - bounds.top, 8), bounds.height - 8)
      const nextPrice = candleSeriesRef.current.coordinateToPrice(relativeY)
      if (!Number.isFinite(nextPrice)) return
      dragRef.current = {
        ...dragRef.current,
        y: relativeY,
        price: nextPrice
      }
      setOverlayLevels((current) => current.map((level) => (
        level.id === dragRef.current.tradeId && level.field === dragRef.current.field
          ? { ...level, y: relativeY, price: nextPrice }
          : level
      )))
    }

    function handleMouseUp() {
      if (!dragRef.current) return
      const finishedDrag = dragRef.current
      dragRef.current = null
      if (Number.isFinite(finishedDrag.price)) {
        onTradeLineAdjust?.(finishedDrag.tradeId, {
          [finishedDrag.field]: roundPrice(finishedDrag.price, instrument)
        })
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [instrument, onTradeLineAdjust])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 5,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: chartPalette.panelBg,
        border: `1px solid ${chartPalette.toolbarButtonBorder}`,
        padding: '6px 10px',
        borderRadius: '999px',
        backdropFilter: 'blur(8px)'
      }}>
        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: symbolColor }} />
        {showSymbolSelector ? (
          <select
            value={instrument}
            onChange={(event) => onInstrumentChange?.(event.target.value)}
            style={{
              background: 'transparent',
              border: 'none',
              color: chartPalette.text,
              fontWeight: '700',
              letterSpacing: '0.04em',
              outline: 'none',
              cursor: 'pointer'
            }}
          >
            {availableInstruments.map((symbol) => (
              <option key={symbol} value={symbol} style={{ background: chartPalette.optionBg, color: chartPalette.text }}>
                {symbol}
              </option>
            ))}
          </select>
        ) : (
          <span style={{ color: symbolColor, fontWeight: '700', letterSpacing: '0.04em' }}>{instrument}</span>
        )}
        <span style={{ fontSize: '10px', color: chartPalette.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          {timeframe}
        </span>
      </div>

      <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />

      {overlayLevels.map((level) => (
        <div
          key={`${level.id}-${level.field}`}
          onMouseDown={(event) => {
            if (!level.draggable) return
            event.preventDefault()
            dragRef.current = {
              tradeId: level.id,
              field: level.field,
              price: level.price,
              y: level.y
            }
          }}
          style={{
            position: 'absolute',
            left: 6,
            right: 6,
            top: level.y,
            transform: 'translateY(-50%)',
            borderTop: `1px ${level.draggable ? 'dashed' : 'solid'} ${level.color}`,
            cursor: level.draggable ? 'ns-resize' : 'default',
            zIndex: 6,
            pointerEvents: level.draggable ? 'auto' : 'none'
          }}
        >
          <span style={{
            position: 'absolute',
            right: 0,
            top: '-10px',
            padding: '2px 8px',
            borderRadius: '999px',
            background: chartPalette.lineLabelBg,
            border: `1px solid ${level.color}`,
            color: level.color,
            fontSize: '10px',
            fontWeight: '700',
            letterSpacing: '0.06em'
          }}>
            {level.shortLabel || level.kind} #{level.id} {formatPrice(level.price, instrument)}
          </span>
        </div>
      ))}
    </div>
  )
}

const MemoChartPane = React.memo(ChartPane, (previousProps, nextProps) => {
  const previousOptions = previousProps.availableInstruments || []
  const nextOptions = nextProps.availableInstruments || []

  if (
    previousProps.paneIndex !== nextProps.paneIndex ||
    previousProps.instrument !== nextProps.instrument ||
    previousProps.symbolColor !== nextProps.symbolColor ||
    previousProps.showSymbolSelector !== nextProps.showSymbolSelector ||
    previousProps.timeframe !== nextProps.timeframe ||
    previousProps.openTrades !== nextProps.openTrades ||
    previousProps.tradeHistory !== nextProps.tradeHistory ||
    previousProps.onTradeLineAdjust !== nextProps.onTradeLineAdjust
  ) {
    return false
  }

  if (previousOptions.length !== nextOptions.length) {
    return false
  }

  for (let index = 0; index < previousOptions.length; index += 1) {
    if (previousOptions[index] !== nextOptions[index]) {
      return false
    }
  }

  return (
    previousProps.livePrice?.bid === nextProps.livePrice?.bid &&
    previousProps.livePrice?.ask === nextProps.livePrice?.ask
  )
})

export default function MultiChartGrid({
  selectedInstrument,
  availableInstruments = [],
  openTrades = [],
  tradeHistory = [],
  prices = {},
  selectedAccount = null,
  stats = null,
  onTradeLineAdjust,
  onPrimaryInstrumentChange
}) {
  const { theme } = useTheme()
  const chartPalette = useMemo(() => getTraderChartPalette(theme), [theme])
  const [layoutSpec, setLayoutSpec] = useState(1)
  const [selectedTimeframe, setSelectedTimeframe] = useState(DEFAULT_CHART_TIMEFRAME)
  const [paneSymbols, setPaneSymbols] = useState(() => buildPaneSymbols(selectedInstrument, availableInstruments, 1))

  const instrumentUniverse = useMemo(
    () => getInstrumentUniverse(availableInstruments),
    [availableInstruments]
  )

  useEffect(() => {
    setPaneSymbols((current) => buildPaneSymbols(selectedInstrument, instrumentUniverse, layoutSpec, current))
  }, [instrumentUniverse, layoutSpec, selectedInstrument])

  const updatePaneInstrument = useCallback((paneIndex, nextInstrument) => {
    if (!nextInstrument) return

    if (paneIndex === 0) {
      onPrimaryInstrumentChange?.(nextInstrument)
    }

    setPaneSymbols((current) => {
      const next = [...current]
      next[paneIndex] = nextInstrument
      return next
    })
  }, [onPrimaryInstrumentChange])

  const gridStyle = {
    display: 'grid',
    gap: '12px',
    width: '100%',
    height: '100%',
    gridTemplateColumns: layoutSpec === 1 ? '1fr' : '1fr 1fr',
    gridTemplateRows: layoutSpec === 4 ? '1fr 1fr' : '1fr'
  }

  const colors = ['#00E5FF', '#FF00A8', '#00FF85', '#FFD400']
  const layoutOptions = [
    { value: 1, label: 'Focus' },
    { value: 2, label: 'Split' },
    { value: 4, label: 'Quad' }
  ]

  const visiblePaneSymbols = paneSymbols.slice(0, layoutSpec)

  return (
    <div className="chart-workspace-shell">
      <div className="chart-workspace-toolbar">
        <div className="chart-workspace-meta">
          <div className="chart-toolbar-group" style={{ gap: '8px' }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M2 12L6 6L9 9L14 3" stroke="#4A90E2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M10 3H14V7" stroke="#4A90E2" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <div>
              <div style={{ fontSize: '13px', fontWeight: '700', color: chartPalette.text, letterSpacing: '0.04em' }}>
                Market Overview
              </div>
              <div style={{ fontSize: '10px', color: chartPalette.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                Stable panes with per-chart symbol selection in split and quad mode
              </div>
            </div>
          </div>
          <div className="chart-toolbar-group chart-pane-symbols" style={{ gap: '8px' }}>
            {visiblePaneSymbols.map((symbol, index) => (
              <span
                key={`${index}-${symbol}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  padding: '5px 10px',
                  borderRadius: '999px',
                  background: chartPalette.toolbarChipBg,
                  border: `1px solid ${chartPalette.toolbarChipBorder}`,
                  color: chartPalette.text,
                  fontSize: '11px',
                  fontWeight: '600'
                }}
              >
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: colors[index] }} />
                {symbol}
              </span>
            ))}
          </div>
        </div>
        <div className="chart-workspace-controls">
          <div className="chart-toolbar-group" style={{ gap: '6px' }}>
            <span style={{ fontSize: '11px', color: chartPalette.muted, marginRight: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Timeframe</span>
            {CHART_TIMEFRAMES.map((timeframe) => (
              <button
                key={timeframe.label}
                onClick={() => setSelectedTimeframe(timeframe.label)}
                style={{
                  background: selectedTimeframe === timeframe.label
                    ? 'linear-gradient(135deg, #00c2ff 0%, #007aff 100%)'
                    : chartPalette.toolbarButtonBg,
                  border: selectedTimeframe === timeframe.label
                    ? '1px solid rgba(0, 194, 255, 0.55)'
                    : `1px solid ${chartPalette.toolbarButtonBorder}`,
                  borderRadius: '10px',
                  padding: '7px 10px',
                  color: selectedTimeframe === timeframe.label ? '#fff' : chartPalette.muted,
                  fontSize: '11px',
                  fontWeight: selectedTimeframe === timeframe.label ? '700' : '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '48px'
                }}
              >
                {timeframe.label}
              </button>
            ))}
          </div>
          <div className="chart-toolbar-group" style={{ gap: '6px' }}>
            <span style={{ fontSize: '11px', color: chartPalette.muted, marginRight: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Layout</span>
            {layoutOptions.map((layout) => (
              <button
                key={layout.value}
                onClick={() => setLayoutSpec(layout.value)}
                style={{
                  background: layoutSpec === layout.value
                    ? 'linear-gradient(135deg, #4A90E2 0%, #357ABD 100%)'
                    : chartPalette.toolbarButtonBg,
                  border: layoutSpec === layout.value
                    ? '1px solid rgba(74, 144, 226, 0.5)'
                    : `1px solid ${chartPalette.toolbarButtonBorder}`,
                  borderRadius: '10px',
                  padding: '7px 12px',
                  color: layoutSpec === layout.value ? '#fff' : chartPalette.muted,
                  fontSize: '11px',
                  fontWeight: layoutSpec === layout.value ? '700' : '500',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease',
                  minWidth: '64px'
                }}
              >
                {layout.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="chart-workspace-body">
        <div
          className={`chart-layout-grid chart-layout-grid-${layoutSpec}`}
          style={{
            ...gridStyle,
            '--chart-grid-rows': String(layoutSpec === 4 ? 2 : 1)
          }}
        >
          {Array.from({ length: layoutSpec }).map((_, index) => {
            const symbol = paneSymbols[index] || instrumentUniverse[0] || SUPPORTED_INSTRUMENTS[0]
            return (
              <div
                key={`pane-${index}`}
                className="chart-pane-shell"
                style={{
                  border: `1px solid ${chartPalette.paneBorder}`,
                  borderRadius: '10px',
                  position: 'relative',
                  overflow: 'hidden',
                  background: chartPalette.paneBg,
                  boxShadow: chartPalette.shadow
                }}
              >
                <MemoChartPane
                  paneIndex={index}
                  instrument={symbol}
                  symbolColor={colors[index]}
                  availableInstruments={instrumentUniverse}
                  showSymbolSelector={layoutSpec > 1}
                  livePrice={prices[symbol]}
                  openTrades={openTrades}
                  tradeHistory={tradeHistory}
                  timeframe={selectedTimeframe}
                  onTradeLineAdjust={onTradeLineAdjust}
                  onInstrumentChange={(nextInstrument) => updatePaneInstrument(index, nextInstrument)}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
