import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, BarSeries } from 'lightweight-charts'
import axios from 'axios'
import { renderIcon } from '../utils/iconMap'
import {
  CHART_TIMEFRAMES,
  DEFAULT_CHART_TIMEFRAME,
  getChartTimeframeMinutes
} from '../utils/chartTimeframes'
import { API_BASE_URL as API_URL } from '../config/apiBase'


function PriceChart({ instrument, prices }) {
  const chartContainerRef = useRef(null)
  const chartRef          = useRef(null)
  const candleSeriesRef   = useRef(null)
  const currentCandleRef  = useRef(null)
  const candlesLoadedRef  = useRef(false)
  const allCandlesRef     = useRef([])
  const tooltipElRef      = useRef(null)
  const pinTooltipToLastRef = useRef(() => {})
  const [selectedTF, setSelectedTF] = useState(DEFAULT_CHART_TIMEFRAME)
  const selectedTFRef               = useRef(DEFAULT_CHART_TIMEFRAME)
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState('')
  const [theme, setTheme]           = useState(
    document.documentElement.getAttribute('data-theme') || 'dark'
  )

  // Watch for theme changes on <html data-theme="...">
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const newTheme = document.documentElement.getAttribute('data-theme') || 'dark'
      setTheme(newTheme)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  // Resolve Ledger Desk tokens at draw time (canvas can't read CSS vars directly).
  function readToken(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return value || fallback
  }

  const chartColors = {
    bg:     readToken('--paper', '#161616'),
    text:   readToken('--muted', '#8a8a82'),
    grid:   readToken('--rule', '#3a3a3a'),
    border: readToken('--rule', '#3a3a3a'),
    up:     readToken('--gain', '#4ade80'),
    down:   readToken('--loss', '#f87171'),
  }

  // Store chartColors in a ref so mount-only useEffect doesn't need it as a dep
  const chartColorsRef = useRef(chartColors)
  chartColorsRef.current = chartColors

  // Initialize chart once on mount
  useEffect(() => {
    if (!chartContainerRef.current) return
    const colors = chartColorsRef.current

    const chart = createChart(chartContainerRef.current, {
      width:  chartContainerRef.current.clientWidth,
      height: 420,
      layout: {
        background: { color: colors.bg },
        textColor:  colors.text,
      },
      grid: {
        vertLines: { color: colors.grid },
        horzLines: { color: colors.grid },
      },
      crosshair: {
        vertLine: { color: colors.text, labelBackgroundColor: colors.text },
        horzLine: { color: colors.text, labelBackgroundColor: colors.text },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor:    colors.border,
        timeVisible:    true,
        secondsVisible: false,
      },
    })

    // Hand-ruled ink ticks (Ledger Desk spec) — stroke-only OHLC bars, not
    // filled candlesticks: a vertical stem with a left open-tick and a right
    // close-tick.
    const candleSeries = chart.addSeries(BarSeries, {
      upColor:   colors.up,
      downColor: colors.down,
      openVisible: true,
      thinBars: true,
    })

    chartRef.current        = chart
    candleSeriesRef.current = candleSeries

    // Chart contract (v2 "Modern Gazette" handoff spec): crosshair + dot +
    // tooltip anchored to the point, and it never blanks — with no hover it
    // pins to the last candle instead of disappearing.
    function renderTooltipAt(candle, prevCandle) {
      const el = tooltipElRef.current
      const series = candleSeriesRef.current
      const c = chartRef.current
      const container = chartContainerRef.current
      if (!el || !series || !c || !container || !candle) return
      const x = c.timeScale().timeToCoordinate(candle.time)
      const y = series.priceToCoordinate(candle.close)
      if (x == null || y == null) { el.style.display = 'none'; return }

      const delta = prevCandle ? candle.close - prevCandle.close : 0
      const deltaPct = prevCandle && prevCandle.close ? (delta / prevCandle.close) * 100 : 0
      const up = delta >= 0
      const tone = up ? chartColorsRef.current.up : chartColorsRef.current.down
      const sign = up ? '+' : ''

      el.innerHTML =
        '<div style="font-family:var(--font-mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">' +
          (instrument || '') +
        '</div>' +
        '<div style="font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:15px;color:var(--ink);margin-top:2px">' +
          candle.close.toFixed(5) +
        '</div>' +
        '<div style="font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:11px;color:' + tone + ';margin-top:2px">' +
          sign + delta.toFixed(5) + ' (' + sign + deltaPct.toFixed(2) + '%)' +
        '</div>'

      const width = container.clientWidth
      const left = Math.min(Math.max(x + 12, 4), width - 150)
      el.style.left = left + 'px'
      el.style.top = Math.max(y - 46, 4) + 'px'
      el.style.display = 'block'
    }

    function pinTooltipToLast() {
      const candles = allCandlesRef.current
      if (!candles.length) {
        if (tooltipElRef.current) tooltipElRef.current.style.display = 'none'
        return
      }
      renderTooltipAt(candles[candles.length - 1], candles[candles.length - 2])
    }
    pinTooltipToLastRef.current = pinTooltipToLast

    chart.subscribeCrosshairMove((param) => {
      const candles = allCandlesRef.current
      if (!candles.length) return
      if (!param || param.time == null || !param.point) {
        pinTooltipToLast()
        return
      }
      const idx = candles.findIndex((cd) => cd.time === param.time)
      if (idx === -1) { pinTooltipToLast(); return }
      renderTooltipAt(candles[idx], candles[idx - 1])
    })

    const resizeObserver = new ResizeObserver(() => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth })
      }
    })
    resizeObserver.observe(chartContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current        = null
      candleSeriesRef.current = null
    }
  }, []) // mount only

  // Update chart colors when theme changes
  useEffect(() => {
    if (!chartRef.current) return
    const colors = chartColorsRef.current
    chartRef.current.applyOptions({
      layout:          { background: { color: colors.bg }, textColor: colors.text },
      grid:            { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale:       { borderColor: colors.border },
      crosshair: {
        vertLine: { color: colors.text, labelBackgroundColor: colors.text },
        horzLine: { color: colors.text, labelBackgroundColor: colors.text },
      },
    })
    candleSeriesRef.current?.applyOptions({
      upColor: colors.up,
      downColor: colors.down,
    })
  }, [theme])

  const loadCandles = useCallback(async () => {
    if (!candleSeriesRef.current || !instrument) return

    setLoading(true)
    setError('')

    try {
      const res = await axios.get(`${API_URL}/api/trades/candles`, {
        params: { instrument, timeframe: selectedTFRef.current }
      })

      const candles = res.data
      if (!Array.isArray(candles) || candles.length === 0) {
        setError('No candle data available')
        setLoading(false)
        return
      }

      // Deduplicate and sort by time (required by lightweight-charts)
      const seen = new Set()
      const clean = candles
        .filter(c => {
          if (seen.has(c.time)) return false
          seen.add(c.time)
          return true
        })
        .sort((a, b) => a.time - b.time)

      candleSeriesRef.current.setData(clean)
      candlesLoadedRef.current = true
      allCandlesRef.current    = clean

      const last = clean[clean.length - 1]
      if (last) currentCandleRef.current = { ...last }

      // fitContent() scales the visible range to show all loaded candles.
      // scrollToPosition alone only pans — it doesn't zoom to fit.
      chartRef.current?.timeScale().fitContent()
      pinTooltipToLastRef.current()

    } catch (err) {
      console.error('PriceChart: failed to load candles', err.message)
      setError('Could not load chart data')
    } finally {
      setLoading(false)
    }
  }, [instrument])

  // Reload candles when instrument or timeframe changes
  useEffect(() => {
    selectedTFRef.current    = selectedTF
    candlesLoadedRef.current = false
    currentCandleRef.current = null
    loadCandles()
  }, [instrument, selectedTF, loadCandles])

  // Update the live candle on every price tick from the websocket
  useEffect(() => {
    if (!prices || !prices[instrument] || !candleSeriesRef.current) return
    if (!candlesLoadedRef.current) return

    const bid = parseFloat(prices[instrument].bid)
    if (isNaN(bid)) return

    // FIX: guard against an undefined timeframe mapping (for example after a
    // hot-reload in development) so live candle updates do not crash.
    const intervalMinutes = getChartTimeframeMinutes(selectedTFRef.current)
    if (!intervalMinutes) return

    const intervalSeconds = intervalMinutes * 60
    const now             = Math.floor(Date.now() / 1000)
    const candleTime      = Math.floor(now / intervalSeconds) * intervalSeconds

    if (!currentCandleRef.current || currentCandleRef.current.time !== candleTime) {
      currentCandleRef.current = { time: candleTime, open: bid, high: bid, low: bid, close: bid }
    } else {
      currentCandleRef.current = {
        ...currentCandleRef.current,
        high:  Math.max(currentCandleRef.current.high, bid),
        low:   Math.min(currentCandleRef.current.low,  bid),
        close: bid,
      }
    }

    try { candleSeriesRef.current.update(currentCandleRef.current) } catch (e) {}

    const list = allCandlesRef.current
    if (list.length && list[list.length - 1].time === currentCandleRef.current.time) {
      list[list.length - 1] = currentCandleRef.current
    } else {
      list.push(currentCandleRef.current)
    }
    pinTooltipToLastRef.current()
  }, [prices, instrument])

  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Timeframe selector */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' }}>
        {CHART_TIMEFRAMES.map(tf => (
          <button
            key={tf.label}
            onClick={() => setSelectedTF(tf.label)}
            style={{
              padding:      '4px 10px',
              fontSize:     '12px',
              fontWeight:   selectedTF === tf.label ? '700' : '400',
              background:   selectedTF === tf.label ? 'color-mix(in srgb, var(--muted) 15%, transparent)' : 'transparent',
              border:       selectedTF === tf.label ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
              color:        selectedTF === tf.label ? 'var(--accent)' : 'var(--text-muted)',
              cursor:       'pointer',
              transition:   'all 0.15s',
            }}
          >
            {tf.label}
          </button>
        ))}
        {loading && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>
            Loading...
          </span>
        )}
        {error && (
          <span style={{ fontSize: '11px', color: 'var(--red)', marginLeft: '8px', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            {renderIcon('warning', { size: 12, color: 'var(--accent-red)' })}
            <span>{error}</span>
          </span>
        )}
      </div>

      {/* Chart container */}
      <div style={{ position: 'relative' }}>
        <div
          ref={chartContainerRef}
          style={{
            width:        '100%',
            height:       '420px',
            overflow:     'hidden',
            border:       '1px solid var(--navy-border)',
          }}
        />
        {/* Sticky tooltip (chart contract, v2 "Modern Gazette" spec): anchored
            to the crosshair point, pinned to the last candle when not hovered.
            Content is written imperatively in the crosshair-move handler above
            to avoid a React re-render on every mouse move. */}
        <div
          ref={tooltipElRef}
          style={{
            position:       'absolute',
            display:        'none',
            pointerEvents:  'none',
            zIndex:         2,
            padding:        '8px 10px',
            background:     'var(--glass)',
            backdropFilter: 'blur(16px) saturate(140%)',
            WebkitBackdropFilter: 'blur(16px) saturate(140%)',
            border:         '1px solid var(--rule)',
            borderRadius:   'var(--radius-sm)',
            boxShadow:      'var(--elev)',
            whiteSpace:     'nowrap',
          }}
        />
      </div>
    </div>
  )
}

export default PriceChart
