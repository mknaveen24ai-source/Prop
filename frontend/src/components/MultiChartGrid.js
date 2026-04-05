import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createChart, CandlestickSeries, HistogramSeries, LineStyle } from 'lightweight-charts'
import api from '../services/api'

const CHART_TIMEFRAME = '5M'
const CHART_INTERVAL_MINUTES = 5
const SUPPORTED_INSTRUMENTS = ['EURUSD', 'GBPUSD', 'XAUUSD', 'XAGUSD']

function buildSymbolLayout(primaryInstrument, count = 4) {
  const validPrimary = SUPPORTED_INSTRUMENTS.includes(primaryInstrument)
    ? primaryInstrument
    : SUPPORTED_INSTRUMENTS[0]

  // FIX (LOW #32): Only return the number of symbols needed for the layout
  return [
    validPrimary,
    ...SUPPORTED_INSTRUMENTS.filter((symbol) => symbol !== validPrimary)
  ].slice(0, count)
}

function toEpochSeconds(value) {
  if (!value) return null
  const ts = Math.floor(new Date(value).getTime() / 1000)
  return Number.isFinite(ts) ? ts : null
}

function ChartPane({ instrument, symbolColor, openTrades, tradeHistory, prices }) {
  const chartContainerRef = useRef(null)
  const chartRef = useRef(null)
  const candleSeriesRef = useRef(null)
  const volumeSeriesRef = useRef(null)
  const currentCandleRef = useRef(null)
  const candlesLoadedRef = useRef(false)
  const priceLinesRef = useRef([])
  // FIX (MEDIUM #16): Track mounted state to prevent updates after unmount
  const isMountedRef = useRef(true)

  const markerData = useMemo(() => {
    const rows = Array.isArray(tradeHistory) ? tradeHistory : []

    const markers = rows
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

    return markers.slice(-400)
  }, [tradeHistory, instrument])

  const sltpLevels = useMemo(() => {
    const rows = Array.isArray(openTrades) ? openTrades : []

    return rows
      .filter((trade) => trade.status === 'open' && trade.instrument === instrument)
      .flatMap((trade) => {
        const levels = []
        const sl = parseFloat(trade.stop_loss)
        const tp = parseFloat(trade.take_profit)

        if (Number.isFinite(sl)) {
          levels.push({
            id: trade.id,
            kind: 'SL',
            color: '#FF4757',
            price: sl
          })
        }

        if (Number.isFinite(tp)) {
          levels.push({
            id: trade.id,
            kind: 'TP',
            color: '#00C899',
            price: tp
          })
        }

        return levels
      })
  }, [openTrades, instrument])

  useEffect(() => {
    if (!chartContainerRef.current) return

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: 'solid', color: '#090B0E' },
        textColor: '#A3A3A3'
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' }
      },
      crosshair: {
        mode: 1,
        vertLine: { width: 1, color: '#A3A3A3', style: 0 },
        horzLine: { width: 1, color: '#A3A3A3', style: 0 }
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.1)'
      }
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00C899',
      downColor: '#FF4757',
      borderVisible: false,
      wickUpColor: '#00C899',
      wickDownColor: '#FF4757'
    })

    // Pane 1 = volume histogram under candles.
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false
    }, 1)

    if (typeof chart.panes === 'function') {
      const panes = chart.panes()
      if (panes[0] && typeof panes[0].setHeight === 'function') panes[0].setHeight(280)
      if (panes[1] && typeof panes[1].setHeight === 'function') panes[1].setHeight(100)
    }

    chartRef.current = chart
    candleSeriesRef.current = candleSeries
    volumeSeriesRef.current = volumeSeries

    let cancelled = false

    async function loadCandles() {
      try {
        const res = await api.get('/api/trades/candles', {
          params: {
            instrument,
            timeframe: CHART_TIMEFRAME
          }
        })

        if (cancelled) return
        const raw = Array.isArray(res.data) ? res.data : []
        if (!raw.length) {
          candleSeries.setData([])
          volumeSeries.setData([])
          candlesLoadedRef.current = false
          currentCandleRef.current = null
          return
        }

        const seen = new Set()
        const clean = raw
          .filter((candle) => {
            const t = Number(candle.time)
            if (!Number.isFinite(t) || seen.has(t)) return false
            seen.add(t)
            return true
          })
          .map((candle) => ({
            time: Number(candle.time),
            open: parseFloat(candle.open),
            high: parseFloat(candle.high),
            low: parseFloat(candle.low),
            close: parseFloat(candle.close),
            volume: Number.isFinite(Number(candle.volume)) ? Number(candle.volume) : 0
          }))
          .filter((candle) => [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite))
          .sort((a, b) => a.time - b.time)

        candleSeries.setData(clean)
        volumeSeries.setData(
          clean.map((candle) => ({
            time: candle.time,
            value: candle.volume,
            color: candle.close >= candle.open ? 'rgba(0, 200, 153, 0.55)' : 'rgba(255, 71, 87, 0.55)'
          }))
        )

        candlesLoadedRef.current = clean.length > 0
        currentCandleRef.current = clean.length > 0 ? { ...clean[clean.length - 1] } : null
        chart.timeScale().fitContent()
      } catch (err) {
        console.error(`Error fetching chart history for ${instrument}:`, err)
      }
    }

    loadCandles()

    const handleResize = () => {
      if (!chartRef.current || !chartContainerRef.current) return
      chartRef.current.applyOptions({
        width: chartContainerRef.current.clientWidth,
        height: chartContainerRef.current.clientHeight
      })
    }

    window.addEventListener('resize', handleResize)

    return () => {
      cancelled = true
      isMountedRef.current = false // FIX (MEDIUM #16): Mark as unmounted
      window.removeEventListener('resize', handleResize)
      priceLinesRef.current.forEach((line) => {
        try { candleSeries.removePriceLine(line) } catch {}
      })
      priceLinesRef.current = []
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      currentCandleRef.current = null
      candlesLoadedRef.current = false
    }
  }, [instrument])

  useEffect(() => {
    if (!candleSeriesRef.current) return
    try {
      candleSeriesRef.current.setMarkers(markerData)
    } catch {}
  }, [markerData])

  useEffect(() => {
    if (!candleSeriesRef.current) return

    const candleSeries = candleSeriesRef.current

    priceLinesRef.current.forEach((line) => {
      try { candleSeries.removePriceLine(line) } catch {}
    })
    priceLinesRef.current = []

    const dashed = typeof LineStyle !== 'undefined' ? LineStyle.Dashed : 2

    sltpLevels.forEach((level) => {
      const line = candleSeries.createPriceLine({
        price: level.price,
        color: level.color,
        lineWidth: 1,
        lineStyle: dashed,
        axisLabelVisible: true,
        title: `${level.kind} #${level.id}`
      })
      priceLinesRef.current.push(line)
    })
  }, [sltpLevels])

  useEffect(() => {
    // FIX (MEDIUM #16): Check mounted state before updating
    if (!isMountedRef.current || !candlesLoadedRef.current || !candleSeriesRef.current || !volumeSeriesRef.current) return
    if (!prices || !prices[instrument]) return

    const bid = parseFloat(prices[instrument].bid)
    if (!Number.isFinite(bid)) return

    const intervalSeconds = CHART_INTERVAL_MINUTES * 60
    const now = Math.floor(Date.now() / 1000)
    const candleTime = Math.floor(now / intervalSeconds) * intervalSeconds

    if (!currentCandleRef.current || currentCandleRef.current.time !== candleTime) {
      currentCandleRef.current = {
        time: candleTime,
        open: bid,
        high: bid,
        low: bid,
        close: bid,
        volume: 1
      }
    } else {
      currentCandleRef.current = {
        ...currentCandleRef.current,
        high: Math.max(currentCandleRef.current.high, bid),
        low: Math.min(currentCandleRef.current.low, bid),
        close: bid,
        volume: (currentCandleRef.current.volume || 0) + 1
      }
    }

    const live = currentCandleRef.current

    try {
      candleSeriesRef.current.update({
        time: live.time,
        open: live.open,
        high: live.high,
        low: live.low,
        close: live.close
      })
      volumeSeriesRef.current.update({
        time: live.time,
        value: live.volume,
        color: live.close >= live.open ? 'rgba(0, 200, 153, 0.55)' : 'rgba(255, 71, 87, 0.55)'
      })
    } catch {}
  }, [prices, instrument])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <div style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 5,
        color: symbolColor,
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        background: 'rgba(9, 11, 14, 0.8)',
        padding: '4px 8px',
        borderRadius: '4px'
      }}>
        <span style={{ fontWeight: 'bold' }}>{instrument}</span>
        <span style={{ fontSize: '11px', color: '#A3A3A3' }}>{CHART_TIMEFRAME}</span>
      </div>
      <div ref={chartContainerRef} style={{ width: '100%', height: '100%' }} />
    </div>
  )
}

