import React, { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, CandlestickSeries } from 'lightweight-charts'
import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

const TIMEFRAMES = [
  { label: '1M',  minutes: 1 },
  { label: '5M',  minutes: 5 },
  { label: '15M', minutes: 15 },
  { label: '1H',  minutes: 60 },
  { label: '4H',  minutes: 240 },
  { label: '1D',  minutes: 1440 }
]

function PriceChart({ instrument, prices }) {
  const chartContainerRef = useRef(null)
  const chartRef          = useRef(null)
  const candleSeriesRef   = useRef(null)
  const currentCandleRef  = useRef(null)
  const candlesLoadedRef  = useRef(false)
  const [selectedTF, setSelectedTF] = useState('5M')
  const selectedTFRef               = useRef('5M')
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

  const isDark = theme !== 'light'
  const chartColors = {
    bg:     isDark ? '#0b0b0b' : '#ffffff',
    text:   isDark ? '#ffffff' : '#111111',
    grid:   isDark ? '#1f1f1f' : '#e5e5e5',
    border: isDark ? '#1f1f1f' : '#e5e5e5',
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
        vertLine: { color: '#d4af37', labelBackgroundColor: '#d4af37' },
        horzLine: { color: '#d4af37', labelBackgroundColor: '#d4af37' },
      },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor:    colors.border,
        timeVisible:    true,
        secondsVisible: false,
      },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor:         '#2ecc71',
      downColor:       '#e74c3c',
      borderUpColor:   '#2ecc71',
      borderDownColor: '#e74c3c',
      wickUpColor:     '#2ecc71',
      wickDownColor:   '#e74c3c',
    })

    chartRef.current        = chart
    candleSeriesRef.current = candleSeries

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

      const last = clean[clean.length - 1]
      if (last) currentCandleRef.current = { ...last }

      // fitContent() scales the visible range to show all loaded candles.
      // scrollToPosition alone only pans — it doesn't zoom to fit.
      chartRef.current?.timeScale().fitContent()

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

    // FIX: guard against undefined timeframe — TIMEFRAMES.find can return
    // undefined if selectedTFRef.current somehow contains an unrecognised value
    // (e.g. after a hot-reload in dev). Without the guard, .minutes throws a
    // TypeError that silently kills the price update effect for the session.
    const tf = TIMEFRAMES.find(t => t.label === selectedTFRef.current)
    if (!tf) return

    const intervalSeconds = tf.minutes * 60
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
  }, [prices, instrument])

  return (
    <div style={{ marginBottom: '20px' }}>
      {/* Timeframe selector */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', alignItems: 'center' }}>
        {TIMEFRAMES.map(tf => (
          <button
            key={tf.label}
            onClick={() => setSelectedTF(tf.label)}
            style={{
              padding:      '4px 10px',
              fontSize:     '12px',
              fontWeight:   selectedTF === tf.label ? '700' : '400',
              background:   selectedTF === tf.label ? 'rgba(148, 148, 148, 0.15)' : 'transparent',
              border:       selectedTF === tf.label ? '1px solid var(--accent)' : '1px solid var(--navy-border)',
              borderRadius: '4px',
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
          <span style={{ fontSize: '11px', color: 'var(--red)', marginLeft: '8px' }}>
            ⚠ {error}
          </span>
        )}
      </div>

      {/* Chart container */}
      <div
        ref={chartContainerRef}
        style={{
          width:        '100%',
          height:       '420px',
          borderRadius: '8px',
          overflow:     'hidden',
          border:       '1px solid var(--navy-border)',
        }}
      />
    </div>
  )
}

export default PriceChart