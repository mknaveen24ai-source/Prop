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
    const host = containerRef.current
    if (!host) return

    // Each embed gets its own subtree. TradingView's loader finds its mount
    // point as `document.currentScript.parentNode.querySelector('.tradingview-
    // widget-container__widget')`, so the script and that div must be siblings
    // and both must still be in the document when the script executes.
    const mount = document.createElement('div')
    mount.className = 'tradingview-widget-container'
    mount.style.width = '100%'
    mount.style.height = '100%'

    const widgetDiv = document.createElement('div')
    widgetDiv.className = 'tradingview-widget-container__widget'
    widgetDiv.style.width = '100%'
    widgetDiv.style.height = '100%'
    mount.appendChild(widgetDiv)

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
    mount.appendChild(script)
    host.appendChild(mount)

    // Detaching the subtree while the loader is still in flight leaves it with
    // a null `parentNode` when it finally runs, and it throws "Cannot read
    // properties of null (reading 'querySelector')". React StrictMode's
    // mount/unmount/mount trips this on every dev page load, and a quick
    // symbol switch trips it in production. So teardown hides the old embed
    // immediately (no layout jump, no double chart) but defers the actual
    // removal until the script has executed — `load` fires after execution.
    let settled = false
    const markSettled = () => {
      settled = true
      script.removeEventListener('load', markSettled)
      script.removeEventListener('error', markSettled)
    }
    script.addEventListener('load', markSettled)
    script.addEventListener('error', markSettled)

    return () => {
      if (settled) {
        mount.remove()
        return
      }
      mount.style.display = 'none'
      const remove = () => mount.remove()
      script.addEventListener('load', remove)
      script.addEventListener('error', remove)
    }
  }, [symbol, theme, interval])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}