export default function MultiChartGrid({
  selectedInstrument,
  openTrades = [],
  tradeHistory = [],
  prices = {}
}) {
  const [layoutSpec, setLayoutSpec] = useState(1)
  const [symbols, setSymbols] = useState(buildSymbolLayout(selectedInstrument, 1))

  useEffect(() => {
    // FIX (LOW #32): Pass layoutSpec to buildSymbolLayout to avoid computing unused symbols
    setSymbols(buildSymbolLayout(selectedInstrument, layoutSpec))
  }, [selectedInstrument, layoutSpec])

  const gridStyle = {
    display: 'grid',
    gap: '4px',
    width: '100%',
    height: '100%',
    gridTemplateColumns: layoutSpec === 1 ? '1fr' : '1fr 1fr',
    gridTemplateRows: layoutSpec === 4 ? '1fr 1fr' : '1fr'
  }

  const colors = ['#00E5FF', '#FF00A8', '#00FF85', '#FFD400']

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: '#090B0E',
      borderRadius: '8px',
      overflow: 'hidden',
      border: '1px solid var(--navy-border)'
    }}>
      <div style={{ display: 'flex', background: 'rgba(255,255,255,0.02)', padding: '6px 12px', gap: '8px', alignItems: 'center' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Layouts:</div>
        <button onClick={() => setLayoutSpec(1)} style={{ background: layoutSpec === 1 ? 'var(--accent)' : 'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec === 1 ? '#000' : 'var(--text)' }}>1</button>
        <button onClick={() => setLayoutSpec(2)} style={{ background: layoutSpec === 2 ? 'var(--accent)' : 'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec === 2 ? '#000' : 'var(--text)' }}>2</button>
        <button onClick={() => setLayoutSpec(4)} style={{ background: layoutSpec === 4 ? 'var(--accent)' : 'transparent', border: '1px solid var(--navy-border)', borderRadius: '4px', padding: '2px 8px', color: layoutSpec === 4 ? '#000' : 'var(--text)' }}>4</button>
      </div>
      <div style={{ flex: 1, padding: '4px' }}>
        <div style={gridStyle}>
          {Array.from({ length: layoutSpec }).map((_, i) => (
            <div key={i} style={{ border: '1px solid rgba(255,255,255,0.05)', position: 'relative' }}>
              <ChartPane
                instrument={symbols[i]}
                symbolColor={colors[i]}
                openTrades={openTrades}
                tradeHistory={tradeHistory}
                prices={prices}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
