import React, { useEffect, useRef } from 'react'
import { getTradingViewSymbol } from '../utils/instruments'

const EMBED_SCRIPT_SRC = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'

// Wraps TradingView's public "Advanced Real-Time Chart" embed widget — the
// free, no-account/no-API-key embed product (an iframe TradingView serves
// itself). It has no live-update API, so a symbol/theme change tears down
// and re-creates the embed rather than patching it in place.
export default function TradingViewWidget({ symbol, theme = 'dark', interval = '5' }) {
  const containerRef = useRef(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.innerHTML = ''

    const widgetDiv = document.createElement('div')
    widgetDiv.className = 'tradingview-widget-container__widget'
    container.appendChild(widgetDiv)

    const script = document.createElement('script')
    script.type = 'text/javascript'
    script.src = EMBED_SCRIPT_SRC
    script.async = true
    script.text = JSON.stringify({
      autosize: true,
      symbol: getTradingViewSymbol(symbol),
      interval,
      timezone: 'Etc/UTC',
      theme,
      style: '1',
      locale: 'en',
      allow_symbol_change: false,
      hide_side_toolbar: false,
      save_image: false,
      support_host: 'https://www.tradingview.com'
    })
    container.appendChild(script)

    return () => {
      container.innerHTML = ''
    }
  }, [symbol, theme, interval])

  return (
    <div className="tradingview-widget-container" ref={containerRef} style={{ width: '100%', height: '100%' }} />
  )
}
